import { and, desc, eq, inArray } from "drizzle-orm";
import type { ActualRun, Command, CommandType, Floor, Inspection, MaintenanceItem, MapVersion, Robot, RobotPlacement, RobotStatus, Site, User, Zone } from "@/lib/domain/types";
import { accessibleSiteIds, assertActive, assertRobotAccess, assertSiteAccess, canCommandOf, isCustomer } from "@/lib/auth/authz";
import { getDb, schema } from "@/lib/db/client";
import { assembleIncidents, getFloor, getMapVersion, getSite, getStatus, listSitesByIds, listZonesByFloor, toStatus } from "@/lib/db/repo";
import { getAdapter } from "@/lib/vendors";
import { nowIso } from "@/lib/util/time";
import { newId } from "@/lib/util/random";
import { ForbiddenError, NotFoundError } from "@/lib/util/errors";
import { audit } from "./audit";
import { sanitizeIncident, type IncidentView } from "./incidents";

/** 고객에게 보여줄 수 있는 로봇 정보(내부 메모·제조사 ID 제외). */
export type RobotView = Omit<Robot, "internalNote" | "vendorRobotId"> & { internalNote?: string; vendorRobotId?: string };

export function toRobotView(robot: Robot, user: User): RobotView {
  if (isCustomer(user)) {
    const view: RobotView = { ...robot };
    delete view.internalNote;
    delete view.vendorRobotId;
    return view;
  }
  return robot;
}

export interface RobotRow {
  robot: RobotView;
  status: RobotStatus;
  site: Site;
  floor: Floor;
}

function unknownStatus(robotId: string): RobotStatus {
  return { robotId, common: "UNKNOWN", raw: "", online: false, batteryPct: null, pose: null, poseIsLastKnown: true, mapVersionId: null, currentMissionId: null, progressPct: null, lastReceivedAt: null, dataAt: null };
}

export async function listRobots(user: User, siteId?: string): Promise<RobotRow[]> {
  assertActive(user);
  const db = getDb();
  const siteIds = await accessibleSiteIds(user, db);
  if (siteId) await assertSiteAccess(user, siteId, db);
  const ids = siteId ? [siteId] : siteIds;
  if (ids.length === 0) return [];
  const rows = await db
    .select({ r: schema.robots, st: schema.robotStatus, site: schema.sites, floor: schema.floors })
    .from(schema.robots)
    .leftJoin(schema.robotStatus, eq(schema.robotStatus.robotId, schema.robots.id))
    .innerJoin(schema.sites, eq(schema.sites.id, schema.robots.siteId))
    .innerJoin(schema.floors, eq(schema.floors.id, schema.robots.floorId))
    .where(inArray(schema.robots.siteId, ids))
    .orderBy(schema.robots.id);
  return rows.map(({ r, st, site, floor }) => ({ robot: toRobotView(r, user), status: st ? toStatus(st) : unknownStatus(r.id), site, floor }));
}

export interface SiteView {
  site: Site;
  floors: Floor[];
  selectedFloor: Floor;
  map: MapVersion;
  mapVersions: MapVersion[];
  zones: Zone[];
  robots: RobotRow[];
  now: string;
}

export async function getSiteView(user: User, siteId: string, floorId?: string): Promise<SiteView> {
  const db = getDb();
  await assertSiteAccess(user, siteId, db);
  const site = await getSite(siteId, db);
  if (!site) throw new NotFoundError();
  const floors = await db.select().from(schema.floors).where(eq(schema.floors.siteId, siteId)).orderBy(schema.floors.id);
  const selectedFloor = floors.find((f) => f.id === floorId) ?? floors[0];
  if (!selectedFloor) throw new NotFoundError("층 정보가 없습니다.");
  const map = await getMapVersion(selectedFloor.currentMapVersionId, db);
  if (!map) throw new NotFoundError("지도 정보가 없습니다.");
  const zones = await listZonesByFloor(selectedFloor.id, db);
  const mapVersions = (await db.select().from(schema.mapVersions).where(eq(schema.mapVersions.floorId, selectedFloor.id))).map((m) => ({ ...m, corners: m.corners ?? null }));
  const robots = (await listRobots(user, siteId)).filter((r) => r.floor.id === selectedFloor.id);
  return { site, floors, selectedFloor, map, mapVersions, zones, robots, now: nowIso() };
}

export interface RobotDetail {
  robot: RobotView;
  status: RobotStatus;
  site: Site;
  floor: Floor;
  map: MapVersion | null;
  mapMismatch: boolean;
  zones: Zone[];
  tasks: { id: string; name: string }[];
  runs: ActualRun[];
  incidents: IncidentView[];
  commands: Command[];
  inspections: Inspection[];
  maintenance: MaintenanceItem[];
  placements: (RobotPlacement & { siteName: string })[];
  allowedCommands: CommandType[]; // 이 사용자가 이 로봇에 내릴 수 있는 명령
  isSimulation: boolean;
  now: string;
}

export async function getRobotDetail(user: User, robotId: string): Promise<RobotDetail> {
  const db = getDb();
  const robot = await assertRobotAccess(user, robotId, db);
  const status = (await getStatus(robot.id, db)) ?? unknownStatus(robot.id);
  const site = (await getSite(robot.siteId, db))!;
  const floor = (await getFloor(robot.floorId, db))!;
  const map = (await getMapVersion(floor.currentMapVersionId, db)) ?? null;
  const customer = isCustomer(user);
  const accessible = await accessibleSiteIds(user, db);
  const incidentRows = await db.select().from(schema.incidents).where(eq(schema.incidents.robotId, robot.id)).orderBy(desc(schema.incidents.occurredAt)).limit(20);
  const incidents = await assembleIncidents(incidentRows, db);
  const placements = await db.select().from(schema.robotPlacements).where(eq(schema.robotPlacements.robotId, robot.id)).orderBy(schema.robotPlacements.from);
  const siteNames = new Map((await listSitesByIds(Array.from(new Set(placements.map((p) => p.siteId))), db)).map((s) => [s.id, s.name]));
  return {
    robot: toRobotView(robot, user),
    status,
    site,
    floor,
    map,
    mapMismatch: !!map && status.mapVersionId !== null && status.mapVersionId !== map.id,
    zones: await listZonesByFloor(floor.id, db),
    tasks: await db.select({ id: schema.registeredTasks.id, name: schema.registeredTasks.name }).from(schema.registeredTasks).where(eq(schema.registeredTasks.robotId, robot.id)).orderBy(schema.registeredTasks.id),
    runs: await db.select().from(schema.actualRuns).where(eq(schema.actualRuns.robotId, robot.id)).orderBy(desc(schema.actualRuns.startedAt)).limit(30),
    incidents: incidents.map((i) => sanitizeIncident(i, user, { siteName: site.name, robotName: robot.name, assigneeName: null })),
    commands: customer ? [] : await db.select().from(schema.commands).where(eq(schema.commands.robotId, robot.id)).orderBy(desc(schema.commands.requestedAt)).limit(20),
    inspections: await db.select().from(schema.inspections).where(eq(schema.inspections.robotId, robot.id)).orderBy(desc(schema.inspections.dueAt)).limit(12),
    maintenance: (await db.select().from(schema.maintenanceItems).where(eq(schema.maintenanceItems.robotId, robot.id)).orderBy(schema.maintenanceItems.id)).map(({ name, remainingPct, source }) => ({ name, remainingPct, source })),
    placements: placements.map((p) => ({ robotId: p.robotId, siteId: p.siteId, from: p.from, to: p.to, siteName: siteNames.get(p.siteId) ?? p.siteId })),
    allowedCommands: robot.supportedCommands.filter((c) => canCommandOf(user, accessible, robot.siteId, c)),
    isSimulation: getAdapter(robot).isSimulation,
    now: nowIso(),
  };
}

export async function listSites(user: User): Promise<Site[]> {
  const db = getDb();
  return listSitesByIds(await accessibleSiteIds(user, db), db);
}

export async function completeInspection(user: User, inspectionId: string, note: string): Promise<Inspection> {
  const db = getDb();
  assertActive(user);
  if (isCustomer(user)) throw new ForbiddenError("점검 기록은 현장/본사 담당자만 입력할 수 있습니다.");
  const insp = await db.query.inspections.findFirst({ where: eq(schema.inspections.id, inspectionId) });
  if (!insp) throw new NotFoundError();
  await assertSiteAccess(user, insp.siteId, db);
  const [updated] = await db
    .update(schema.inspections)
    .set({ doneAt: nowIso(), doneBy: user.id, note: note || "수기 기록" })
    .where(eq(schema.inspections.id, inspectionId))
    .returning();
  await audit(user, { siteId: insp.siteId, robotId: insp.robotId, action: "INSPECTION:DONE", params: { inspectionId, item: insp.item }, result: "OK", detail: null, vendorTraceId: null }, db);
  return updated;
}

export async function addManualInspection(user: User, robotId: string, item: string): Promise<Inspection> {
  const db = getDb();
  const robot = await assertRobotAccess(user, robotId, db);
  if (isCustomer(user)) throw new ForbiddenError("점검 기록은 현장/본사 담당자만 입력할 수 있습니다.");
  const insp: Inspection = { id: newId("insp"), siteId: robot.siteId, robotId: robot.id, item, dueAt: nowIso(), doneAt: nowIso(), doneBy: user.id, note: "수기 기록" };
  await db.insert(schema.inspections).values(insp);
  await audit(user, { siteId: robot.siteId, robotId: robot.id, action: "INSPECTION:MANUAL", params: { item }, result: "OK", detail: null, vendorTraceId: null }, db);
  return insp;
}

/** 관리 화면 등에서 쓰는 단순 목록. */
export async function listAllRobotsInSites(siteIds: string[]): Promise<Robot[]> {
  if (siteIds.length === 0) return [];
  return getDb().select().from(schema.robots).where(and(inArray(schema.robots.siteId, siteIds))).orderBy(schema.robots.id);
}

/** 사업장들의 전체 구역(작업 등록 화면용). */
export async function listZonesInSites(siteIds: string[]): Promise<Zone[]> {
  if (siteIds.length === 0) return [];
  const db = getDb();
  const floors = await db.select({ id: schema.floors.id }).from(schema.floors).where(inArray(schema.floors.siteId, siteIds));
  if (floors.length === 0) return [];
  return db.select().from(schema.zones).where(inArray(schema.zones.floorId, floors.map((f) => f.id))).orderBy(schema.zones.id);
}
