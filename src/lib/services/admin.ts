import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import type { CommandType, NotificationRecipient, Role, Severity, User } from "@/lib/domain/types";
import { assertActive, assertAdmin } from "@/lib/auth/authz";
import { destroyUserSessions } from "@/lib/auth/session";
import { hashPassword, randomToken } from "@/lib/auth/password";
import { getDb, schema } from "@/lib/db/client";
import { getNotificationSetting, getRobot, getStatus, listUsers, loadSettings, openPlacement } from "@/lib/db/repo";
import { NotFoundError, ValidationError } from "@/lib/util/errors";
import { newId } from "@/lib/util/random";
import { addMinutes, nowIso } from "@/lib/util/time";
import { audit } from "./audit";

const INVITE_HOURS = 72;

/** 관리 설정 화면 데이터(본사 관리자 전용). */
export async function getAdminData(user: User) {
  assertActive(user);
  assertAdmin(user);
  const db = getDb();
  const sites = await db.select().from(schema.sites).orderBy(schema.sites.id);
  const settingsRows = await db.select().from(schema.notificationSettings);
  const notificationSettings = [];
  for (const s of settingsRows) notificationSettings.push((await getNotificationSetting(s.siteId, db))!);
  const userRows = await db.select({ id: schema.users.id, inviteToken: schema.users.inviteToken, inviteExpiresAt: schema.users.inviteExpiresAt, passwordHash: schema.users.passwordHash, lastLoginAt: schema.users.lastLoginAt }).from(schema.users);
  return {
    sites,
    floors: await db.select().from(schema.floors).orderBy(schema.floors.id),
    zones: await db.select().from(schema.zones).orderBy(schema.zones.id),
    mapVersions: (await db.select().from(schema.mapVersions)).map((m) => ({ ...m, corners: m.corners ?? null })),
    robots: await db.select().from(schema.robots).orderBy(schema.robots.id),
    placements: await db.select().from(schema.robotPlacements),
    users: await listUsers(db),
    userAuth: userRows.map((u) => ({ id: u.id, hasPassword: !!u.passwordHash, inviteLink: u.inviteToken && u.inviteExpiresAt && u.inviteExpiresAt > nowIso() ? inviteUrl(u.inviteToken) : null, lastLoginAt: u.lastLoginAt })),
    notificationSettings,
    vendorConnections: await db.select().from(schema.vendorConnections).orderBy(schema.vendorConnections.id),
    settings: await loadSettings(db),
    audit: await db.select().from(schema.auditLogs).orderBy(desc(schema.auditLogs.at)).limit(50),
    allowSampleReset: process.env.ALLOW_SAMPLE_RESET === "true",
  };
}

export function inviteUrl(token: string): string {
  const base = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${base}/invite/${token}`;
}

export async function setUserActive(user: User, targetId: string, active: boolean): Promise<void> {
  const db = getDb();
  assertAdmin(user);
  const t = await db.query.users.findFirst({ where: eq(schema.users.id, targetId) });
  if (!t) throw new NotFoundError();
  if (t.id === user.id) throw new ValidationError("본인 계정은 비활성화할 수 없습니다.");
  await db.update(schema.users).set({ active }).where(eq(schema.users.id, targetId));
  if (!active) await destroyUserSessions(targetId); // 비활성화 즉시 모든 세션 종료
  await audit(user, { siteId: null, robotId: null, action: "USER:SET_ACTIVE", params: { targetId, active }, result: "OK", detail: active ? null : "세션 전부 종료", vendorTraceId: null }, db);
}

export async function setUserSitePermissions(user: User, targetId: string, siteIds: string[], allowedCommands: CommandType[]): Promise<void> {
  const db = getDb();
  assertAdmin(user);
  const t = await db.query.users.findFirst({ where: eq(schema.users.id, targetId) });
  if (!t) throw new NotFoundError();
  const known = siteIds.length ? await db.select({ id: schema.sites.id }).from(schema.sites).where(inArray(schema.sites.id, siteIds)) : [];
  if (known.length !== new Set(siteIds).size) throw new ValidationError("존재하지 않는 사업장이 있습니다.");
  // 제어 명령은 고객 제어 역할에만 의미가 있다. 고객 기본에는 부여하지 않는다.
  const cmds = t.role === "CUSTOMER_CONTROL" ? allowedCommands : [];
  await db.transaction(async (tx) => {
    await tx.delete(schema.sitePermissions).where(eq(schema.sitePermissions.userId, targetId));
    if (siteIds.length) await tx.insert(schema.sitePermissions).values(siteIds.map((siteId) => ({ userId: targetId, siteId, allowedCommands: cmds })));
    await audit(user, { siteId: null, robotId: null, action: "USER:SET_PERMISSIONS", params: { targetId, siteIds, allowedCommands: cmds }, result: "OK", detail: null, vendorTraceId: null }, tx);
  });
}

/** 사용자 등록 → 초대 링크 발급. 비밀번호는 초대 링크에서 본인이 설정한다. */
export async function createUser(user: User, input: { name: string; email: string; role: Role; siteIds: string[]; allowedCommands: CommandType[] }): Promise<{ user: User; inviteLink: string }> {
  const db = getDb();
  assertAdmin(user);
  const email = input.email.trim().toLowerCase();
  if (!input.name.trim() || !email) throw new ValidationError("이름과 이메일을 입력하세요.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ValidationError("이메일 형식이 올바르지 않습니다.");
  if (await db.query.users.findFirst({ where: eq(schema.users.email, email) })) throw new ValidationError("같은 이메일의 사용자가 있습니다.");
  const now = nowIso();
  const token = randomToken(24);
  const u: User = {
    id: newId("u"),
    name: input.name.trim(),
    email,
    role: input.role,
    active: true,
    sitePermissions: input.siteIds.map((siteId) => ({ siteId, allowedCommands: input.role === "CUSTOMER_CONTROL" ? input.allowedCommands : [] })),
  };
  await db.transaction(async (tx) => {
    await tx.insert(schema.users).values({ id: u.id, name: u.name, email: u.email, role: u.role, active: true, passwordHash: null, inviteToken: token, inviteExpiresAt: addMinutes(now, INVITE_HOURS * 60), createdAt: now });
    if (u.sitePermissions.length) await tx.insert(schema.sitePermissions).values(u.sitePermissions.map((p) => ({ userId: u.id, siteId: p.siteId, allowedCommands: p.allowedCommands })));
    await audit(user, { siteId: null, robotId: null, action: "USER:CREATE", params: { role: u.role, siteIds: input.siteIds }, result: "OK", detail: `초대 링크 발급(${INVITE_HOURS}시간 유효)`, vendorTraceId: null }, tx);
  });
  return { user: u, inviteLink: inviteUrl(token) };
}

/** 초대 링크 재발급(비밀번호 재설정에도 사용). 기존 세션은 모두 종료한다. */
export async function reissueInvite(user: User, targetId: string): Promise<string> {
  const db = getDb();
  assertAdmin(user);
  const t = await db.query.users.findFirst({ where: eq(schema.users.id, targetId) });
  if (!t) throw new NotFoundError();
  const token = randomToken(24);
  await db.update(schema.users).set({ inviteToken: token, inviteExpiresAt: addMinutes(nowIso(), INVITE_HOURS * 60) }).where(eq(schema.users.id, targetId));
  await destroyUserSessions(targetId);
  await audit(user, { siteId: null, robotId: null, action: "USER:REISSUE_INVITE", params: { targetId }, result: "OK", detail: "세션 전부 종료", vendorTraceId: null }, db);
  return inviteUrl(token);
}

export async function addRecipient(user: User, siteId: string, r: Omit<NotificationRecipient, "id">): Promise<void> {
  const db = getDb();
  assertAdmin(user);
  const s = await db.query.notificationSettings.findFirst({ where: eq(schema.notificationSettings.siteId, siteId) });
  if (!s) throw new NotFoundError();
  if (!r.address.trim()) throw new ValidationError("수신 주소를 입력하세요.");
  await db.insert(schema.notificationRecipients).values({ id: newId("rcp"), siteId, ...r, address: r.address.trim() });
  await audit(user, { siteId, robotId: null, action: "NOTIFY:ADD_RECIPIENT", params: { channel: r.channel, minSeverity: r.minSeverity }, result: "OK", detail: null, vendorTraceId: null }, db);
}

export async function removeRecipient(user: User, siteId: string, recipientId: string): Promise<void> {
  const db = getDb();
  assertAdmin(user);
  await db.delete(schema.notificationRecipients).where(and(eq(schema.notificationRecipients.id, recipientId), eq(schema.notificationRecipients.siteId, siteId)));
  await audit(user, { siteId, robotId: null, action: "NOTIFY:REMOVE_RECIPIENT", params: { recipientId }, result: "OK", detail: null, vendorTraceId: null }, db);
}

export async function updateNotificationThresholds(user: User, siteId: string, dedupeMinutes: number, escalateAfterMinutes: number): Promise<void> {
  const db = getDb();
  assertAdmin(user);
  if (!(dedupeMinutes >= 0 && escalateAfterMinutes >= 0)) throw new ValidationError("분 단위 값은 0 이상이어야 합니다.");
  const res = await db.update(schema.notificationSettings).set({ dedupeMinutes, escalateAfterMinutes }).where(eq(schema.notificationSettings.siteId, siteId)).returning();
  if (!res.length) throw new NotFoundError();
  await audit(user, { siteId, robotId: null, action: "NOTIFY:UPDATE_THRESHOLDS", params: { dedupeMinutes, escalateAfterMinutes }, result: "OK", detail: null, vendorTraceId: null }, db);
}

/** 로봇 사업장 이동: 배치 이력을 닫고 새로 연다. 과거 실적은 당시 사업장에 남는다. */
export async function relocateRobot(user: User, robotId: string, toSiteId: string, toFloorId: string): Promise<void> {
  const db = getDb();
  assertAdmin(user);
  const robot = await getRobot(robotId, db);
  if (!robot) throw new NotFoundError();
  const floor = await db.query.floors.findFirst({ where: and(eq(schema.floors.id, toFloorId), eq(schema.floors.siteId, toSiteId)) });
  if (!floor) throw new ValidationError("이동할 사업장의 층을 선택하세요.");
  const st = await getStatus(robot.id, db);
  if (st && (st.common === "CLEANING" || st.common === "PAUSED")) throw new ValidationError("작업 중인 로봇은 이동 처리할 수 없습니다.");
  const now = nowIso();
  await db.transaction(async (tx) => {
    const open = await openPlacement(robot.id, tx);
    if (open) await tx.update(schema.robotPlacements).set({ to: now }).where(eq(schema.robotPlacements.id, open.id));
    await tx.insert(schema.robotPlacements).values({ id: newId("plc"), robotId: robot.id, siteId: toSiteId, from: now, to: null });
    await tx.update(schema.robots).set({ siteId: toSiteId, floorId: toFloorId }).where(eq(schema.robots.id, robot.id));
    await tx.update(schema.robotStatus).set({ mapVersionId: floor.currentMapVersionId, pose: null, poseIsLastKnown: true, progressPct: null, currentMissionId: null }).where(eq(schema.robotStatus.robotId, robot.id));
    // 예정 회차(미래)는 새 사업장으로 이관하지 않고 취소 처리(계획 변경 이력 보존)
    const future = await tx.select().from(schema.plannedRuns).where(and(eq(schema.plannedRuns.robotId, robot.id), eq(schema.plannedRuns.status, "PLANNED"), gt(schema.plannedRuns.plannedAt, now)));
    for (const p of future) {
      await tx
        .update(schema.plannedRuns)
        .set({ status: "CANCELLED", reason: "로봇 사업장 이동", changeHistory: [...p.changeHistory, { at: now, by: user.id, from: p.status, to: "CANCELLED", reason: "로봇 사업장 이동" }] })
        .where(eq(schema.plannedRuns.id, p.id));
    }
    await audit(user, { siteId: toSiteId, robotId: robot.id, action: "ROBOT:RELOCATE", params: { fromSiteId: robot.siteId, toSiteId, toFloorId }, result: "OK", detail: null, vendorTraceId: null }, tx);
  });
}

export async function setSiteManagerCanConfirm(user: User, value: boolean): Promise<void> {
  const db = getDb();
  assertAdmin(user);
  await loadSettings(db);
  await db.update(schema.appSettings).set({ siteManagerCanConfirmReports: value }).where(eq(schema.appSettings.id, "default"));
  await audit(user, { siteId: null, robotId: null, action: "SETTINGS:SITE_MANAGER_CONFIRM", params: { value }, result: "OK", detail: null, vendorTraceId: null }, db);
}

export const SEVERITIES: Severity[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

/** 초대 링크가 유효한(비밀번호 미설정) 계정 수 — 관리 화면 안내용. */
export async function countPendingInvites(): Promise<number> {
  const rows = await getDb().select({ id: schema.users.id }).from(schema.users).where(and(isNull(schema.users.passwordHash), gt(schema.users.inviteExpiresAt, nowIso())));
  return rows.length;
}

export { hashPassword };
