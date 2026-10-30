import { and, desc, eq, gte, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import type { Incident, IncidentAction, Severity, User } from "@/lib/domain/types";
import { accessibleSiteIds, assertActive, assertAdmin, assertSiteAccess, canHandleIncidents, isCustomer } from "@/lib/auth/authz";
import { getDb, schema } from "@/lib/db/client";
import { assembleIncidents, getIncident, getNotificationSetting, getRobot, getSite, listSitesByIds, listUsers, type DbLike } from "@/lib/db/repo";
import { notifyIncident } from "@/lib/notify/notifier";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/util/errors";
import { newId } from "@/lib/util/random";
import { nowIso } from "@/lib/util/time";
import { audit } from "./audit";

/** 고객 화면용 장애 뷰: 오류 원문·내부 메모·통신 로그를 제거한다. */
export interface IncidentView {
  id: string;
  siteId: string;
  siteName: string;
  robotId: string;
  robotName: string;
  code: string;
  severity: Severity;
  message: string;
  rawMessage: string | null; // 고객에게는 null
  customerMessage: string;
  occurredAt: string;
  /** 같은 코드 반복 발생 횟수(묶음)와 최근 발생 시각. */
  occurrences: number;
  lastOccurredAt: string | null;
  status: Incident["status"];
  acknowledgedAt: string | null;
  assigneeName: string | null;
  resolvedAt: string | null;
  actions: IncidentAction[];
  notifications: Incident["notifications"];
  minutesOpen: number;
  /** 삭제(숨김)된 알림이면 그 시각·사유(담당자 화면의 '삭제한 알림' 보기에서만). */
  dismissedAt: string | null;
  dismissReason: string | null;
  /** '한 단계 되돌리기'가 할 일(없으면 null). */
  revertLabel: string | null;
}

export interface NameContext {
  siteName: string;
  robotName: string;
  assigneeName: string | null;
}

export function sanitizeIncident(i: Incident, user: User, ctx: NameContext): IncidentView {
  const customer = isCustomer(user);
  const end = i.resolvedAt ?? nowIso();
  return {
    id: i.id,
    siteId: i.siteId,
    siteName: ctx.siteName,
    robotId: i.robotId,
    robotName: ctx.robotName,
    code: i.code,
    severity: i.severity,
    message: i.customerMessage,
    rawMessage: customer ? null : i.rawMessage,
    customerMessage: i.customerMessage,
    occurredAt: i.occurredAt,
    occurrences: i.occurrences ?? 1,
    lastOccurredAt: i.lastOccurredAt ?? null,
    status: i.status,
    acknowledgedAt: i.acknowledgedAt,
    assigneeName: customer ? (i.assigneeId ? "담당자 지정됨" : null) : ctx.assigneeName,
    resolvedAt: i.resolvedAt,
    actions: customer ? i.actions.filter((a) => !a.internal) : i.actions,
    notifications: customer ? [] : i.notifications,
    minutesOpen: Math.round((new Date(end).getTime() - new Date(i.occurredAt).getTime()) / 60000),
    dismissedAt: customer ? null : (i.dismissedAt ?? null),
    dismissReason: customer ? null : (i.dismissReason ?? null),
    revertLabel: customer ? null : revertPlan(i)?.label ?? null,
  };
}

/**
 * 단계 되돌리기 계획: 복구 → (복구 전 단계), 조치 중 → 마지막 조치 취소, 담당자 지정 → 지정 해제, 확인 → 발생.
 * 실수로 누른 단계를 한 번에 하나씩 되돌린다. 모든 되돌리기는 감사 기록에 사유와 함께 남는다.
 */
function revertPlan(i: Pick<Incident, "status" | "assigneeId" | "acknowledgedAt" | "actions" | "resolvedAt">): { label: string } | null {
  switch (i.status) {
    case "RESOLVED":
      return { label: "복구 취소" };
    case "IN_PROGRESS":
      return { label: "마지막 조치 취소" };
    case "ASSIGNED":
      return { label: "담당자 지정 취소" };
    case "ACKED":
      return { label: "확인 취소" };
    default:
      return null;
  }
}

/** 조치 기록·담당·확인 여부로 지금 상태를 다시 정한다(복구 제외). */
function statusFromState(i: { assigneeId: string | null; acknowledgedAt: string | null }, actionCount: number): Incident["status"] {
  if (actionCount > 0) return "IN_PROGRESS";
  if (i.assigneeId) return "ASSIGNED";
  if (i.acknowledgedAt) return "ACKED";
  return "OPEN";
}

async function nameContexts(incidents: Incident[], db: DbLike): Promise<Map<string, NameContext>> {
  const siteIds = Array.from(new Set(incidents.map((i) => i.siteId)));
  const robotIds = Array.from(new Set(incidents.map((i) => i.robotId)));
  const sites = new Map((await listSitesByIds(siteIds, db)).map((s) => [s.id, s.name]));
  const robots = robotIds.length ? new Map((await db.select({ id: schema.robots.id, name: schema.robots.name }).from(schema.robots).where(inArray(schema.robots.id, robotIds))).map((r) => [r.id, r.name])) : new Map<string, string>();
  const users = new Map((await listUsers(db)).map((u) => [u.id, u.name]));
  return new Map(incidents.map((i) => [i.id, { siteName: sites.get(i.siteId) ?? i.siteId, robotName: robots.get(i.robotId) ?? i.robotId, assigneeName: i.assigneeId ? (users.get(i.assigneeId) ?? i.assigneeId) : null }]));
}

export async function listIncidents(user: User, opts: { siteId?: string; includeResolved?: boolean; dismissed?: boolean } = {}): Promise<IncidentView[]> {
  assertActive(user);
  const db = getDb();
  const siteIds = await accessibleSiteIds(user, db);
  if (opts.siteId) await assertSiteAccess(user, opts.siteId, db);
  const ids = opts.siteId ? [opts.siteId] : siteIds;
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(schema.incidents)
    .where(
      and(
        inArray(schema.incidents.siteId, ids),
        // 삭제(숨김)한 알림은 담당자의 '삭제한 알림' 보기에서만 보인다
        opts.dismissed && !isCustomer(user) ? isNotNull(schema.incidents.dismissedAt) : isNull(schema.incidents.dismissedAt),
        opts.includeResolved || opts.dismissed ? undefined : ne(schema.incidents.status, "RESOLVED"),
      ),
    )
    .orderBy(desc(schema.incidents.occurredAt))
    .limit(200);
  const incidents = await assembleIncidents(rows, db);
  const ctx = await nameContexts(incidents, db);
  return incidents.map((i) => sanitizeIncident(i, user, ctx.get(i.id)!));
}

async function loadForHandling(user: User, incidentId: string, db: DbLike): Promise<Incident> {
  assertActive(user);
  if (!canHandleIncidents(user)) throw new ForbiddenError("장애 조치는 현장/본사 담당자만 할 수 있습니다.");
  const inc = await getIncident(incidentId, db);
  if (!inc) throw new NotFoundError("장애를 찾을 수 없습니다.");
  await assertSiteAccess(user, inc.siteId, db);
  if (inc.dismissedAt) throw new ValidationError("삭제한 알림입니다. 먼저 복원하세요.");
  return inc;
}

export async function acknowledgeIncident(user: User, incidentId: string): Promise<void> {
  const db = getDb();
  const inc = await loadForHandling(user, incidentId, db);
  if (inc.status !== "OPEN") throw new ValidationError("이미 확인된 장애입니다.");
  await db.update(schema.incidents).set({ status: "ACKED", acknowledgedAt: nowIso() }).where(eq(schema.incidents.id, incidentId));
  await audit(user, { siteId: inc.siteId, robotId: inc.robotId, action: "INCIDENT:ACK", params: { incidentId }, result: "OK", detail: null, vendorTraceId: null }, db);
}

export async function assignIncident(user: User, incidentId: string, assigneeId: string): Promise<void> {
  const db = getDb();
  const inc = await loadForHandling(user, incidentId, db);
  const assignee = (await listUsers(db)).find((u) => u.id === assigneeId && u.active && (u.role === "HQ_ADMIN" || u.role === "SITE_MANAGER"));
  if (!assignee) throw new ValidationError("담당자로 지정할 수 없는 사용자입니다.");
  if (inc.status === "RESOLVED") throw new ValidationError("복구된 장애는 담당자를 바꿀 수 없습니다.");
  const now = nowIso();
  await db
    .update(schema.incidents)
    .set({
      assigneeId: assignee.id,
      acknowledgedAt: inc.acknowledgedAt ?? now,
      status: inc.status === "OPEN" || inc.status === "ACKED" ? "ASSIGNED" : inc.status,
    })
    .where(eq(schema.incidents.id, incidentId));
  await audit(user, { siteId: inc.siteId, robotId: inc.robotId, action: "INCIDENT:ASSIGN", params: { incidentId, assigneeId }, result: "OK", detail: null, vendorTraceId: null }, db);
}

export async function addIncidentAction(user: User, incidentId: string, note: string, internal: boolean): Promise<void> {
  const db = getDb();
  const inc = await loadForHandling(user, incidentId, db);
  if (!note.trim()) throw new ValidationError("조치 내용을 입력하세요.");
  if (inc.status === "RESOLVED") throw new ValidationError("복구된 장애에는 조치를 추가할 수 없습니다.");
  const now = nowIso();
  await db.transaction(async (tx) => {
    await tx.insert(schema.incidentActions).values({ id: newId("act"), incidentId, at: now, userId: user.id, note: note.trim(), internal });
    await tx.update(schema.incidents).set({ status: "IN_PROGRESS", acknowledgedAt: inc.acknowledgedAt ?? now }).where(eq(schema.incidents.id, incidentId));
    await audit(user, { siteId: inc.siteId, robotId: inc.robotId, action: "INCIDENT:ACTION", params: { incidentId, internal }, result: "OK", detail: null, vendorTraceId: null }, tx);
  });
}

export async function resolveIncident(user: User, incidentId: string, note: string): Promise<void> {
  const db = getDb();
  const inc = await loadForHandling(user, incidentId, db);
  if (inc.status === "RESOLVED") throw new ValidationError("이미 복구된 장애입니다.");
  const now = nowIso();
  const site = (await getSite(inc.siteId, db))!;
  const setting = await getNotificationSetting(inc.siteId, db);
  // 발생과 복구는 같은 장애 건으로 연결: 복구 통보도 같은 incident 의 notifications 에 남긴다.
  const logs = await notifyIncident(setting, inc, null, now, site.timezone, "RESOLVED");
  await db.transaction(async (tx) => {
    await tx.insert(schema.incidentActions).values({ id: newId("act"), incidentId, at: now, userId: user.id, note: note.trim() || "복구 확인", internal: false });
    await tx.update(schema.incidents).set({ status: "RESOLVED", resolvedAt: now, acknowledgedAt: inc.acknowledgedAt ?? now }).where(eq(schema.incidents.id, incidentId));
    if (logs.length) await tx.insert(schema.notificationLogs).values(logs.map((l) => ({ ...l, incidentId })));
    // 로봇 상태가 오류였다면 대기로 복귀(샘플 시뮬레이션). 실제 연동에서는 제조사 상태 수신으로 갱신된다.
    await tx.update(schema.robotStatus).set({ common: "IDLE", raw: "FREE", lastReceivedAt: now, dataAt: now }).where(and(eq(schema.robotStatus.robotId, inc.robotId), eq(schema.robotStatus.common, "ERROR")));
    await audit(user, { siteId: inc.siteId, robotId: inc.robotId, action: "INCIDENT:RESOLVE", params: { incidentId }, result: "OK", detail: null, vendorTraceId: null }, tx);
  });
}

/** 한 단계 되돌리기(사유 필수). 복구 취소 시 복구 때 남긴 조치 기록도 지운다(감사 기록에는 남는다). */
export async function revertIncidentStep(user: User, incidentId: string, reason: string): Promise<{ from: Incident["status"]; to: Incident["status"] }> {
  const db = getDb();
  const inc = await loadForHandling(user, incidentId, db);
  if (!reason.trim()) throw new ValidationError("되돌리는 사유를 입력하세요.");
  const plan = revertPlan(inc);
  if (!plan) throw new ValidationError("발생 단계는 더 되돌릴 수 없습니다. 불필요한 알림이면 '알림 삭제'를 쓰세요.");
  const actions = [...inc.actions].sort((a, b) => a.at.localeCompare(b.at));
  let removed: (typeof actions)[number] | undefined;
  const patch: Partial<typeof schema.incidents.$inferInsert> = {};
  if (inc.status === "RESOLVED") {
    // 복구 처리 때 같은 시각으로 남긴 조치 기록(복구 확인 메모)을 지운다
    removed = actions.filter((a) => a.at === inc.resolvedAt).at(-1);
    patch.resolvedAt = null;
    patch.status = statusFromState(inc, actions.length - (removed ? 1 : 0));
  } else if (inc.status === "IN_PROGRESS") {
    removed = actions.at(-1);
    patch.status = statusFromState(inc, actions.length - (removed ? 1 : 0));
  } else if (inc.status === "ASSIGNED") {
    patch.assigneeId = null;
    patch.status = statusFromState({ assigneeId: null, acknowledgedAt: inc.acknowledgedAt }, 0);
  } else if (inc.status === "ACKED") {
    patch.acknowledgedAt = null;
    patch.status = "OPEN";
  }
  await db.transaction(async (tx) => {
    if (removed) await tx.delete(schema.incidentActions).where(eq(schema.incidentActions.id, removed.id));
    await tx.update(schema.incidents).set(patch).where(eq(schema.incidents.id, incidentId));
    await audit(user, { siteId: inc.siteId, robotId: inc.robotId, action: "INCIDENT:REVERT", params: { incidentId, from: inc.status, to: patch.status, step: plan.label, removedAction: removed ? { at: removed.at, note: removed.note, internal: removed.internal } : null }, result: "OK", detail: reason.trim(), vendorTraceId: null }, tx);
  });
  return { from: inc.status, to: patch.status! };
}

/** 조치 기록 하나 취소(잘못 쓴 메모). 내용은 감사 기록에 남는다. */
export async function deleteIncidentAction(user: User, actionId: string, reason: string): Promise<void> {
  const db = getDb();
  const act = await db.query.incidentActions.findFirst({ where: eq(schema.incidentActions.id, actionId) });
  if (!act) throw new NotFoundError("조치 기록을 찾을 수 없습니다.");
  const inc = await loadForHandling(user, act.incidentId, db);
  if (!reason.trim()) throw new ValidationError("취소 사유를 입력하세요.");
  const remaining = inc.actions.filter((a) => a.id !== actionId).length;
  await db.transaction(async (tx) => {
    await tx.delete(schema.incidentActions).where(eq(schema.incidentActions.id, actionId));
    if (inc.status === "IN_PROGRESS") await tx.update(schema.incidents).set({ status: statusFromState(inc, remaining) }).where(eq(schema.incidents.id, inc.id));
    await audit(user, { siteId: inc.siteId, robotId: inc.robotId, action: "INCIDENT:ACTION_CANCEL", params: { incidentId: inc.id, actionId, at: act.at, note: act.note, internal: act.internal }, result: "OK", detail: reason.trim(), vendorTraceId: null }, tx);
  });
}

/**
 * 불필요한 알림 삭제(숨김): 목록·대시보드·보고서에서 빠진다. 행은 남겨 같은 제조사 이벤트가 다시 적재되지 않게 하고 감사 기록에 남긴다.
 * 여러 건을 한 번에 지울 수 있다. 다른 사업장 건이 섞이면 전체를 거절한다.
 */
export async function dismissIncidents(user: User, incidentIds: string[], reason: string): Promise<number> {
  assertActive(user);
  if (!canHandleIncidents(user)) throw new ForbiddenError("알림 삭제는 현장/본사 담당자만 할 수 있습니다.");
  if (!reason.trim()) throw new ValidationError("삭제 사유를 입력하세요(예: 정상 동작 중 발생한 경고).");
  const ids = Array.from(new Set(incidentIds)).slice(0, 500);
  if (!ids.length) return 0;
  const db = getDb();
  const rows = await db.select().from(schema.incidents).where(inArray(schema.incidents.id, ids));
  for (const siteId of new Set(rows.map((r) => r.siteId))) await assertSiteAccess(user, siteId, db);
  const targets = rows.filter((r) => !r.dismissedAt);
  if (!targets.length) return 0;
  const now = nowIso();
  await db.transaction(async (tx) => {
    await tx.update(schema.incidents).set({ dismissedAt: now, dismissedBy: user.id, dismissReason: reason.trim().slice(0, 200) }).where(inArray(schema.incidents.id, targets.map((t) => t.id)));
    for (const t of targets) {
      await audit(user, { siteId: t.siteId, robotId: t.robotId, action: "INCIDENT:DISMISS", params: { incidentId: t.id, code: t.code, severity: t.severity, status: t.status, occurredAt: t.occurredAt }, result: "OK", detail: reason.trim(), vendorTraceId: null }, tx);
    }
  });
  return targets.length;
}

/** 삭제한 알림 복원(본사 관리자). */
export async function restoreIncident(user: User, incidentId: string): Promise<void> {
  assertActive(user);
  assertAdmin(user);
  const db = getDb();
  const inc = await db.query.incidents.findFirst({ where: eq(schema.incidents.id, incidentId) });
  if (!inc) throw new NotFoundError("장애를 찾을 수 없습니다.");
  if (!inc.dismissedAt) throw new ValidationError("삭제된 알림이 아닙니다.");
  await db.update(schema.incidents).set({ dismissedAt: null, dismissedBy: null, dismissReason: null }).where(eq(schema.incidents.id, incidentId));
  await audit(user, { siteId: inc.siteId, robotId: inc.robotId, action: "INCIDENT:RESTORE", params: { incidentId }, result: "OK", detail: null, vendorTraceId: null }, db);
}

/**
 * 미조치 확대 통보(워커 5분 주기): 확인·담당·조치 없이(발생/확인 상태) 사업장 설정의 '미조치 확대 통보' 분을 넘긴 장애를 한 번만 통보한다.
 * 배포 직후 오래된 장애가 한꺼번에 나가지 않도록 최근 ESCALATE_LOOKBACK_HOURS 안에 발생한 건만 본다. 삭제(숨김)한 알림은 제외.
 */
export const ESCALATE_LOOKBACK_HOURS = 24;
export async function escalateOverdueIncidents(now: string = nowIso()): Promise<number> {
  const db = getDb();
  const since = new Date(new Date(now).getTime() - ESCALATE_LOOKBACK_HOURS * 3600_000).toISOString();
  const rows = await db
    .select()
    .from(schema.incidents)
    .where(and(inArray(schema.incidents.status, ["OPEN", "ACKED"]), isNull(schema.incidents.dismissedAt), gte(schema.incidents.occurredAt, since)));
  let sent = 0;
  for (const inc of await assembleIncidents(rows, db)) {
    const setting = await getNotificationSetting(inc.siteId, db);
    if (!setting || setting.escalateAfterMinutes <= 0) continue;
    if ((new Date(now).getTime() - new Date(inc.occurredAt).getTime()) / 60000 < setting.escalateAfterMinutes) continue;
    if (inc.notifications.some((n) => n.reason.startsWith("미조치 확대 통보"))) continue;
    const site = await getSite(inc.siteId, db);
    const logs = await notifyIncident(setting, inc, null, now, site?.timezone ?? "Asia/Seoul", "ESCALATED");
    if (!logs.length) continue;
    await db.insert(schema.notificationLogs).values(logs.map((l) => ({ ...l, incidentId: inc.id })));
    sent += 1;
  }
  return sent;
}

/** 샘플: 장애 발생 시뮬레이션(Webhook 수신을 대신). 중복 이벤트 ID 는 무시한다. */
export async function simulateIncident(user: User, robotId: string, code: string, severity: Severity, vendorEventId: string | null): Promise<Incident | null> {
  const db = getDb();
  assertActive(user);
  if (!canHandleIncidents(user)) throw new ForbiddenError("장애 시뮬레이션은 현장/본사 담당자만 할 수 있습니다.");
  const robot = await getRobot(robotId, db);
  if (!robot) throw new NotFoundError();
  await assertSiteAccess(user, robot.siteId, db);
  if (vendorEventId) {
    const dup = await db.query.incidents.findFirst({ where: eq(schema.incidents.vendorEventId, vendorEventId) });
    if (dup) {
      await audit(user, { siteId: robot.siteId, robotId, action: "INCIDENT:DUPLICATE_EVENT", params: { vendorEventId }, result: "OK", detail: "중복 이벤트 무시", vendorTraceId: null }, db);
      return null;
    }
  }
  const now = nowIso();
  const site = (await getSite(robot.siteId, db))!;
  const inc: Incident = {
    id: newId("inc"),
    siteId: robot.siteId,
    robotId,
    code,
    severity,
    rawMessage: `${code} (simulated raw vendor text)`,
    customerMessage: CUSTOMER_MESSAGES[code] ?? "로봇에 이상이 발생하여 확인 중입니다.",
    occurredAt: now,
    status: "OPEN",
    acknowledgedAt: null,
    assigneeId: null,
    resolvedAt: null,
    vendorEventId,
    actions: [],
    notifications: [],
  };
  // 같은 로봇·같은 코드의 미복구 장애에 대해 최근 발송 시각(중복 억제 판단)
  const openSame = await db.select({ id: schema.incidents.id }).from(schema.incidents).where(and(eq(schema.incidents.robotId, robotId), eq(schema.incidents.code, code), ne(schema.incidents.status, "RESOLVED"), isNull(schema.incidents.dismissedAt)));
  let recent: string | null = null;
  if (openSame.length) {
    const logs = await db
      .select({ at: schema.notificationLogs.at })
      .from(schema.notificationLogs)
      .where(and(inArray(schema.notificationLogs.incidentId, openSame.map((x) => x.id)), eq(schema.notificationLogs.status, "MOCK_SENT")))
      .orderBy(desc(schema.notificationLogs.at))
      .limit(1);
    recent = logs[0]?.at ?? null;
  }
  const setting = await getNotificationSetting(robot.siteId, db);
  inc.notifications = await notifyIncident(setting, inc, recent, now, site.timezone, "OCCURRED");
  await db.transaction(async (tx) => {
    const { actions: _a, notifications, ...row } = inc;
    await tx.insert(schema.incidents).values(row);
    if (notifications.length) await tx.insert(schema.notificationLogs).values(notifications.map((n) => ({ ...n, incidentId: inc.id })));
    if (severity !== "LOW") {
      await tx.update(schema.robotStatus).set({ common: "ERROR", raw: `ERROR:${code}`, lastReceivedAt: now, dataAt: now }).where(eq(schema.robotStatus.robotId, robotId));
    }
    await audit(user, { siteId: robot.siteId, robotId, action: "INCIDENT:SIMULATE", params: { code, severity, vendorEventId }, result: "OK", detail: "시뮬레이션", vendorTraceId: null }, tx);
  });
  return inc;
}

export const CUSTOMER_MESSAGES: Record<string, string> = {
  BRUSH_MOTOR: "브러시 구동부 이상으로 작업이 중단되었습니다. 현장 점검 예정입니다.",
  CLEAN_WATER_EMPTY: "청수 보충이 필요하여 작업이 일시 중단되었습니다.",
  DIRTY_WATER_FULL: "오수통 가득 참으로 작업이 중단되었습니다.",
  OBSTACLE_STUCK: "장애물에 막혀 작업이 중단되었습니다.",
  LOCALIZATION_LOST: "위치 인식 실패로 작업이 중단되었습니다.",
  COMM_LOST: "로봇과의 통신이 끊겨 상태를 확인 중입니다.",
  LOW_BATTERY_ABORT: "배터리 부족으로 작업이 조기 종료되었습니다.",
};

export const SIMULATABLE_CODES: { code: string; severity: Severity; label: string }[] = [
  { code: "OBSTACLE_STUCK", severity: "MEDIUM", label: "장애물 끼임" },
  { code: "DIRTY_WATER_FULL", severity: "MEDIUM", label: "오수통 가득" },
  { code: "BRUSH_MOTOR", severity: "HIGH", label: "브러시 모터 이상" },
  { code: "LOCALIZATION_LOST", severity: "HIGH", label: "위치 인식 실패" },
  { code: "LOW_BATTERY_ABORT", severity: "LOW", label: "배터리 부족 조기 종료" },
];

/** 담당자로 지정 가능한 사용자(활성 본사/현장). */
export async function listAssignableUsers(): Promise<{ id: string; name: string }[]> {
  return (await listUsers()).filter((u) => u.active && (u.role === "HQ_ADMIN" || u.role === "SITE_MANAGER")).map((u) => ({ id: u.id, name: u.name }));
}

/** 사업장별 미조치 확대 통보 기준(분). */
export async function escalationMinutesBySite(siteIds: string[]): Promise<Record<string, number>> {
  if (siteIds.length === 0) return {};
  const rows = await getDb().select().from(schema.notificationSettings).where(inArray(schema.notificationSettings.siteId, siteIds));
  return Object.fromEntries(rows.map((r) => [r.siteId, r.escalateAfterMinutes]));
}
