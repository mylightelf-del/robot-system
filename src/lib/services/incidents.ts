import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { Incident, IncidentAction, Severity, User } from "@/lib/domain/types";
import { accessibleSiteIds, assertActive, assertSiteAccess, canHandleIncidents, isCustomer } from "@/lib/auth/authz";
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
  status: Incident["status"];
  acknowledgedAt: string | null;
  assigneeName: string | null;
  resolvedAt: string | null;
  actions: IncidentAction[];
  notifications: Incident["notifications"];
  minutesOpen: number;
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
    status: i.status,
    acknowledgedAt: i.acknowledgedAt,
    assigneeName: customer ? (i.assigneeId ? "담당자 지정됨" : null) : ctx.assigneeName,
    resolvedAt: i.resolvedAt,
    actions: customer ? i.actions.filter((a) => !a.internal) : i.actions,
    notifications: customer ? [] : i.notifications,
    minutesOpen: Math.round((new Date(end).getTime() - new Date(i.occurredAt).getTime()) / 60000),
  };
}

async function nameContexts(incidents: Incident[], db: DbLike): Promise<Map<string, NameContext>> {
  const siteIds = Array.from(new Set(incidents.map((i) => i.siteId)));
  const robotIds = Array.from(new Set(incidents.map((i) => i.robotId)));
  const sites = new Map((await listSitesByIds(siteIds, db)).map((s) => [s.id, s.name]));
  const robots = robotIds.length ? new Map((await db.select({ id: schema.robots.id, name: schema.robots.name }).from(schema.robots).where(inArray(schema.robots.id, robotIds))).map((r) => [r.id, r.name])) : new Map<string, string>();
  const users = new Map((await listUsers(db)).map((u) => [u.id, u.name]));
  return new Map(incidents.map((i) => [i.id, { siteName: sites.get(i.siteId) ?? i.siteId, robotName: robots.get(i.robotId) ?? i.robotId, assigneeName: i.assigneeId ? (users.get(i.assigneeId) ?? i.assigneeId) : null }]));
}

export async function listIncidents(user: User, opts: { siteId?: string; includeResolved?: boolean } = {}): Promise<IncidentView[]> {
  assertActive(user);
  const db = getDb();
  const siteIds = await accessibleSiteIds(user, db);
  if (opts.siteId) await assertSiteAccess(user, opts.siteId, db);
  const ids = opts.siteId ? [opts.siteId] : siteIds;
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(schema.incidents)
    .where(and(inArray(schema.incidents.siteId, ids), opts.includeResolved ? undefined : ne(schema.incidents.status, "RESOLVED")))
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
  const openSame = await db.select({ id: schema.incidents.id }).from(schema.incidents).where(and(eq(schema.incidents.robotId, robotId), eq(schema.incidents.code, code), ne(schema.incidents.status, "RESOLVED")));
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
