/**
 * 공통 조회 헬퍼. 서비스 계층이 반복해서 쓰는 단순 조회를 모아 둔다.
 * 도메인 타입과 DB 행이 1:1 이므로(시각은 ISO 문자열) 대부분 그대로 돌려준다.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, schema, type Db, type Tx } from "./client";
import type { Floor, Incident, MapVersion, Robot, RobotStatus, Site, User, Zone, NotificationSetting } from "@/lib/domain/types";

export type DbLike = Db | Tx;

export interface AppSettings {
  siteManagerCanConfirmReports: boolean;
  commandExpiryMinutes: number;
  commandAcceptedTimeoutSeconds: number;
  staleThresholdMinutes: number;
}

export async function loadSettings(db: DbLike = getDb()): Promise<AppSettings> {
  const row = await db.query.appSettings.findFirst({ where: eq(schema.appSettings.id, "default") });
  if (row) return row;
  // 설정 행이 없으면 기본값으로 생성한다(확정값이 아니라 운영 설정의 초기값).
  const [created] = await db.insert(schema.appSettings).values({ id: "default" }).onConflictDoNothing().returning();
  return created ?? { siteManagerCanConfirmReports: false, commandExpiryMinutes: 5, commandAcceptedTimeoutSeconds: 60, staleThresholdMinutes: 15 };
}

export async function allSiteIds(db: DbLike = getDb()): Promise<string[]> {
  const rows = await db.select({ id: schema.sites.id }).from(schema.sites).orderBy(schema.sites.id);
  return rows.map((r) => r.id);
}

export async function listSitesByIds(ids: string[], db: DbLike = getDb()): Promise<Site[]> {
  if (ids.length === 0) return [];
  return db.select().from(schema.sites).where(inArray(schema.sites.id, ids)).orderBy(schema.sites.id);
}

export async function getSite(id: string, db: DbLike = getDb()): Promise<Site | undefined> {
  return db.query.sites.findFirst({ where: eq(schema.sites.id, id) });
}

export async function getRobot(id: string, db: DbLike = getDb()): Promise<Robot | undefined> {
  return db.query.robots.findFirst({ where: eq(schema.robots.id, id) });
}

export async function getFloor(id: string, db: DbLike = getDb()): Promise<Floor | undefined> {
  return db.query.floors.findFirst({ where: eq(schema.floors.id, id) });
}

export async function getMapVersion(id: string, db: DbLike = getDb()): Promise<MapVersion | undefined> {
  const row = await db.query.mapVersions.findFirst({ where: eq(schema.mapVersions.id, id) });
  return row ? { ...row, corners: row.corners ?? null } : undefined;
}

export async function listZonesByFloor(floorId: string, db: DbLike = getDb()): Promise<Zone[]> {
  return db.select().from(schema.zones).where(eq(schema.zones.floorId, floorId)).orderBy(schema.zones.id);
}

export async function getStatus(robotId: string, db: DbLike = getDb()): Promise<RobotStatus | undefined> {
  const row = await db.query.robotStatus.findFirst({ where: eq(schema.robotStatus.robotId, robotId) });
  return row ? toStatus(row) : undefined;
}

export function toStatus(row: typeof schema.robotStatus.$inferSelect): RobotStatus {
  return {
    robotId: row.robotId,
    common: row.common,
    raw: row.raw,
    online: row.online,
    batteryPct: row.batteryPct,
    pose: row.pose ?? null,
    poseIsLastKnown: row.poseIsLastKnown,
    mapVersionId: row.mapVersionId,
    currentMissionId: row.currentMissionId,
    progressPct: row.progressPct,
    lastReceivedAt: row.lastReceivedAt,
    dataAt: row.dataAt,
  };
}

/** 사용자 + 사업장 권한. 비밀번호 해시 등 인증 전용 열은 포함하지 않는다. */
export async function getUser(id: string, db: DbLike = getDb()): Promise<User | undefined> {
  const u = await db.query.users.findFirst({ where: eq(schema.users.id, id) });
  if (!u) return undefined;
  const perms = await db.select().from(schema.sitePermissions).where(eq(schema.sitePermissions.userId, id));
  return { id: u.id, name: u.name, email: u.email, role: u.role, active: u.active, sitePermissions: perms.map((p) => ({ siteId: p.siteId, allowedCommands: p.allowedCommands })) };
}

export async function listUsers(db: DbLike = getDb()): Promise<User[]> {
  const rows = await db.select().from(schema.users).orderBy(schema.users.createdAt, schema.users.id);
  const perms = await db.select().from(schema.sitePermissions);
  return rows.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    active: u.active,
    sitePermissions: perms.filter((p) => p.userId === u.id).map((p) => ({ siteId: p.siteId, allowedCommands: p.allowedCommands })),
  }));
}

export async function getNotificationSetting(siteId: string, db: DbLike = getDb()): Promise<NotificationSetting | undefined> {
  const s = await db.query.notificationSettings.findFirst({ where: eq(schema.notificationSettings.siteId, siteId) });
  if (!s) return undefined;
  const recipients = await db.select().from(schema.notificationRecipients).where(eq(schema.notificationRecipients.siteId, siteId)).orderBy(schema.notificationRecipients.id);
  return { siteId, dedupeMinutes: s.dedupeMinutes, escalateAfterMinutes: s.escalateAfterMinutes, recipients: recipients.map(({ siteId: _s, ...r }) => r) };
}

/** 장애 + 조치 + 알림 기록을 도메인 객체로 조립한다. */
export async function assembleIncidents(rows: (typeof schema.incidents.$inferSelect)[], db: DbLike = getDb()): Promise<Incident[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const actions = await db.select().from(schema.incidentActions).where(inArray(schema.incidentActions.incidentId, ids)).orderBy(schema.incidentActions.at);
  const logs = await db.select().from(schema.notificationLogs).where(inArray(schema.notificationLogs.incidentId, ids)).orderBy(schema.notificationLogs.at);
  return rows.map((r) => ({
    id: r.id,
    siteId: r.siteId,
    robotId: r.robotId,
    code: r.code,
    severity: r.severity,
    rawMessage: r.rawMessage,
    customerMessage: r.customerMessage,
    occurredAt: r.occurredAt,
    status: r.status,
    acknowledgedAt: r.acknowledgedAt,
    assigneeId: r.assigneeId,
    resolvedAt: r.resolvedAt,
    vendorEventId: r.vendorEventId,
    occurrences: r.occurrences ?? 1,
    lastOccurredAt: r.lastOccurredAt ?? null,
    dismissedAt: r.dismissedAt ?? null,
    dismissedBy: r.dismissedBy ?? null,
    dismissReason: r.dismissReason ?? null,
    actions: actions.filter((a) => a.incidentId === r.id).map(({ incidentId: _i, ...a }) => a),
    notifications: logs.filter((n) => n.incidentId === r.id).map(({ incidentId: _i, ...n }) => n),
  }));
}

export async function getIncident(id: string, db: DbLike = getDb()): Promise<Incident | undefined> {
  const row = await db.query.incidents.findFirst({ where: eq(schema.incidents.id, id) });
  if (!row) return undefined;
  const [inc] = await assembleIncidents([row], db);
  return inc;
}

/** 로봇이 특정 시각에 속했던 사업장(배치 이력). */
export async function siteAt(robotId: string, atIso: string, db: DbLike = getDb()): Promise<string | undefined> {
  const rows = await db
    .select()
    .from(schema.robotPlacements)
    .where(and(eq(schema.robotPlacements.robotId, robotId), sql`${schema.robotPlacements.from} <= ${atIso}`, sql`(${schema.robotPlacements.to} is null or ${schema.robotPlacements.to} > ${atIso})`))
    .orderBy(desc(schema.robotPlacements.from))
    .limit(1);
  return rows[0]?.siteId;
}

export async function openPlacement(robotId: string, db: DbLike = getDb()) {
  return db.query.robotPlacements.findFirst({ where: and(eq(schema.robotPlacements.robotId, robotId), isNull(schema.robotPlacements.to)) });
}
