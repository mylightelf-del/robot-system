import type { CommonStatus, User } from "@/lib/domain/types";
import { accessibleSiteIds, assertActive } from "@/lib/auth/authz";
import { getStore } from "@/lib/store/store";
import { localDateKey, nowIso } from "@/lib/util/time";

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
export function getDashboard(user: User, staleThresholdMinutes = 15): DashboardData {
  assertActive(user);
  const data = getStore();
  const now = nowIso();
  const siteIds = accessibleSiteIds(data, user);
  const sites: SiteSummary[] = [];
  for (const siteId of siteIds) {
    const site = data.sites.find((s) => s.id === siteId)!;
    const robots = data.robots.filter((r) => r.siteId === siteId && r.active);
    const byStatus = emptyByStatus();
    let stale = 0;
    for (const r of robots) {
      const st = data.statuses[r.id];
      byStatus[st?.common ?? "UNKNOWN"] += 1;
      if (!st?.lastReceivedAt || (new Date(now).getTime() - new Date(st.lastReceivedAt).getTime()) / 60000 > staleThresholdMinutes) stale += 1;
    }
    const today = localDateKey(now, site.timezone);
    const todayRuns = data.actualRuns.filter((x) => x.siteId === siteId && localDateKey(x.startedAt, site.timezone) === today);
    const incidents = data.incidents.filter((i) => i.siteId === siteId && i.status !== "RESOLVED");
    sites.push({
      siteId,
      siteName: site.name,
      robotCount: robots.length,
      byStatus,
      todayRuns: todayRuns.length,
      todayAreaM2: Math.round(todayRuns.reduce((s, x) => s + x.areaM2, 0)),
      todayCompleted: todayRuns.filter((x) => x.result === "COMPLETED").length,
      openIncidents: incidents.length,
      unacknowledgedIncidents: incidents.filter((i) => i.status === "OPEN").length,
      staleRobots: stale,
    });
  }
  const totals = sites.reduce(
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
  return { sites, totals, staleThresholdMinutes, now };
}
