import type { Incident, IncidentAction, Severity, User } from "@/lib/domain/types";
import { accessibleSiteIds, assertActive, assertSiteAccess, canHandleIncidents, isCustomer } from "@/lib/auth/authz";
import { getStore } from "@/lib/store/store";
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
  message: string; // 고객: customerMessage, 직원: rawMessage 포함 안내
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

export function sanitizeIncident(i: Incident, user: User): IncidentView {
  const data = getStore();
  const customer = isCustomer(user);
  const robot = data.robots.find((r) => r.id === i.robotId);
  const site = data.sites.find((s) => s.id === i.siteId);
  const assignee = i.assigneeId ? data.users.find((u) => u.id === i.assigneeId) : null;
  const end = i.resolvedAt ?? nowIso();
  return {
    id: i.id,
    siteId: i.siteId,
    siteName: site?.name ?? i.siteId,
    robotId: i.robotId,
    robotName: robot?.name ?? i.robotId,
    code: i.code,
    severity: i.severity,
    message: i.customerMessage,
    rawMessage: customer ? null : i.rawMessage,
    customerMessage: i.customerMessage,
    occurredAt: i.occurredAt,
    status: i.status,
    acknowledgedAt: i.acknowledgedAt,
    assigneeName: customer ? (assignee ? "담당자 지정됨" : null) : (assignee?.name ?? null),
    resolvedAt: i.resolvedAt,
    actions: customer ? i.actions.filter((a) => !a.internal) : i.actions,
    notifications: customer ? [] : i.notifications,
    minutesOpen: Math.round((new Date(end).getTime() - new Date(i.occurredAt).getTime()) / 60000),
  };
}

export function listIncidents(user: User, opts: { siteId?: string; includeResolved?: boolean } = {}): IncidentView[] {
  assertActive(user);
  const data = getStore();
  const siteIds = accessibleSiteIds(data, user);
  if (opts.siteId) assertSiteAccess(data, user, opts.siteId);
  return data.incidents
    .filter((i) => siteIds.includes(i.siteId) && (!opts.siteId || i.siteId === opts.siteId) && (opts.includeResolved || i.status !== "RESOLVED"))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .map((i) => sanitizeIncident(i, user));
}

function loadForHandling(user: User, incidentId: string): Incident {
  const data = getStore();
  assertActive(user);
  if (!canHandleIncidents(user)) throw new ForbiddenError("장애 조치는 현장/본사 담당자만 할 수 있습니다.");
  const inc = data.incidents.find((i) => i.id === incidentId);
  if (!inc) throw new NotFoundError("장애를 찾을 수 없습니다.");
  assertSiteAccess(data, user, inc.siteId);
  return inc;
}

export function acknowledgeIncident(user: User, incidentId: string): Incident {
  const data = getStore();
  const inc = loadForHandling(user, incidentId);
  if (inc.status !== "OPEN") throw new ValidationError("이미 확인된 장애입니다.");
  inc.status = "ACKED";
  inc.acknowledgedAt = nowIso();
  audit(data, user, { siteId: inc.siteId, robotId: inc.robotId, action: "INCIDENT:ACK", params: { incidentId }, result: "OK", detail: null, vendorTraceId: null });
  return inc;
}

export function assignIncident(user: User, incidentId: string, assigneeId: string): Incident {
  const data = getStore();
  const inc = loadForHandling(user, incidentId);
  const assignee = data.users.find((u) => u.id === assigneeId && u.active && (u.role === "HQ_ADMIN" || u.role === "SITE_MANAGER"));
  if (!assignee) throw new ValidationError("담당자로 지정할 수 없는 사용자입니다.");
  if (inc.status === "RESOLVED") throw new ValidationError("복구된 장애는 담당자를 바꿀 수 없습니다.");
  inc.assigneeId = assignee.id;
  if (inc.status === "OPEN") inc.acknowledgedAt = nowIso();
  if (inc.status === "OPEN" || inc.status === "ACKED") inc.status = "ASSIGNED";
  audit(data, user, { siteId: inc.siteId, robotId: inc.robotId, action: "INCIDENT:ASSIGN", params: { incidentId, assigneeId }, result: "OK", detail: null, vendorTraceId: null });
  return inc;
}

export function addIncidentAction(user: User, incidentId: string, note: string, internal: boolean): Incident {
  const data = getStore();
  const inc = loadForHandling(user, incidentId);
  if (!note.trim()) throw new ValidationError("조치 내용을 입력하세요.");
  if (inc.status === "RESOLVED") throw new ValidationError("복구된 장애에는 조치를 추가할 수 없습니다.");
  inc.actions.push({ id: newId("act"), at: nowIso(), userId: user.id, note: note.trim(), internal });
  if (inc.status === "OPEN") inc.acknowledgedAt = nowIso();
  inc.status = "IN_PROGRESS";
  audit(data, user, { siteId: inc.siteId, robotId: inc.robotId, action: "INCIDENT:ACTION", params: { incidentId, internal }, result: "OK", detail: null, vendorTraceId: null });
  return inc;
}

export async function resolveIncident(user: User, incidentId: string, note: string): Promise<Incident> {
  const data = getStore();
  const inc = loadForHandling(user, incidentId);
  if (inc.status === "RESOLVED") throw new ValidationError("이미 복구된 장애입니다.");
  const now = nowIso();
  inc.actions.push({ id: newId("act"), at: now, userId: user.id, note: note.trim() || "복구 확인", internal: false });
  inc.status = "RESOLVED";
  inc.resolvedAt = now;
  if (!inc.acknowledgedAt) inc.acknowledgedAt = now;
  // 발생과 복구는 같은 장애 건으로 연결: 복구 통보도 같은 incident 의 notifications 에 남긴다.
  const site = data.sites.find((s) => s.id === inc.siteId)!;
  const setting = data.notificationSettings.find((n) => n.siteId === inc.siteId);
  const logs = await notifyIncident(setting, inc, null, now, site.timezone, "RESOLVED");
  inc.notifications.push(...logs);
  // 로봇 상태가 오류였다면 대기로 복귀(샘플 시뮬레이션)
  const st = data.statuses[inc.robotId];
  if (st && st.common === "ERROR") {
    st.common = "IDLE";
    st.raw = "FREE";
    st.lastReceivedAt = now;
    st.dataAt = now;
  }
  audit(data, user, { siteId: inc.siteId, robotId: inc.robotId, action: "INCIDENT:RESOLVE", params: { incidentId }, result: "OK", detail: null, vendorTraceId: null });
  return inc;
}

/** 샘플: 장애 발생 시뮬레이션(Webhook 수신을 대신). 중복 이벤트 ID 는 무시한다. */
export async function simulateIncident(user: User, robotId: string, code: string, severity: Severity, vendorEventId: string | null): Promise<Incident | null> {
  const data = getStore();
  assertActive(user);
  if (!canHandleIncidents(user)) throw new ForbiddenError("장애 시뮬레이션은 현장/본사 담당자만 할 수 있습니다.");
  const robot = data.robots.find((r) => r.id === robotId);
  if (!robot) throw new NotFoundError();
  assertSiteAccess(data, user, robot.siteId);
  if (vendorEventId && data.incidents.some((i) => i.vendorEventId === vendorEventId)) {
    audit(data, user, { siteId: robot.siteId, robotId, action: "INCIDENT:DUPLICATE_EVENT", params: { vendorEventId }, result: "OK", detail: "중복 이벤트 무시", vendorTraceId: null });
    return null;
  }
  const now = nowIso();
  const site = data.sites.find((s) => s.id === robot.siteId)!;
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
  const recent = data.incidents
    .filter((i) => i.robotId === robotId && i.code === code && i.status !== "RESOLVED")
    .flatMap((i) => i.notifications.filter((n) => n.status === "MOCK_SENT").map((n) => n.at))
    .sort()
    .pop() ?? null;
  const setting = data.notificationSettings.find((n) => n.siteId === robot.siteId);
  inc.notifications = await notifyIncident(setting, inc, recent, now, site.timezone, "OCCURRED");
  data.incidents.unshift(inc);
  const st = data.statuses[robotId];
  if (st && severity !== "LOW") {
    st.common = "ERROR";
    st.raw = `ERROR:${code}`;
    st.lastReceivedAt = now;
    st.dataAt = now;
  }
  audit(data, user, { siteId: robot.siteId, robotId, action: "INCIDENT:SIMULATE", params: { code, severity, vendorEventId }, result: "OK", detail: "시뮬레이션", vendorTraceId: null });
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
