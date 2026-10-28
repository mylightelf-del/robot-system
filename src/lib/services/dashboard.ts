import { and, eq, gte, inArray, ne } from "drizzle-orm";
import type { CommonStatus, User } from "@/lib/domain/types";
import { accessibleSiteIds, assertActive } from "@/lib/auth/authz";
import { getDb, schema } from "@/lib/db/client";
import { listSitesByIds, loadSettings } from "@/lib/db/repo";
import { localDateKey, localToUtcIso, nowIso } from "@/lib/util/time";

export interface SiteSummary {
  siteId: string;
  siteName: string;
  robotCount: number;
  byStatus: Record<CommonStatus, number>;
  todayRuns: number;
  todayAreaM2: number;
  todayCompleted: number;
  openIncidents: number;
  unacknowledgedIncidents: number;
  staleRobots: number; // 마지막 수신이 임계 초과
}

export interface DashboardData {
  sites: SiteSummary[];
  totals: Omit<SiteSummary, "siteId" | "siteName">;
  staleThresholdMinutes: number;
  now: string;
}

export const STATUS_KEYS: CommonStatus[] = ["CLEANING", "CHARGING", "IDLE", "PAUSED", "RETURNING", "ERROR", "OFFLINE", "UNKNOWN"];

function emptyByStatus(): Record<CommonStatus, number> {
  return { CLEANING: 0, CHARGING: 0, IDLE: 0, PAUSED: 0, RETURNING: 0, ERROR: 0, OFFLINE: 0, UNKNOWN: 0 };
}

/** 종합 대시보드: 사용자가 볼 수 있는 사업장만 집계한다. */
export async function getDashboard(user: User): Promise<DashboardData> {
  assertActive(user);
  const db = getDb();
  const now = nowIso();
  const settings = await loadSettings(db);
  const staleThresholdMinutes = settings.staleThresholdMinutes;
  const siteIds = await accessibleSiteIds(user, db);
  const sites = await listSitesByIds(siteIds, db);
  const summaries: SiteSummary[] = [];
  if (siteIds.length > 0) {
    const robots = await db
      .select({ r: schema.robots, st: schema.robotStatus })
      .from(schema.robots)
      .leftJoin(schema.robotStatus, eq(schema.robotStatus.robotId, schema.robots.id))
      .where(and(inArray(schema.robots.siteId, siteIds), eq(schema.robots.active, true)));
    // 당일 범위: 각 사업장 시간대의 오늘 00:00 중 가장 이른 시각부터 조회한 뒤 JS 에서 시간대별로 거른다.
    const earliest = sites.map((s) => localToUtcIso(localDateKey(now, s.timezone), "00:00", s.timezone)).sort()[0];
    const runs = await db.select().from(schema.actualRuns).where(and(inArray(schema.actualRuns.siteId, siteIds), gte(schema.actualRuns.startedAt, earliest)));
    const incidents = await db.select({ siteId: schema.incidents.siteId, status: schema.incidents.status }).from(schema.incidents).where(and(inArray(schema.incidents.siteId, siteIds), ne(schema.incidents.status, "RESOLVED")));

    for (const site of sites) {
      const byStatus = emptyByStatus();
      let stale = 0;
      let robotCount = 0;
      for (const { r, st } of robots) {
        if (r.siteId !== site.id) continue;
        robotCount += 1;
        byStatus[st?.common ?? "UNKNOWN"] += 1;
        if (!st?.lastReceivedAt || (new Date(now).getTime() - new Date(st.lastReceivedAt).getTime()) / 60000 > staleThresholdMinutes) stale += 1;
      }
      const today = localDateKey(now, site.timezone);
      const todayRuns = runs.filter((x) => x.siteId === site.id && localDateKey(x.startedAt, site.timezone) === today);
      const inc = incidents.filter((i) => i.siteId === site.id);
      summaries.push({
        siteId: site.id,
        siteName: site.name,
        robotCount,
        byStatus,
        todayRuns: todayRuns.length,
        todayAreaM2: Math.round(todayRuns.reduce((s, x) => s + x.areaM2, 0)),
        todayCompleted: todayRuns.filter((x) => x.result === "COMPLETED").length,
        openIncidents: inc.length,
        unacknowledgedIncidents: inc.filter((i) => i.status === "OPEN").length,
        staleRobots: stale,
      });
    }
  }
  const totals = summaries.reduce(
    (acc, s) => {
      acc.robotCount += s.robotCount;
      for (const k of STATUS_KEYS) acc.byStatus[k] += s.byStatus[k];
      acc.todayRuns += s.todayRuns;
      acc.todayAreaM2 += s.todayAreaM2;
      acc.todayCompleted += s.todayCompleted;
      acc.openIncidents += s.openIncidents;
      acc.unacknowledgedIncidents += s.unacknowledgedIncidents;
      acc.staleRobots += s.staleRobots;
      return acc;
    },
    { robotCount: 0, byStatus: emptyByStatus(), todayRuns: 0, todayAreaM2: 0, todayCompleted: 0, openIncidents: 0, unacknowledgedIncidents: 0, staleRobots: 0 },
  );
  return { sites: summaries, totals, staleThresholdMinutes, now };
}
