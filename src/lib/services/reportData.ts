import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import { assembleIncidents, type DbLike } from "@/lib/db/repo";
import type { AggregateInput } from "./reportAggregates";

/** 보고서 집계 입력을 DB 에서 적재한다(해당 사업장 전체 기간, 20대 규모에서는 충분히 작다). */
export async function loadAggregateInput(siteId: string, db: DbLike = getDb()): Promise<AggregateInput> {
  const sites = await db.select().from(schema.sites).where(eq(schema.sites.id, siteId));
  const floors = await db.select().from(schema.floors).where(eq(schema.floors.siteId, siteId));
  const floorIds = floors.map((f) => f.id);
  const zones = floorIds.length ? await db.select().from(schema.zones).where(inArray(schema.zones.floorId, floorIds)) : [];
  const placements = await db.select().from(schema.robotPlacements).where(eq(schema.robotPlacements.siteId, siteId));
  const actualRuns = await db.select().from(schema.actualRuns).where(eq(schema.actualRuns.siteId, siteId));
  const robotIds = Array.from(new Set([...actualRuns.map((r) => r.robotId), ...placements.map((p) => p.robotId)]));
  const robots = robotIds.length ? await db.select().from(schema.robots).where(inArray(schema.robots.id, robotIds)) : [];
  const plannedRuns = await db.select().from(schema.plannedRuns).where(eq(schema.plannedRuns.siteId, siteId));
  const incidents = await assembleIncidents(await db.select().from(schema.incidents).where(and(eq(schema.incidents.siteId, siteId), isNull(schema.incidents.dismissedAt))), db);
  const inspections = await db.select().from(schema.inspections).where(eq(schema.inspections.siteId, siteId));
  const mapVersions = floorIds.length ? await db.select().from(schema.mapVersions).where(inArray(schema.mapVersions.floorId, floorIds)) : [];
  const tasks = await db.select().from(schema.registeredTasks).where(eq(schema.registeredTasks.siteId, siteId));
  const schedules = tasks.length ? await db.select().from(schema.schedules).where(inArray(schema.schedules.taskId, tasks.map((t) => t.id))) : [];
  return {
    sites,
    floors,
    zones,
    robots,
    placements: placements.map(({ id: _id, ...p }) => p),
    actualRuns: actualRuns.map(({ vendor: _v, vendorRobotId: _vr, rawPayload: _rp, ...r }) => r),
    plannedRuns,
    incidents,
    inspections,
    mapVersions,
    tasks,
    schedules,
  };
}
