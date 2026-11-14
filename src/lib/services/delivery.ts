import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { User } from "@/lib/domain/types";
import { accessibleSiteIds, assertActive, assertAdmin, isCustomer } from "@/lib/auth/authz";
import { getDb, schema } from "@/lib/db/client";
import { listUsers } from "@/lib/db/repo";
import { deliver, type Message } from "@/lib/notify/notifier";
import { hasActiveDevice } from "@/lib/notify/push";
import { normalizePhone, solapiConfig } from "@/lib/notify/solapi";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/util/errors";
import { newId } from "@/lib/util/random";
import { formatTime, nowIso } from "@/lib/util/time";
import { AgentClient, AgentCommander, AgentError, agentMode, httpTransport, isAgentNotify, type AgentNotify, type DeliveryTrayDestination } from "@/lib/delivery/agent";
import { agentMockTransport, MOCK_DEVICE_ID } from "@/lib/delivery/mock";
import { audit } from "./audit";

/**
 * 배송로봇 도착 알림(docs/23). 조회 전용: 배송 지시는 로봇 화면에서 하고, 우리는 에이전트 알림으로 도착을 감지해 목적지별 직원에게 알린다.
 * 청소 로봇 테이블·집계·보고서와 섞지 않는다(별도 테이블 delivery_*).
 */

export function createAgentClient(): AgentClient {
  const mode = agentMode();
  if (mode === "mock") return new AgentClient(agentMockTransport, MOCK_DEVICE_ID);
  if (mode === "live") return new AgentClient(httpTransport(process.env.PUDU_AGENT_URL!), process.env.PUDU_AGENT_DEVICE_ID!);
  throw new ValidationError("배송로봇 에이전트 연동이 꺼져 있습니다(PUDU_AGENT_MODE·PUDU_AGENT_URL·PUDU_AGENT_DEVICE_ID).");
}

/** 도착 후 이 시간(분) 안에 완료가 없으면 한 번 더 알린다. 0 이면 재알림 안 함. */
export function remindMinutes(): number {
  const n = Number(process.env.PUDU_AGENT_REMIND_MINUTES ?? 3);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

// ---------------------------------------------------------------- 수신(라우트)

/** 알림 원문 저장(빠르게). msgId 가 없으면 유형·로봇·시각으로 만든다. */
export async function ingestAgentNotify(body: unknown): Promise<{ stored: boolean; duplicate: boolean }> {
  if (!isAgentNotify(body)) return { stored: false, duplicate: false };
  const msgId = body.msgId || `${body.msgType}:${body.robotId ?? ""}:${body.timestamp ?? ""}:${JSON.stringify(body.data ?? {}).length}`;
  const res = await getDb()
    .insert(schema.deliveryEvents)
    .values({ id: newId("dev"), msgId, msgType: body.msgType, agentRobotId: body.robotId ?? null, receivedAt: nowIso(), occurredAt: typeof body.timestamp === "number" ? new Date(body.timestamp).toISOString() : null, payload: body })
    .onConflictDoNothing({ target: schema.deliveryEvents.msgId })
    .returning({ id: schema.deliveryEvents.id });
  return res.length ? { stored: true, duplicate: false } : { stored: false, duplicate: true };
}

// ---------------------------------------------------------------- 동기화(워커)

export interface DeliverySyncResult {
  job: string;
  ok: boolean;
  detail: string;
}

async function robotByAgentId(agentRobotId: string) {
  return getDb().query.deliveryRobots.findFirst({ where: eq(schema.deliveryRobots.agentRobotId, agentRobotId) });
}

async function ensureRobot(agentRobotId: string, patch: { name?: string; shopName?: string; groupId?: string; deviceId?: string }) {
  const db = getDb();
  const existing = await robotByAgentId(agentRobotId);
  if (existing) {
    const set: Record<string, unknown> = {};
    if (patch.name && patch.name !== existing.name) set.name = patch.name;
    if (patch.shopName && patch.shopName !== existing.shopName) set.shopName = patch.shopName;
    if (patch.groupId && patch.groupId !== existing.groupId) set.groupId = patch.groupId;
    if (patch.deviceId && patch.deviceId !== existing.deviceId) set.deviceId = patch.deviceId;
    if (Object.keys(set).length) await db.update(schema.deliveryRobots).set(set).where(eq(schema.deliveryRobots.id, existing.id));
    return { ...existing, ...set };
  }
  const row = { id: `DR-${agentRobotId}`, agentRobotId, groupId: patch.groupId ?? "", deviceId: patch.deviceId ?? "", siteId: null, name: patch.name || agentRobotId, shopName: patch.shopName ?? "", active: true, lastState: null, lastSeenAt: null, destinations: [], createdAt: nowIso() };
  await db.insert(schema.deliveryRobots).values(row).onConflictDoNothing();
  return row;
}

/** 로봇 그룹·로봇·목적지 목록(10분). 새 로봇은 사업장 미지정으로 등록된다. */
export async function syncDeliveryCatalog(client: AgentClient = createAgentClient()): Promise<DeliverySyncResult> {
  try {
    const groups = await client.groups();
    let robots = 0;
    let destinations = 0;
    for (const g of groups) {
      for (const r of await client.robots(g.id)) {
        const row = await ensureRobot(r.id, { name: r.name, shopName: r.shop_name ?? g.shop_name ?? "", groupId: g.id, deviceId: client.deviceId });
        robots += 1;
        try {
          const dests = await client.destinations(r.id);
          if (dests.length) {
            await getDb().update(schema.deliveryRobots).set({ destinations: dests }).where(eq(schema.deliveryRobots.id, row.id));
            destinations += dests.length;
          }
        } catch {
          /* 오프라인 로봇은 목적지 조회가 실패할 수 있다 — 지난 목록 유지 */
        }
      }
    }
    return { job: "catalog", ok: true, detail: `그룹 ${groups.length} · 로봇 ${robots} · 목적지 ${destinations}` };
  } catch (e) {
    return { job: "catalog", ok: false, detail: (e as Error).message };
  }
}

/** 로봇 상태(FREE/BUSY·이동·배터리) 폴링(1분). 응답이 없는 로봇은 마지막 상태를 둔다(화면에 마지막 수신 시각). */
export async function syncDeliveryState(client: AgentClient = createAgentClient()): Promise<DeliverySyncResult> {
  try {
    const db = getDb();
    const robots = await db.select().from(schema.deliveryRobots).where(eq(schema.deliveryRobots.active, true));
    const groups = Array.from(new Set(robots.map((r) => r.groupId).filter(Boolean)));
    let updated = 0;
    for (const g of groups) {
      for (const s of await client.groupState(g)) {
        const r = robots.find((x) => x.agentRobotId === s.robotId);
        if (!r) continue;
        await db.update(schema.deliveryRobots).set({ lastState: { ...(r.lastState ?? {}), ...s }, lastSeenAt: nowIso() }).where(eq(schema.deliveryRobots.id, r.id));
        updated += 1;
      }
    }
    return { job: "state", ok: true, detail: `로봇 ${robots.length}대 중 응답 ${updated}` };
  } catch (e) {
    return { job: "state", ok: false, detail: (e as Error).message };
  }
}

const NEXT: Record<string, number> = { Await: 0, OnTheWay: 1, Arrived: 2, Complete: 3, Cancel: 3 };
function normStatus(s: string | undefined): "Await" | "OnTheWay" | "Arrived" | "Complete" | "Cancel" | null {
  const v = String(s ?? "").toLowerCase();
  if (v === "await") return "Await";
  if (v === "ontheway") return "OnTheWay";
  if (v === "arrived" || v === "arrive") return "Arrived";
  if (v === "complete" || v === "completed") return "Complete";
  if (v === "cancel" || v === "canceled" || v === "cancelled") return "Cancel";
  return null;
}

/** 알림 처리(3초). 배송 임무 알림 → 구간 갱신·도착 알림, 상태류 알림 → 로봇 상태. */
export async function processDeliveryEvents(limit = 100): Promise<DeliverySyncResult & { counts: { events: number; done: number; errors: number } }> {
  const db = getDb();
  const events = await db.select().from(schema.deliveryEvents).where(isNull(schema.deliveryEvents.processedAt)).orderBy(schema.deliveryEvents.receivedAt).limit(limit);
  let done = 0;
  let errors = 0;
  for (const ev of events) {
    try {
      await applyAgentNotify(ev.payload as AgentNotify, ev.occurredAt ?? ev.receivedAt);
      await db.update(schema.deliveryEvents).set({ processedAt: nowIso(), processError: null }).where(eq(schema.deliveryEvents.id, ev.id));
      done += 1;
    } catch (e) {
      errors += 1;
      await db.update(schema.deliveryEvents).set({ processedAt: nowIso(), processError: (e as Error).message }).where(eq(schema.deliveryEvents.id, ev.id));
    }
  }
  return { job: "events", ok: errors === 0, detail: `알림 ${events.length}건 중 처리 ${done}, 오류 ${errors}`, counts: { events: events.length, done, errors } };
}

async function applyAgentNotify(n: AgentNotify, occurredAt: string): Promise<void> {
  if (!n.robotId) return;
  const db = getDb();
  const robot = await ensureRobot(n.robotId, { groupId: n.groupId, deviceId: n.deviceId });
  const d = n.data ?? {};
  if (n.msgType === "notifyDeliveryTask") {
    const trays = (d.trays as { destinations?: DeliveryTrayDestination[] }[] | undefined) ?? [];
    for (let i = 0; i < trays.length; i++) {
      for (const dest of trays[i]?.destinations ?? []) await applyLeg(robot, i, dest, String(d.deliveryMode ?? ""), occurredAt);
    }
    return;
  }
  // 상태류: 이동 상태·배터리·자세·상태 조회 응답 → 마지막 상태에 합친다(역순 방지)
  const prev = (robot.lastState ?? {}) as Record<string, unknown>;
  if (typeof prev._at === "string" && prev._at > occurredAt) return;
  const patch: Record<string, unknown> = { _at: occurredAt };
  if (n.msgType === "notifyRobotMoveState") {
    const st = String(d.state ?? "");
    Object.assign(patch, { moveState: st, errors: d.errors ?? [] });
    // 막힘: 시작 시각만 기록(알림은 checkStuckRobots 가 stuckMinutes 뒤에). 다른 상태가 오면 해제.
    if (st === "Stuck") Object.assign(patch, prev.moveState === "Stuck" && prev.stuckSince ? {} : { stuckSince: occurredAt, stuckNotified: false });
    else Object.assign(patch, { stuckSince: null, stuckNotified: false });
    // 운행 오류: 이 오류 상황에서 처음일 때 바로 알림
    if (st === "Error" && prev.moveState !== "Error") {
      const errs = ((d.errors as { errorType?: string; detail?: string }[] | undefined) ?? []).map((e) => [e.errorType, e.detail].filter(Boolean).join(": ")).join(", ");
      patch.problemResult = await notifyRobotProblem(robot as { id: string; name: string; siteId: string | null }, "ERROR", occurredAt, errs);
    }
  }
  else if (n.msgType === "notifyRobotPower") Object.assign(patch, { robotPower: d.power ?? d.robotPower, chargeStage: d.chargeStage ?? d.charge_stage });
  else if (n.msgType === "notifyRobotPose") Object.assign(patch, { robotPose: d });
  else if (n.msgType === "notifyRobotStatus") Object.assign(patch, d);
  else return;
  await db.update(schema.deliveryRobots).set({ lastState: { ...prev, ...patch }, lastSeenAt: nowIso() }).where(eq(schema.deliveryRobots.id, robot.id));
}

async function applyLeg(robot: { id: string; siteId: string | null; name: string }, trayIndex: number, dest: DeliveryTrayDestination, mode: string, occurredAt: string): Promise<void> {
  const db = getDb();
  const status = normStatus(dest.status);
  if (!status || !dest.destination) return;
  const since = new Date(new Date(occurredAt).getTime() - 12 * 3600_000).toISOString();
  const legs = await db
    .select()
    .from(schema.deliveryLegs)
    .where(and(eq(schema.deliveryLegs.robotId, robot.id), eq(schema.deliveryLegs.destination, dest.destination), eq(schema.deliveryLegs.trayIndex, trayIndex), gte(schema.deliveryLegs.lastEventAt, since)))
    .orderBy(desc(schema.deliveryLegs.firstSeenAt));
  let leg = legs.find((l) => l.status !== "Complete" && l.status !== "Cancel" && (!dest.id || !l.taskRef || l.taskRef === dest.id));
  const terminal = status === "Complete" || status === "Cancel";
  if (!leg) {
    // 끝난 구간의 같은 알림이 다시 오면(재전송·전체 트레이 재통보) 새로 만들지 않는다
    const closed = legs.find((l) => l.status === status && Math.abs(new Date(l.lastEventAt).getTime() - new Date(occurredAt).getTime()) <= 30 * 60_000);
    if (terminal && closed) return;
    const row = { id: newId("dlg"), robotId: robot.id, siteId: robot.siteId, destination: dest.destination, trayIndex, taskRef: dest.id || null, mode, source: dest.type ?? "", status, firstSeenAt: occurredAt, lastEventAt: occurredAt };
    await db.insert(schema.deliveryLegs).values(row);
    leg = (await db.query.deliveryLegs.findFirst({ where: eq(schema.deliveryLegs.id, row.id) }))!;
  } else if (occurredAt < leg.lastEventAt) {
    return; // 늦게 온 옛 알림
  }
  const set: Partial<typeof schema.deliveryLegs.$inferInsert> = { lastEventAt: occurredAt };
  if (NEXT[status] >= NEXT[leg.status]) set.status = status;
  if (status === "OnTheWay" && !leg.onTheWayAt) set.onTheWayAt = occurredAt;
  if (status === "Arrived" && !leg.arrivedAt) set.arrivedAt = occurredAt;
  if (status === "Complete" && !leg.completedAt) set.completedAt = occurredAt;
  if (status === "Cancel" && !leg.cancelledAt) set.cancelledAt = occurredAt;
  if (dest.completeType) set.completeType = dest.completeType;
  if (typeof dest.estimatedTime === "number") set.estimatedMs = Math.round(dest.estimatedTime);
  if (typeof dest.spendTime === "number") set.spendMs = Math.round(dest.spendTime);
  if (dest.id && !leg.taskRef) set.taskRef = dest.id;
  if (dest.type && !leg.source) set.source = dest.type;
  if (!leg.siteId && robot.siteId) set.siteId = robot.siteId;
  await db.update(schema.deliveryLegs).set(set).where(eq(schema.deliveryLegs.id, leg.id));
  const newlyArrived = status === "Arrived" && !leg.arrivedAt && !leg.notifiedAt && !leg.completedAt && !leg.cancelledAt;
  if (newlyArrived) await notifyArrival(leg.id, false);
  if (status === "Cancel" && !leg.cancelledAt && !leg.completedAt) await notifyCancel(leg.id);
}

// ---------------------------------------------------------------- 알림

const CH_KO = { PUSH: "앱 푸시", EMAIL: "메일", KAKAO: "카카오톡" } as const;
type Ch = "PUSH" | "EMAIL" | "KAKAO";
const DEFAULT_CHANNELS: Ch[] = ["PUSH", "EMAIL"];

async function recipientsFor(siteId: string | null, destination: string) {
  if (!siteId) return null;
  const db = getDb();
  const rows = await db.select().from(schema.deliveryRecipients).where(and(eq(schema.deliveryRecipients.siteId, siteId), inArray(schema.deliveryRecipients.destination, [destination, "*"]), eq(schema.deliveryRecipients.enabled, true)));
  return rows.find((r) => r.destination === destination) ?? rows.find((r) => r.destination === "*") ?? null;
}

/** 이 구간의 수신자: Wide Bot 에서 지시하면서 지정한 사람 → 목적지 수신자 → 사업장 기본 수신자('*'). */
async function legRecipients(leg: { siteId: string | null; destination: string; taskRef: string | null }): Promise<{ userIds: string[]; channels: Ch[] } | null> {
  const rec = await recipientsFor(leg.siteId, leg.destination);
  if (leg.taskRef) {
    const order = (await getDb().select().from(schema.deliveryOrders).where(sql`${schema.deliveryOrders.trays} @> ${JSON.stringify([{ taskRef: leg.taskRef }])}::jsonb`))[0];
    const t = order?.trays.find((x) => x.taskRef === leg.taskRef);
    if (t?.recipientUserIds?.length) return { userIds: t.recipientUserIds, channels: (rec?.channels as Ch[] | undefined) ?? DEFAULT_CHANNELS };
  }
  return rec && rec.userIds.length ? { userIds: rec.userIds, channels: rec.channels as Ch[] } : null;
}

/** 직원들에게 보내고 알림 기록(kind DELIVERY)을 남긴다. 반환: 요약(보낸 것이 없으면 sent=false). */
async function sendToUsers(userIds: string[], channels: Ch[], m: Message, refId: string): Promise<{ sent: boolean; summary: string }> {
  const db = getDb();
  const now = nowIso();
  const users = (await listUsers(db)).filter((u) => u.active && userIds.includes(u.id));
  const results: string[] = [];
  for (const u of users) {
    for (const ch of channels) {
      if (ch === "PUSH" && !(await hasActiveDevice(u.id))) continue; // 앱을 쓰지 않는 직원
      // 카카오: 휴대폰 번호가 있고 솔라피가 설정돼 있으면 알림톡, 아니면 본인이 연결한 「나에게 보내기」
      const phone = ch === "KAKAO" && solapiConfig() ? normalizePhone(u.phone) : null;
      const address = ch === "EMAIL" ? u.email : phone ?? `user:${u.id}`;
      const r = await deliver({ channel: ch, address }, m);
      await db.insert(schema.notificationLogs).values({ id: newId("ntf"), incidentId: null, at: now, channel: ch, recipient: ch === "EMAIL" ? u.email : u.name, status: r.status, reason: r.reason, kind: "DELIVERY", refId });
      results.push(`${u.name} ${phone ? "알림톡" : CH_KO[ch]} ${r.status === "SENT" ? "발송" : r.status === "MOCK_SENT" ? "모의 발송" : "실패"}`);
    }
  }
  return results.length ? { sent: true, summary: results.join(", ") } : { sent: false, summary: "보낼 채널 없음(앱 미설치·채널 미선택)" };
}

function baseUrl(): string {
  return (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

/** 도착 알림(또는 재알림 — 수령 알림만 재알림한다). 결과는 notification_logs(kind DELIVERY)와 구간의 notifyResult. */
export async function notifyArrival(legId: string, reminder: boolean): Promise<string> {
  const db = getDb();
  const leg = await db.query.deliveryLegs.findFirst({ where: eq(schema.deliveryLegs.id, legId) });
  if (!leg) return "구간 없음";
  const robot = await db.query.deliveryRobots.findFirst({ where: eq(schema.deliveryRobots.id, leg.robotId) });
  const site = leg.siteId ? await db.query.sites.findFirst({ where: eq(schema.sites.id, leg.siteId) }) : undefined;
  const now = nowIso();
  const rec = await legRecipients(leg);
  let summary: string;
  let sent = false;
  if (!leg.siteId) summary = "사업장 미지정 — 배송 화면에서 로봇의 사업장을 지정하세요";
  else if (!rec) summary = `수신자 없음 — 배송 화면에서 '${leg.destination}' 수신자를 지정하세요`;
  else {
    const tz = site?.timezone ?? "Asia/Seoul";
    const m: Message = {
      subject: `[Wide Bot] ${reminder ? "배송 수령 재알림" : "배송 도착"} — ${leg.destination}`,
      title: reminder ? `아직 수령하지 않은 배송이 있습니다 — ${leg.destination}` : `배송로봇이 ${leg.destination}에 도착했습니다`,
      lines: [`로봇: ${robot?.name ?? leg.robotId}`, `도착: ${formatTime(leg.arrivedAt ?? now, tz)}`, "수령 후 로봇 화면에서 확인(완료)을 눌러 주세요."],
      url: `${baseUrl()}/delivery`,
      meta: { kind: "DELIVERY", refId: leg.id, siteId: leg.siteId },
      alimtalk: { template: reminder ? "DELIVERY_REMIND" : "DELIVERY_ARRIVED", variables: { "#{목적지}": leg.destination, "#{로봇}": robot?.name ?? leg.robotId, "#{시각}": formatTime(leg.arrivedAt ?? now, tz) } },
    };
    ({ sent, summary } = await sendToUsers(rec.userIds, rec.channels, m, leg.id));
  }
  // 실제로 보낸 경우만 notifiedAt 을 채운다(받는 사람이 없던 도착은 재알림 대상이 아니다)
  await db
    .update(schema.deliveryLegs)
    .set(reminder ? { remindedAt: now, notifyResult: `${leg.notifyResult ?? ""} / 재알림: ${summary}` } : sent ? { notifiedAt: now, notifyResult: summary } : { notifyResult: summary })
    .where(eq(schema.deliveryLegs.id, leg.id));
  return summary;
}

/** 배송 취소 알림(재알림 없음): 그 배송을 기다리던 수신자에게. */
async function notifyCancel(legId: string): Promise<void> {
  const db = getDb();
  const leg = await db.query.deliveryLegs.findFirst({ where: eq(schema.deliveryLegs.id, legId) });
  if (!leg?.siteId) return;
  const rec = await legRecipients(leg);
  if (!rec) return;
  const robot = await db.query.deliveryRobots.findFirst({ where: eq(schema.deliveryRobots.id, leg.robotId) });
  const r = await sendToUsers(rec.userIds, rec.channels, { subject: `[Wide Bot] 배송 취소 — ${leg.destination}`, title: `${leg.destination} 배송이 취소되었습니다`, lines: [`로봇: ${robot?.name ?? leg.robotId}`, "보낸 사람에게 확인해 주세요."], url: `${baseUrl()}/delivery`, meta: { kind: "DELIVERY", refId: `${leg.id}:cancel`, siteId: leg.siteId }, alimtalk: { template: "DELIVERY_CANCEL", variables: { "#{목적지}": leg.destination, "#{로봇}": robot?.name ?? leg.robotId } } }, `${leg.id}:cancel`);
  await db.update(schema.deliveryLegs).set({ notifyResult: `${leg.notifyResult ? `${leg.notifyResult} / ` : ""}취소 알림: ${r.summary}` }).where(eq(schema.deliveryLegs.id, leg.id));
}

/** 로봇 이상(막힘·운행 오류) 알림: 사업장 기본 수신자('*')에게. 같은 이상 상황에는 한 번. */
async function notifyRobotProblem(robot: { id: string; name: string; siteId: string | null }, kind: "STUCK" | "ERROR", since: string, detail: string): Promise<string> {
  if (!robot.siteId) return "사업장 미지정";
  const rec = await recipientsFor(robot.siteId, "*");
  if (!rec || !rec.userIds.length) return "기본 수신자(*) 없음";
  const label = kind === "STUCK" ? "막힘(장애물)" : "운행 오류";
  const r = await sendToUsers(rec.userIds, rec.channels as Ch[], { subject: `[Wide Bot] 배송로봇 ${label} — ${robot.name}`, title: `배송로봇 ${robot.name}: ${label}`, lines: [kind === "STUCK" ? `${stuckMinutes()}분 넘게 장애물에 막혀 있습니다.` : "운행 중 이상으로 멈췄습니다.", ...(detail ? [`내용: ${detail}`] : []), "현장 확인이 필요합니다."], url: `${baseUrl()}/delivery`, meta: { kind: "DELIVERY", refId: `robot:${robot.id}:${kind}:${since}`, siteId: robot.siteId }, alimtalk: { template: "DELIVERY_PROBLEM", variables: { "#{로봇}": robot.name, "#{내용}": kind === "STUCK" ? `${stuckMinutes()}분 넘게 장애물에 막힘` : `운행 오류${detail ? `(${detail})` : ""}`, "#{시각}": formatTime(since) } } }, `robot:${robot.id}:${kind}:${since}`);
  return r.summary;
}

/** 막힘이 이 시간(분) 넘게 이어지면 알린다(잠깐 장애물을 피하는 것은 알리지 않음). */
export function stuckMinutes(): number {
  const n = Number(process.env.PUDU_AGENT_STUCK_MINUTES ?? 2);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

/** 막힘 확인(30초): 이동 상태가 Stuck 인 채로 stuckMinutes 가 지나면 한 번 알린다. */
export async function checkStuckRobots(now: string = nowIso()): Promise<number> {
  const db = getDb();
  const robots = await db.select().from(schema.deliveryRobots).where(eq(schema.deliveryRobots.active, true));
  let n = 0;
  for (const r of robots) {
    const s = (r.lastState ?? {}) as Record<string, unknown>;
    if (s.moveState !== "Stuck" || typeof s.stuckSince !== "string" || s.stuckNotified) continue;
    if (new Date(now).getTime() - new Date(s.stuckSince).getTime() < stuckMinutes() * 60_000) continue;
    const res = await notifyRobotProblem(r, "STUCK", s.stuckSince, "");
    await db.update(schema.deliveryRobots).set({ lastState: { ...s, stuckNotified: true, problemResult: res } }).where(eq(schema.deliveryRobots.id, r.id));
    n += 1;
  }
  return n;
}

/** 재알림(30초): 도착 알림 후 remindMinutes 분이 지나도록 완료·취소가 없으면 한 번 더. */
export async function sendDeliveryReminders(now: string = nowIso()): Promise<number> {
  const min = remindMinutes();
  if (!min) return 0;
  const db = getDb();
  const before = new Date(new Date(now).getTime() - min * 60_000).toISOString();
  const due = await db
    .select({ id: schema.deliveryLegs.id })
    .from(schema.deliveryLegs)
    .where(and(isNotNull(schema.deliveryLegs.notifiedAt), isNull(schema.deliveryLegs.remindedAt), isNull(schema.deliveryLegs.completedAt), isNull(schema.deliveryLegs.cancelledAt), sql`${schema.deliveryLegs.arrivedAt} <= ${before}`, sql`${schema.deliveryLegs.arrivedAt} > ${new Date(new Date(now).getTime() - 2 * 3600_000).toISOString()}`));
  for (const d of due) await notifyArrival(d.id, true);
  return due.length;
}

// ---------------------------------------------------------------- 화면

function assertStaff(user: User) {
  assertActive(user);
  if (isCustomer(user)) throw new ForbiddenError("배송 화면은 본사·현장 담당자만 볼 수 있습니다.");
}

export async function getDeliveryView(user: User, opts: { siteId?: string; days?: number } = {}) {
  assertStaff(user);
  const db = getDb();
  const ids = await accessibleSiteIds(user, db);
  const admin = user.role === "HQ_ADMIN";
  const allRobots = await db.select().from(schema.deliveryRobots).orderBy(schema.deliveryRobots.id);
  const robots = allRobots.filter((r) => (r.siteId ? ids.includes(r.siteId) : admin) && (!opts.siteId || r.siteId === opts.siteId));
  const since = new Date(Date.now() - (opts.days ?? 7) * 86400_000).toISOString();
  const legs = robots.length
    ? await db
        .select()
        .from(schema.deliveryLegs)
        .where(and(inArray(schema.deliveryLegs.robotId, robots.map((r) => r.id)), gte(schema.deliveryLegs.firstSeenAt, since)))
        .orderBy(desc(schema.deliveryLegs.firstSeenAt))
        .limit(300)
    : [];
  const recipients = await db.select().from(schema.deliveryRecipients).where(inArray(schema.deliveryRecipients.siteId, ids.length ? ids : ["-"]));
  const sites = (await db.select().from(schema.sites).where(isNull(schema.sites.retiredAt))).filter((s) => ids.includes(s.id));
  const users = (await listUsers(db)).filter((u) => u.active && (u.role === "HQ_ADMIN" || u.role === "SITE_MANAGER")).map((u) => ({ id: u.id, name: u.name, email: u.email }));
  const orders = robots.length ? await db.select().from(schema.deliveryOrders).where(inArray(schema.deliveryOrders.robotId, robots.map((r) => r.id))).orderBy(desc(schema.deliveryOrders.requestedAt)).limit(20) : [];
  // 지시 가능: 본사 관리자 또는 현장 담당자, 사업장 지정·원격 제어 켜진 로봇(최종 확인은 지시할 때 서버에서 다시)
  const remoteOn = new Set(sites.filter((s) => s.remoteControlEnabled).map((s) => s.id));
  const dispatchable = robots.filter((r) => r.active && r.siteId && remoteOn.has(r.siteId) && (admin || user.role === "SITE_MANAGER"));
  return { mode: agentMode(), robots, legs, recipients, sites, users, remindMinutes: remindMinutes(), stuckMinutes: stuckMinutes(), admin, orders, dispatchable };
}

export async function setDeliveryRobotSite(user: User, robotId: string, siteId: string | null): Promise<void> {
  assertActive(user);
  assertAdmin(user);
  const db = getDb();
  const r = await db.query.deliveryRobots.findFirst({ where: eq(schema.deliveryRobots.id, robotId) });
  if (!r) throw new NotFoundError("배송로봇을 찾을 수 없습니다.");
  if (siteId && !(await db.query.sites.findFirst({ where: eq(schema.sites.id, siteId) }))) throw new ValidationError("사업장을 찾을 수 없습니다.");
  await db.update(schema.deliveryRobots).set({ siteId }).where(eq(schema.deliveryRobots.id, robotId));
  await audit(user, { siteId, robotId: null, action: "DELIVERY:ROBOT_SITE", params: { robotId, from: r.siteId, to: siteId }, result: "OK", detail: null, vendorTraceId: null });
}

export async function saveDeliveryRecipients(user: User, input: { siteId: string; destination: string; userIds: string[]; channels: ("PUSH" | "EMAIL" | "KAKAO")[]; enabled?: boolean; note?: string }): Promise<void> {
  assertActive(user);
  assertAdmin(user);
  const destination = input.destination.trim();
  if (!destination) throw new ValidationError("목적지를 입력하세요('*' 는 기본 수신자).");
  const channels = input.channels.filter((c) => c === "PUSH" || c === "EMAIL" || c === "KAKAO");
  if (!channels.length) throw new ValidationError("채널을 하나 이상 고르세요.");
  const db = getDb();
  const valid = new Set((await listUsers(db)).filter((u) => u.active).map((u) => u.id));
  const userIds = Array.from(new Set(input.userIds.filter((id) => valid.has(id))));
  const now = nowIso();
  await db
    .insert(schema.deliveryRecipients)
    .values({ id: newId("drc"), siteId: input.siteId, destination, userIds, channels, enabled: input.enabled ?? true, note: input.note ?? "", updatedBy: user.id, updatedAt: now })
    .onConflictDoUpdate({ target: [schema.deliveryRecipients.siteId, schema.deliveryRecipients.destination], set: { userIds, channels, enabled: input.enabled ?? true, note: input.note ?? "", updatedBy: user.id, updatedAt: now } });
  await audit(user, { siteId: input.siteId, robotId: null, action: "DELIVERY:RECIPIENTS", params: { destination, users: userIds.length, channels }, result: "OK", detail: null, vendorTraceId: null });
}

export async function deleteDeliveryRecipients(user: User, id: string): Promise<void> {
  assertActive(user);
  assertAdmin(user);
  const db = getDb();
  const row = await db.query.deliveryRecipients.findFirst({ where: eq(schema.deliveryRecipients.id, id) });
  if (!row) return;
  await db.delete(schema.deliveryRecipients).where(eq(schema.deliveryRecipients.id, id));
  await audit(user, { siteId: row.siteId, robotId: null, action: "DELIVERY:RECIPIENTS_DELETE", params: { destination: row.destination }, result: "OK", detail: null, vendorTraceId: null });
}

// ---------------------------------------------------------------- 배송 지시(사용자 결정 2026-11-13)

function createAgentCommander(): AgentCommander {
  const mode = agentMode();
  if (mode === "mock") return new AgentCommander(agentMockTransport, MOCK_DEVICE_ID);
  if (mode === "live") return new AgentCommander(httpTransport(process.env.PUDU_AGENT_URL!), process.env.PUDU_AGENT_DEVICE_ID!);
  throw new ValidationError("배송로봇 에이전트 연동이 꺼져 있습니다.");
}

/** 지시 가능 여부: 본사 관리자 또는 그 사업장 현장 담당자, 로봇 사업장 지정, 사업장 원격 제어 켜짐, 최근 상태 수신. 거부도 감사 기록. */
async function assertCanDispatch(user: User, robotId: string, action: string, params: Record<string, unknown>) {
  assertStaff(user);
  const db = getDb();
  const robot = await db.query.deliveryRobots.findFirst({ where: eq(schema.deliveryRobots.id, robotId) });
  if (!robot) throw new NotFoundError("배송로봇을 찾을 수 없습니다.");
  const deny = async (why: string, err: Error) => {
    await audit(user, { siteId: robot.siteId, robotId: null, action, params: { robotId, ...params }, result: "DENIED", detail: why, vendorTraceId: null });
    throw err;
  };
  if (!robot.active) await deny("사용 중지", new ForbiddenError("사용 중지된 배송로봇입니다."));
  if (!robot.siteId) await deny("사업장 미지정", new ValidationError("로봇의 사업장을 먼저 지정하세요."));
  if (user.role !== "HQ_ADMIN" && !(user.role === "SITE_MANAGER" && (await accessibleSiteIds(user, db)).includes(robot.siteId!))) await deny("권한 없음", new ForbiddenError("이 사업장의 배송을 지시할 권한이 없습니다."));
  const site = await db.query.sites.findFirst({ where: eq(schema.sites.id, robot.siteId!) });
  if (!site?.remoteControlEnabled) await deny("사업장 원격 제어 꺼짐", new ForbiddenError("이 사업장은 원격 제어가 꺼져 있습니다. 본사 관리자가 관리 설정 → 원격 제어에서 켤 수 있습니다."));
  if (!robot.lastSeenAt || Date.now() - new Date(robot.lastSeenAt).getTime() > 5 * 60_000) await deny("상태 미수신", new ValidationError("로봇 상태가 5분 넘게 수신되지 않아 지시하지 않습니다(전원·네트워크·에이전트 확인)."));
  const recent = await db.select().from(schema.deliveryOrders).where(and(eq(schema.deliveryOrders.robotId, robotId), eq(schema.deliveryOrders.status, "ACCEPTED"), gte(schema.deliveryOrders.requestedAt, new Date(Date.now() - 20_000).toISOString())));
  if (recent.length) await deny("중복 요청", new ConflictError("방금 보낸 지시가 있습니다. 잠시 뒤 다시 시도하세요(중복 클릭 방지)."));
  return robot;
}

function destType(robot: { destinations: { name: string; type: string }[] }, name: string): string {
  const d = robot.destinations.find((x) => x.name === name);
  if (!d) throw new ValidationError(`로봇 지도에 없는 목적지입니다: ${name}`);
  return d.type;
}

async function recordOrder(user: User, robot: { id: string; siteId: string | null }, kind: "DELIVERY" | "CALL" | "CANCEL_CALL", trays: { destination: string; type?: string; taskRef: string; recipientUserIds: string[] }[], opts: { sort?: string; executeTask?: boolean }, send: () => Promise<{ taskId?: string }>) {
  const id = newId("dor");
  const now = nowIso();
  let status: "ACCEPTED" | "FAILED" = "ACCEPTED";
  let message = "";
  try {
    const r = await send();
    message = r.taskId ? `에이전트 접수(task ${r.taskId})` : "에이전트 접수";
  } catch (e) {
    status = "FAILED";
    message = e instanceof AgentError ? e.message : `전송 실패: ${(e as Error).message}`;
  }
  await getDb().insert(schema.deliveryOrders).values({ id, robotId: robot.id, siteId: robot.siteId, kind, trays, sort: opts.sort ?? "fixed", executeTask: opts.executeTask ?? true, status, message, requestedBy: user.id, requestedAt: now });
  await audit(user, { siteId: robot.siteId, robotId: null, action: `DELIVERY:${kind}`, params: { robotId: robot.id, orderId: id, destinations: trays.map((t) => t.destination) }, result: status === "ACCEPTED" ? "OK" : "ERROR", detail: message, vendorTraceId: null });
  if (status === "FAILED") throw new ValidationError(message);
  return { id, message };
}

/** 배송 보내기: 트레이별 목적지(+ 이 배송의 수신자). 접수는 '로봇이 받았다'는 뜻이고 실제 출발·도착은 배송 기록으로 확인한다. */
export async function dispatchDelivery(user: User, input: { robotId: string; trays: { destination: string; recipientUserIds?: string[] }[]; sort?: "fixed" | "auto"; executeTask?: boolean }) {
  const trays = input.trays.filter((t) => t.destination.trim());
  if (!trays.length) throw new ValidationError("목적지를 하나 이상 고르세요.");
  if (trays.length > 5) throw new ValidationError("트레이는 최대 5개입니다.");
  const robot = await assertCanDispatch(user, input.robotId, "DELIVERY:DELIVERY", { destinations: trays.map((t) => t.destination) });
  const st = (robot.lastState ?? {}) as { robotState?: string };
  if (st.robotState === "BUSY") throw new ConflictError("로봇이 배송 중이거나 누군가 화면을 조작하고 있습니다. 대기 상태가 된 뒤 보내세요.");
  const orderKey = newId("t").slice(-8);
  const rows = trays.map((t, i) => ({ destination: t.destination.trim(), type: destType(robot, t.destination.trim()), taskRef: `wb-${orderKey}-${i + 1}`, recipientUserIds: Array.from(new Set(t.recipientUserIds ?? [])) }));
  const cmd = createAgentCommander();
  return recordOrder(user, robot, "DELIVERY", rows, { sort: input.sort ?? "fixed", executeTask: input.executeTask ?? true }, () => cmd.delivery(robot.agentRobotId, rows.map((r) => [{ destination: r.destination, id: r.taskRef }]), { sort: input.sort ?? "fixed", executeTask: input.executeTask ?? true }));
}

/** 호출: 로봇을 목적지로 부른다(대기 중이면 바로, 배송 중이면 끝난 뒤). */
export async function callDeliveryRobot(user: User, input: { robotId: string; destination: string }) {
  const robot = await assertCanDispatch(user, input.robotId, "DELIVERY:CALL", { destination: input.destination });
  const dest = { name: input.destination, type: destType(robot, input.destination) };
  const cmd = createAgentCommander();
  return recordOrder(user, robot, "CALL", [{ destination: dest.name, type: dest.type, taskRef: "", recipientUserIds: [] }], {}, () => cmd.call(robot.agentRobotId, dest));
}

/** 호출 취소(이 장치가 보낸 호출만 취소된다 — 문서). 수행 중이면 로봇은 출발지로 돌아간다. */
export async function cancelDeliveryCall(user: User, input: { robotId: string; destination: string }) {
  const db = getDb();
  const robot = await db.query.deliveryRobots.findFirst({ where: eq(schema.deliveryRobots.id, input.robotId) });
  if (!robot) throw new NotFoundError("배송로봇을 찾을 수 없습니다.");
  assertStaff(user);
  if (user.role !== "HQ_ADMIN" && !(robot.siteId && (await accessibleSiteIds(user, db)).includes(robot.siteId))) throw new ForbiddenError("권한이 없습니다.");
  const dest = { name: input.destination, type: destType(robot, input.destination) };
  const cmd = createAgentCommander();
  return recordOrder(user, robot, "CANCEL_CALL", [{ destination: dest.name, type: dest.type, taskRef: "", recipientUserIds: [] }], {}, () => cmd.cancelCall(robot.agentRobotId, dest));
}

export async function listDeliveryOrders(user: User, robotIds: string[]) {
  assertStaff(user);
  if (!robotIds.length) return [];
  return getDb().select().from(schema.deliveryOrders).where(inArray(schema.deliveryOrders.robotId, robotIds)).orderBy(desc(schema.deliveryOrders.requestedAt)).limit(30);
}
