import type { CommandType, NotificationRecipient, Role, Severity, User } from "@/lib/domain/types";
import { assertAdmin, assertActive } from "@/lib/auth/authz";
import { getStore } from "@/lib/store/store";
import { NotFoundError, ValidationError } from "@/lib/util/errors";
import { newId } from "@/lib/util/random";
import { nowIso } from "@/lib/util/time";
import { audit } from "./audit";

/** 관리 설정 화면 데이터(본사 관리자 전용). */
export function getAdminData(user: User) {
  assertActive(user);
  assertAdmin(user);
  const data = getStore();
  return {
    sites: data.sites,
    floors: data.floors,
    zones: data.zones,
    mapVersions: data.mapVersions,
    robots: data.robots,
    placements: data.placements,
    users: data.users,
    notificationSettings: data.notificationSettings,
    vendorConnections: data.vendorConnections,
    settings: data.settings,
    audit: data.audit.slice(0, 50),
  };
}

export function setUserActive(user: User, targetId: string, active: boolean): User {
  const data = getStore();
  assertAdmin(user);
  const t = data.users.find((u) => u.id === targetId);
  if (!t) throw new NotFoundError();
  if (t.id === user.id) throw new ValidationError("본인 계정은 비활성화할 수 없습니다.");
  t.active = active;
  audit(data, user, { siteId: null, robotId: null, action: "USER:SET_ACTIVE", params: { targetId, active }, result: "OK", detail: null, vendorTraceId: null });
  return t;
}

export function setUserSitePermissions(user: User, targetId: string, siteIds: string[], allowedCommands: CommandType[]): User {
  const data = getStore();
  assertAdmin(user);
  const t = data.users.find((u) => u.id === targetId);
  if (!t) throw new NotFoundError();
  for (const s of siteIds) if (!data.sites.some((x) => x.id === s)) throw new ValidationError("존재하지 않는 사업장입니다.");
  // 제어 명령은 고객 제어 역할에만 의미가 있다. 고객 기본에는 부여하지 않는다.
  const cmds = t.role === "CUSTOMER_CONTROL" ? allowedCommands : [];
  t.sitePermissions = siteIds.map((siteId) => ({ siteId, allowedCommands: cmds }));
  audit(data, user, { siteId: null, robotId: null, action: "USER:SET_PERMISSIONS", params: { targetId, siteIds, allowedCommands: cmds }, result: "OK", detail: null, vendorTraceId: null });
  return t;
}

export function createUser(user: User, input: { name: string; email: string; role: Role; siteIds: string[]; allowedCommands: CommandType[] }): User {
  const data = getStore();
  assertAdmin(user);
  if (!input.name.trim() || !input.email.trim()) throw new ValidationError("이름과 이메일을 입력하세요.");
  if (data.users.some((u) => u.email === input.email.trim())) throw new ValidationError("같은 이메일의 사용자가 있습니다.");
  const u: User = {
    id: newId("u"),
    name: input.name.trim(),
    email: input.email.trim(),
    role: input.role,
    active: true,
    sitePermissions: input.siteIds.map((siteId) => ({ siteId, allowedCommands: input.role === "CUSTOMER_CONTROL" ? input.allowedCommands : [] })),
  };
  data.users.push(u);
  audit(data, user, { siteId: null, robotId: null, action: "USER:CREATE", params: { role: u.role, siteIds: input.siteIds }, result: "OK", detail: "샘플 — 실제 계정 발급·비밀번호는 2단계", vendorTraceId: null });
  return u;
}

export function addRecipient(user: User, siteId: string, r: Omit<NotificationRecipient, "id">): NotificationRecipient {
  const data = getStore();
  assertAdmin(user);
  const s = data.notificationSettings.find((n) => n.siteId === siteId);
  if (!s) throw new NotFoundError();
  if (!r.address.trim()) throw new ValidationError("수신 주소를 입력하세요.");
  const rec: NotificationRecipient = { id: newId("rcp"), ...r, address: r.address.trim() };
  s.recipients.push(rec);
  audit(data, user, { siteId, robotId: null, action: "NOTIFY:ADD_RECIPIENT", params: { channel: r.channel, minSeverity: r.minSeverity }, result: "OK", detail: null, vendorTraceId: null });
  return rec;
}

export function removeRecipient(user: User, siteId: string, recipientId: string): void {
  const data = getStore();
  assertAdmin(user);
  const s = data.notificationSettings.find((n) => n.siteId === siteId);
  if (!s) throw new NotFoundError();
  s.recipients = s.recipients.filter((x) => x.id !== recipientId);
  audit(data, user, { siteId, robotId: null, action: "NOTIFY:REMOVE_RECIPIENT", params: { recipientId }, result: "OK", detail: null, vendorTraceId: null });
}

export function updateNotificationThresholds(user: User, siteId: string, dedupeMinutes: number, escalateAfterMinutes: number): void {
  const data = getStore();
  assertAdmin(user);
  const s = data.notificationSettings.find((n) => n.siteId === siteId);
  if (!s) throw new NotFoundError();
  if (!(dedupeMinutes >= 0 && escalateAfterMinutes >= 0)) throw new ValidationError("분 단위 값은 0 이상이어야 합니다.");
  s.dedupeMinutes = dedupeMinutes;
  s.escalateAfterMinutes = escalateAfterMinutes;
  audit(data, user, { siteId, robotId: null, action: "NOTIFY:UPDATE_THRESHOLDS", params: { dedupeMinutes, escalateAfterMinutes }, result: "OK", detail: null, vendorTraceId: null });
}

/** 로봇 사업장 이동: 배치 이력을 닫고 새로 연다. 과거 실적은 당시 사업장에 남는다. */
export function relocateRobot(user: User, robotId: string, toSiteId: string, toFloorId: string): void {
  const data = getStore();
  assertAdmin(user);
  const robot = data.robots.find((r) => r.id === robotId);
  if (!robot) throw new NotFoundError();
  const floor = data.floors.find((f) => f.id === toFloorId && f.siteId === toSiteId);
  if (!floor) throw new ValidationError("이동할 사업장의 층을 선택하세요.");
  const st = data.statuses[robot.id];
  if (st && (st.common === "CLEANING" || st.common === "PAUSED")) throw new ValidationError("작업 중인 로봇은 이동 처리할 수 없습니다.");
  const now = nowIso();
  const open = data.placements.find((p) => p.robotId === robot.id && p.to === null);
  if (open) open.to = now;
  data.placements.push({ robotId: robot.id, siteId: toSiteId, from: now, to: null });
  const fromSite = robot.siteId;
  robot.siteId = toSiteId;
  robot.floorId = toFloorId;
  if (st) {
    st.mapVersionId = floor.currentMapVersionId;
    st.pose = null;
    st.poseIsLastKnown = true;
    st.progressPct = null;
    st.currentMissionId = null;
  }
  // 예정 회차(미래)는 새 사업장으로 이관하지 않고 취소 처리(계획 변경 이력 보존)
  for (const p of data.plannedRuns) {
    if (p.robotId === robot.id && p.status === "PLANNED" && p.plannedAt > now) {
      p.changeHistory.push({ at: now, by: user.id, from: p.status, to: "CANCELLED", reason: "로봇 사업장 이동" });
      p.status = "CANCELLED";
      p.reason = "로봇 사업장 이동";
    }
  }
  audit(data, user, { siteId: toSiteId, robotId: robot.id, action: "ROBOT:RELOCATE", params: { fromSiteId: fromSite, toSiteId, toFloorId }, result: "OK", detail: null, vendorTraceId: null });
}

export function setSiteManagerCanConfirm(user: User, value: boolean): void {
  const data = getStore();
  assertAdmin(user);
  data.settings.siteManagerCanConfirmReports = value;
  audit(data, user, { siteId: null, robotId: null, action: "SETTINGS:SITE_MANAGER_CONFIRM", params: { value }, result: "OK", detail: null, vendorTraceId: null });
}

export const SEVERITIES: Severity[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
