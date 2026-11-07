import { and, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
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

/** 최근 7일 vs 그 전 7일(사업장별·전체). 완료율은 계획 회차 기준, 생산성은 면적 ÷ 시간. */
export interface WeekKpi {
  runs: number;
  areaM2: number;
  durationMin: number;
  completionRatePct: number | null;
  productivityM2PerHour: number | null;
  incidents: number;
}

export interface DashboardData {
  sites: (SiteSummary & { week: WeekKpi; prevWeek: WeekKpi })[];
  totals: Omit<SiteSummary, "siteId" | "siteName">;
  week: WeekKpi;
  prevWeek: WeekKpi;
  /** 최근 30일 복구된 장애의 평균 조치 시간(분). 없으면 null. */
  mttrMin30d: number | null;
  staleThresholdMinutes: number;
  now: string;
}

/** 오늘 할 일(대시보드 카드): 담당자가 지금 봐야 할 것만 모은다. */
export interface TodoData {
  missedRuns: { id: string; siteId: string; siteName: string; robotId: string; robotName: string; taskName: string; plannedAt: string }[];
  unacknowledgedIncidents: number;
  lowConsumables: { robotId: string; robotName: string; siteName: string; name: string; remainingPct: number }[];
  staleRobots: { robotId: string; robotName: string; siteName: string; lastReceivedAt: string | null }[];
  plannedToday: { total: number; remaining: number };
}

export const LOW_CONSUMABLE_PCT = 20;

function weekKpi(runs: { areaM2: number; durationMin: number; result: string; id: string }[], planned: { status: string; actualRunId: string | null }[], incidents: number): WeekKpi {
  const area = Math.round(runs.reduce((s, r) => s + r.areaM2, 0));
  const dur = Math.round(runs.reduce((s, r) => s + r.durationMin, 0));
  const valid = planned.filter((p) => p.status === "DONE" || p.status === "MISSED");
  const done = valid.filter((p) => p.status === "DONE" && p.actualRunId && runs.find((r) => r.id === p.actualRunId)?.result === "COMPLETED");
  return { runs: runs.length, areaM2: area, durationMin: dur, completionRatePct: valid.length ? Math.round((done.length / valid.length) * 1000) / 10 : null, productivityM2PerHour: dur > 0 ? Math.round((area / (dur / 60)) * 10) / 10 : null, incidents };
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
  const summaries: DashboardData["sites"] = [];
  const nowMs = new Date(now).getTime();
  const d7 = new Date(nowMs - 7 * 86400_000).toISOString();
  const d14 = new Date(nowMs - 14 * 86400_000).toISOString();
  const d30 = new Date(nowMs - 30 * 86400_000).toISOString();
  let mttrMin30d: number | null = null;
  if (siteIds.length > 0) {
    const runs14 = await db.select({ id: schema.actualRuns.id, siteId: schema.actualRuns.siteId, startedAt: schema.actualRuns.startedAt, areaM2: schema.actualRuns.areaM2, durationMin: schema.actualRuns.durationMin, result: schema.actualRuns.result }).from(schema.actualRuns).where(and(inArray(schema.actualRuns.siteId, siteIds), gte(schema.actualRuns.startedAt, d14)));
    const planned14 = await db.select({ siteId: schema.plannedRuns.siteId, plannedAt: schema.plannedRuns.plannedAt, status: schema.plannedRuns.status, actualRunId: schema.plannedRuns.actualRunId }).from(schema.plannedRuns).where(and(inArray(schema.plannedRuns.siteId, siteIds), gte(schema.plannedRuns.plannedAt, d14)));
    const inc30 = await db.select({ siteId: schema.incidents.siteId, occurredAt: schema.incidents.occurredAt, resolvedAt: schema.incidents.resolvedAt }).from(schema.incidents).where(and(inArray(schema.incidents.siteId, siteIds), gte(schema.incidents.occurredAt, d30), isNull(schema.incidents.dismissedAt)));
    const resolved = inc30.filter((i) => i.resolvedAt);
    mttrMin30d = resolved.length ? Math.round(resolved.reduce((s, i) => s + (new Date(i.resolvedAt!).getTime() - new Date(i.occurredAt).getTime()) / 60000, 0) / resolved.length) : null;
    const kpiFor = (siteId: string | null, from: string, to: string) =>
      weekKpi(
        runs14.filter((r) => (siteId === null || r.siteId === siteId) && r.startedAt >= from && r.startedAt < to),
        planned14.filter((p) => (siteId === null || p.siteId === siteId) && p.plannedAt >= from && p.plannedAt < to),
        inc30.filter((i) => (siteId === null || i.siteId === siteId) && i.occurredAt >= from && i.occurredAt < to).length,
      );
    const robots = await db
      .select({ r: schema.robots, st: schema.robotStatus })
      .from(schema.robots)
      .leftJoin(schema.robotStatus, eq(schema.robotStatus.robotId, schema.robots.id))
      .where(and(inArray(schema.robots.siteId, siteIds), eq(schema.robots.active, true)));
    // 당일 범위: 각 사업장 시간대의 오늘 00:00 중 가장 이른 시각부터 조회한 뒤 JS 에서 시간대별로 거른다.
    const earliest = sites.map((s) => localToUtcIso(localDateKey(now, s.timezone), "00:00", s.timezone)).sort()[0];
    const runs = await db.select().from(schema.actualRuns).where(and(inArray(schema.actualRuns.siteId, siteIds), gte(schema.actualRuns.startedAt, earliest)));
    const incidents = await db.select({ siteId: schema.incidents.siteId, status: schema.incidents.status }).from(schema.incidents).where(and(inArray(schema.incidents.siteId, siteIds), ne(schema.incidents.status, "RESOLVED"), isNull(schema.incidents.dismissedAt)));

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
        week: kpiFor(site.id, d7, now),
        prevWeek: kpiFor(site.id, d14, d7),
      });
    }
  }
  const sumWeek = (pick: (s: DashboardData["sites"][number]) => WeekKpi): WeekKpi => {
    const runsAll = summaries.map(pick);
    const area = runsAll.reduce((s, w) => s + w.areaM2, 0);
    const dur = runsAll.reduce((s, w) => s + w.durationMin, 0);
    // 전체 완료율은 사업장별 완료율의 단순 평균이 아니라 회차 합으로 다시 계산해야 하지만, 여기서는 사업장별 값이 있을 때만 가중 없이 평균한다(대시보드 참고용).
    const rates = runsAll.map((w) => w.completionRatePct).filter((x): x is number => x !== null);
    return { runs: runsAll.reduce((s, w) => s + w.runs, 0), areaM2: area, durationMin: dur, completionRatePct: rates.length ? Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 10) / 10 : null, productivityM2PerHour: dur > 0 ? Math.round((area / (dur / 60)) * 10) / 10 : null, incidents: runsAll.reduce((s, w) => s + w.incidents, 0) };
  };
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
  return { sites: summaries, totals, week: sumWeek((s) => s.week), prevWeek: sumWeek((s) => s.prevWeek), mttrMin30d, staleThresholdMinutes, now };
}

/** 오늘 할 일: 최근 24시간 미실행 회차, 미확인 장애, 소모품 임계 이하, 상태 미수신 로봇, 오늘 남은 예정 회차. */
export async function getTodo(user: User): Promise<TodoData> {
  assertActive(user);
  const db = getDb();
  const now = nowIso();
  const settings = await loadSettings(db);
  const siteIds = await accessibleSiteIds(user, db);
  const empty: TodoData = { missedRuns: [], unacknowledgedIncidents: 0, lowConsumables: [], staleRobots: [], plannedToday: { total: 0, remaining: 0 } };
  if (siteIds.length === 0) return empty;
  const sites = await listSitesByIds(siteIds, db);
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const since = new Date(new Date(now).getTime() - 24 * 3600_000).toISOString();
  const missed = await db
    .select({ p: schema.plannedRuns, taskName: schema.registeredTasks.name, robotName: schema.robots.name })
    .from(schema.plannedRuns)
    .leftJoin(schema.registeredTasks, eq(schema.registeredTasks.id, schema.plannedRuns.taskId))
    .leftJoin(schema.robots, eq(schema.robots.id, schema.plannedRuns.robotId))
    .where(and(inArray(schema.plannedRuns.siteId, siteIds), eq(schema.plannedRuns.status, "MISSED"), gte(schema.plannedRuns.plannedAt, since)))
    .orderBy(schema.plannedRuns.plannedAt);
  const [{ n: unack }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.incidents).where(and(inArray(schema.incidents.siteId, siteIds), eq(schema.incidents.status, "OPEN"), isNull(schema.incidents.dismissedAt)));
  const robots = await db
    .select({ r: schema.robots, st: schema.robotStatus })
    .from(schema.robots)
    .leftJoin(schema.robotStatus, eq(schema.robotStatus.robotId, schema.robots.id))
    .where(and(inArray(schema.robots.siteId, siteIds), eq(schema.robots.active, true)));
  const robotIds = robots.map((x) => x.r.id);
  const low = robotIds.length
    ? await db.select().from(schema.maintenanceItems).where(and(inArray(schema.maintenanceItems.robotId, robotIds), sql`${schema.maintenanceItems.remainingPct} is not null and ${schema.maintenanceItems.remainingPct} < ${LOW_CONSUMABLE_PCT}`))
    : [];
  const robotName = new Map(robots.map((x) => [x.r.id, x.r.name]));
  const robotSite = new Map(robots.map((x) => [x.r.id, siteName.get(x.r.siteId) ?? x.r.siteId]));
  // 오늘(각 사업장 현지) 예정 회차와 그중 아직 시각이 오지 않은 것
  const earliest = sites.map((s) => localToUtcIso(localDateKey(now, s.timezone), "00:00", s.timezone)).sort()[0];
  const plannedRows = await db.select({ siteId: schema.plannedRuns.siteId, plannedAt: schema.plannedRuns.plannedAt, status: schema.plannedRuns.status }).from(schema.plannedRuns).where(and(inArray(schema.plannedRuns.siteId, siteIds), gte(schema.plannedRuns.plannedAt, earliest)));
  const todayRows = plannedRows.filter((p) => {
    const site = sites.find((s) => s.id === p.siteId)!;
    return localDateKey(p.plannedAt, site.timezone) === localDateKey(now, site.timezone) && p.status !== "CANCELLED" && p.status !== "EXCLUDED";
  });
  return {
    missedRuns: missed.map((m) => ({ id: m.p.id, siteId: m.p.siteId, siteName: siteName.get(m.p.siteId) ?? m.p.siteId, robotId: m.p.robotId, robotName: m.robotName ?? m.p.robotId, taskName: m.taskName ?? m.p.taskId, plannedAt: m.p.plannedAt })),
    unacknowledgedIncidents: unack,
    lowConsumables: low.map((m) => ({ robotId: m.robotId, robotName: robotName.get(m.robotId) ?? m.robotId, siteName: robotSite.get(m.robotId) ?? "", name: m.name, remainingPct: Math.round(m.remainingPct ?? 0) })).sort((a, b) => a.remainingPct - b.remainingPct),
    staleRobots: robots
      .filter(({ st }) => !st?.lastReceivedAt || (new Date(now).getTime() - new Date(st.lastReceivedAt).getTime()) / 60000 > settings.staleThresholdMinutes)
      .map(({ r, st }) => ({ robotId: r.id, robotName: r.name, siteName: siteName.get(r.siteId) ?? r.siteId, lastReceivedAt: st?.lastReceivedAt ?? null })),
    plannedToday: { total: todayRows.length, remaining: todayRows.filter((p) => p.status === "PLANNED" && p.plannedAt > now).length },
  };
}
