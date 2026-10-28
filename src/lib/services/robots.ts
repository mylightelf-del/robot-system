import type { Floor, Incident, Inspection, MaintenanceItem, MapVersion, Robot, RobotStatus, Site, User, Zone, Command, ActualRun, RobotPlacement } from "@/lib/domain/types";
import { accessibleSiteIds, assertActive, assertRobotAccess, assertSiteAccess, isCustomer, canCommand } from "@/lib/auth/authz";
import { getStore } from "@/lib/store/store";
import { getAdapter } from "@/lib/vendors";
import { nowIso } from "@/lib/util/time";
import { newId } from "@/lib/util/random";
import { ForbiddenError, NotFoundError } from "@/lib/util/errors";
import { audit } from "./audit";
import { sanitizeIncident, type IncidentView } from "./incidents";
import type { CommandType } from "@/lib/domain/types";

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

export function listRobots(user: User, siteId?: string): RobotRow[] {
  assertActive(user);
  const data = getStore();
  const siteIds = accessibleSiteIds(data, user);
  if (siteId) assertSiteAccess(data, user, siteId);
  return data.robots
    .filter((r) => siteIds.includes(r.siteId) && (!siteId || r.siteId === siteId))
    .map((r) => ({
      robot: toRobotView(r, user),
      status: data.statuses[r.id],
      site: data.sites.find((s) => s.id === r.siteId)!,
      floor: data.floors.find((f) => f.id === r.floorId)!,
    }));
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

export function getSiteView(user: User, siteId: string, floorId?: string): SiteView {
  const data = getStore();
  assertSiteAccess(data, user, siteId);
  const site = data.sites.find((s) => s.id === siteId)!;
  const floors = data.floors.filter((f) => f.siteId === siteId);
  const selectedFloor = floors.find((f) => f.id === floorId) ?? floors[0];
  const map = data.mapVersions.find((m) => m.id === selectedFloor.currentMapVersionId)!;
  const zones = data.zones.filter((z) => z.floorId === selectedFloor.id);
  const robots = listRobots(user, siteId).filter((r) => r.floor.id === selectedFloor.id);
  return { site, floors, selectedFloor, map, mapVersions: data.mapVersions.filter((m) => m.floorId === selectedFloor.id), zones, robots, now: nowIso() };
}

export interface RobotDetail {
  robot: RobotView;
  status: RobotStatus;
  site: Site;
  floor: Floor;
  map: MapVersion | null;
  mapMismatch: boolean;
  zones: Zone[];
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

export function getRobotDetail(user: User, robotId: string): RobotDetail {
  const data = getStore();
  const robot = assertRobotAccess(data, user, robotId);
  const status = data.statuses[robot.id];
  const site = data.sites.find((s) => s.id === robot.siteId)!;
  const floor = data.floors.find((f) => f.id === robot.floorId)!;
  const map = data.mapVersions.find((m) => m.id === floor.currentMapVersionId) ?? null;
  const customer = isCustomer(user);
  return {
    robot: toRobotView(robot, user),
    status,
    site,
    floor,
    map,
    mapMismatch: !!map && status.mapVersionId !== null && status.mapVersionId !== map.id,
    zones: data.zones.filter((z) => z.floorId === floor.id),
    runs: data.actualRuns.filter((r) => r.robotId === robot.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 30),
    incidents: data.incidents
      .filter((i) => i.robotId === robot.id)
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, 20)
      .map((i) => sanitizeIncident(i, user)),
    commands: customer ? [] : data.commands.filter((c) => c.robotId === robot.id).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)).slice(0, 20),
    inspections: data.inspections.filter((x) => x.robotId === robot.id).sort((a, b) => b.dueAt.localeCompare(a.dueAt)).slice(0, 12),
    maintenance: data.maintenance[robot.id] ?? [],
    placements: data.placements.filter((p) => p.robotId === robot.id).map((p) => ({ ...p, siteName: data.sites.find((s) => s.id === p.siteId)?.name ?? p.siteId })),
    allowedCommands: robot.supportedCommands.filter((c) => canCommand(data, user, robot.siteId, c)),
    isSimulation: getAdapter(robot).isSimulation,
    now: nowIso(),
  };
}

export function listSites(user: User): Site[] {
  const data = getStore();
  const ids = accessibleSiteIds(data, user);
  return data.sites.filter((s) => ids.includes(s.id));
}

export function completeInspection(user: User, inspectionId: string, note: string): Inspection {
  const data = getStore();
  assertActive(user);
  if (isCustomer(user)) throw new ForbiddenError("점검 기록은 현장/본사 담당자만 입력할 수 있습니다.");
  const insp = data.inspections.find((x) => x.id === inspectionId);
  if (!insp) throw new NotFoundError();
  assertSiteAccess(data, user, insp.siteId);
  insp.doneAt = nowIso();
  insp.doneBy = user.id;
  insp.note = note || "수기 기록";
  audit(data, user, { siteId: insp.siteId, robotId: insp.robotId, action: "INSPECTION:DONE", params: { inspectionId, item: insp.item }, result: "OK", detail: null, vendorTraceId: null });
  return insp;
}

export function addManualInspection(user: User, robotId: string, item: string): Inspection {
  const data = getStore();
  const robot = assertRobotAccess(data, user, robotId);
  if (isCustomer(user)) throw new ForbiddenError("점검 기록은 현장/본사 담당자만 입력할 수 있습니다.");
  const insp: Inspection = { id: newId("insp"), siteId: robot.siteId, robotId: robot.id, item, dueAt: nowIso(), doneAt: nowIso(), doneBy: user.id, note: "수기 기록" };
  data.inspections.unshift(insp);
  audit(data, user, { siteId: robot.siteId, robotId: robot.id, action: "INSPECTION:MANUAL", params: { item }, result: "OK", detail: null, vendorTraceId: null });
  return insp;
}

export type { Incident };
