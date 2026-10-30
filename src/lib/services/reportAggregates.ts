import type { ActualRun, Floor, Incident, Inspection, MapVersion, PlannedRun, RegisteredTask, ReportAggregates, Robot, RobotPlacement, Schedule, Severity, Site, Zone } from "@/lib/domain/types";
import { RUN_RESULT_LABEL } from "@/lib/domain/status";
import { addDays, type ReportPeriod } from "@/lib/reports/schedule";
import { localDateKey } from "@/lib/util/time";

/** 집계에 필요한 입력. 메모리 샘플(StoreData)과 DB 로더(reportData.ts) 모두 이 형태를 만든다. */
export interface AggregateInput {
  sites: Site[];
  floors: Floor[];
  zones: Zone[];
  robots: Robot[];
  placements: RobotPlacement[];
  actualRuns: ActualRun[];
  plannedRuns: PlannedRun[];
  incidents: Incident[];
  inspections: Inspection[];
  /** 설치 완료보고서의 구성 스냅샷용(없으면 해당 표가 비어 있다). */
  mapVersions?: MapVersion[];
  tasks?: RegisteredTask[];
  schedules?: Schedule[];
}

const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];
const RUN_LIST_MAX = 200;

/**
 * 보고서 자동 집계(설치·일간·주간·월간 공통). 기간은 사업장 시간대의 날짜(periodStart~periodEnd, 끝 포함).
 *
 * - 작업은 시작 시각, 계획은 예정 시각, 장애는 발생 시각의 현지 날짜로 기간에 넣는다.
 * - asOf 이전에 수신한 실적만 포함한다. 확정 스냅샷은 이 시각으로 고정되고, 이후 수신분은 "늦은 실적"으로 분리한다.
 * - 계획 완료율 = 정상 완료된 계획 회차 / 유효 계획 회차 × 100. 분모 0 이면 null(해당 없음).
 * - 즉시 지시(ADHOC/REMOTE)는 별도 집계. 누적 청소 면적은 중복 포함.
 * - 물·세제는 값이 제공된 실적만 합산하고, 전부 미제공이면 null.
 */
export function computeAggregates(data: AggregateInput, siteId: string, period: ReportPeriod, asOf: string): ReportAggregates {
  const site = data.sites.find((s) => s.id === siteId);
  if (!site) throw new Error("사업장을 찾을 수 없습니다.");
  const tz = site.timezone;
  const { periodStart, periodEnd } = period;
  const inPeriod = (iso: string) => {
    const k = localDateKey(iso, tz);
    return k >= periodStart && k <= periodEnd;
  };

  const runs = data.actualRuns.filter((r) => r.siteId === siteId && inPeriod(r.startedAt) && r.receivedAt <= asOf);
  const planned = data.plannedRuns.filter((p) => p.siteId === siteId && inPeriod(p.plannedAt));

  const validPlanned = planned.filter((p) => p.status !== "CANCELLED" && p.status !== "EXCLUDED" && !(p.status === "PLANNED" && p.plannedAt > asOf));
  const runById = new Map(runs.map((r) => [r.id, r]));
  const plannedCompleted = validPlanned.filter((p) => p.status === "DONE" && p.actualRunId && runById.get(p.actualRunId)?.result === "COMPLETED");
  const completionRatePct = validPlanned.length === 0 ? null : Math.round((plannedCompleted.length / validPlanned.length) * 1000) / 10;

  const sum = (arr: ActualRun[], f: (r: ActualRun) => number) => arr.reduce((s, r) => s + f(r), 0);
  const waterRuns = runs.filter((r) => r.waterL !== null);
  const detRuns = runs.filter((r) => r.detergentMl !== null);

  const floors = data.floors.filter((f) => f.siteId === siteId);
  const floorName = (id: string) => floors.find((f) => f.id === id)?.name ?? id;
  const byFloor = floors.map((f) => {
    const fr = runs.filter((r) => r.floorId === f.id);
    return { floorId: f.id, floorName: f.name, runs: fr.length, areaM2: Math.round(sum(fr, (r) => r.areaM2)), durationMin: Math.round(sum(fr, (r) => r.durationMin)) };
  });

  const zones = data.zones.filter((z) => floors.some((f) => f.id === z.floorId));
  const byZone = zones.map((z) => {
    const zr = runs.filter((r) => r.zoneIds.includes(z.id));
    // 구역별 면적은 작업 면적을 구역 수로 균등 배분한 근사치. 제조사 API 가 구역별 면적을 주면 그 값을 사용한다.
    const areaM2 = Math.round(zr.reduce((s, r) => s + r.areaM2 / Math.max(1, r.zoneIds.length), 0));
    return { zoneId: z.id, zoneName: z.name, floorName: floorName(z.floorId), runs: zr.length, areaM2 };
  });

  const robotName = (id: string) => data.robots.find((r) => r.id === id)?.name ?? id;
  const robotIds = Array.from(new Set(runs.map((r) => r.robotId)));
  const byRobot = robotIds.map((rid) => {
    const robot = data.robots.find((r) => r.id === rid);
    const rr = runs.filter((r) => r.robotId === rid);
    return {
      robotId: rid,
      name: robot?.name ?? rid,
      model: robot ? `${robot.vendor} ${robot.model}` : "-",
      runs: rr.length,
      completed: rr.filter((r) => r.result === "COMPLETED").length,
      areaM2: Math.round(sum(rr, (r) => r.areaM2)),
    };
  });

  // 일자별(주간·월간)
  const byDay: ReportAggregates["byDay"] = [];
  if (period.kind === "WEEKLY" || period.kind === "MONTHLY") {
    for (let d = periodStart; d <= periodEnd; d = addDays(d, 1)) {
      const dr = runs.filter((r) => localDateKey(r.startedAt, tz) === d);
      byDay.push({ date: d, runs: dr.length, completed: dr.filter((r) => r.result === "COMPLETED").length, areaM2: Math.round(sum(dr, (r) => r.areaM2)), durationMin: Math.round(sum(dr, (r) => r.durationMin)) });
    }
  }

  // 작업 목록(일간·설치)
  const runList: ReportAggregates["runList"] =
    period.kind === "DAILY" || period.kind === "INSTALLATION"
      ? [...runs]
          .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
          .slice(0, RUN_LIST_MAX)
          .map((r) => ({ startedAt: r.startedAt, robotName: robotName(r.robotId), floorName: floorName(r.floorId), origin: r.origin, result: RUN_RESULT_LABEL[r.result], areaM2: Math.round(r.areaM2), durationMin: Math.round(r.durationMin) }))
      : undefined;

  const incidents = data.incidents
    .filter((i) => i.siteId === siteId && inPeriod(i.occurredAt) && i.occurredAt <= asOf)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    .map((i) => ({
      id: i.id,
      code: i.code,
      severity: i.severity as Severity,
      occurredAt: i.occurredAt,
      resolvedAt: i.resolvedAt,
      customerMessage: i.customerMessage,
      // 고객 보고서에는 외부 공개 조치만 요약한다.
      actionSummary: i.actions.filter((a) => !a.internal).map((a) => a.note).join(" / ") || "(조치 요약 없음)",
    }));

  const inspPeriod = data.inspections.filter((x) => x.siteId === siteId && inPeriod(x.dueAt) && x.dueAt <= asOf);
  const inspItems = Array.from(new Set(inspPeriod.map((x) => x.item)));
  const inspections = inspItems.map((item) => ({
    item,
    done: inspPeriod.filter((x) => x.item === item && x.doneAt !== null).length,
    total: inspPeriod.filter((x) => x.item === item).length,
  }));

  // 데이터 미수신 일자: 계획이 있었는데 전부 미실행(MISSED)인 날.
  const dayKeys = Array.from(new Set(planned.filter((p) => p.plannedAt <= asOf).map((p) => localDateKey(p.plannedAt, tz)))).sort();
  const dataGapDays = dayKeys.filter((d) => {
    const dayPlanned = planned.filter((p) => localDateKey(p.plannedAt, tz) === d && p.status !== "EXCLUDED" && p.status !== "CANCELLED");
    if (dayPlanned.length === 0) return false;
    return dayPlanned.every((p) => p.status === "MISSED");
  });

  const unsupportedMetrics: string[] = [];
  const vendorsInPeriod = Array.from(new Set(runs.map((r) => data.robots.find((x) => x.id === r.robotId)?.vendor)));
  if (vendorsInPeriod.includes("PUDU")) unsupportedMetrics.push("PUDU 모델 물(L)·세제(mL) 사용량: API 제공 여부 미검증 — 미제공으로 표시");
  if (waterRuns.length === 0) unsupportedMetrics.push("물 사용량(L): 이 기간 제공 데이터 없음");
  if (detRuns.length === 0) unsupportedMetrics.push("세제 사용량(mL): 이 기간 제공 데이터 없음");
  unsupportedMetrics.push("고유 청소 면적: 제공하지 않음(누적 면적은 반복 구역 포함)");
  unsupportedMetrics.push("청결 품질·인건비 절감액: 청소 면적만으로 단정하지 않음");

  // 기간과 겹치는 배치(로봇 단위 중복 제거)
  const robotCount = new Set(
    data.placements
      .filter((p) => p.siteId === siteId && localDateKey(p.from, tz) <= periodEnd && (p.to === null || localDateKey(p.to, tz) >= periodStart))
      .map((p) => p.robotId),
  ).size;

  const latestReceived = runs.reduce((m, r) => (r.receivedAt > m ? r.receivedAt : m), "");

  return {
    generatedAt: asOf,
    siteName: site.name,
    periodStart,
    periodEnd,
    robotCount,
    validPlanned: validPlanned.length,
    plannedCompleted: plannedCompleted.length,
    completionRatePct,
    cancelled: planned.filter((p) => p.status === "CANCELLED").length,
    excluded: planned.filter((p) => p.status === "EXCLUDED").length,
    missed: planned.filter((p) => p.status === "MISSED").length,
    adhocRuns: runs.filter((r) => r.origin !== "PLANNED").length,
    totalRuns: runs.length,
    cumulativeAreaM2: Math.round(sum(runs, (r) => r.areaM2)),
    totalDurationMin: Math.round(sum(runs, (r) => r.durationMin)),
    waterL: waterRuns.length ? Math.round(sum(waterRuns, (r) => r.waterL ?? 0) * 10) / 10 : null,
    detergentMl: detRuns.length ? Math.round(sum(detRuns, (r) => r.detergentMl ?? 0)) : null,
    byFloor,
    byZone,
    byRobot,
    ...(byDay.length ? { byDay } : {}),
    ...(runList ? { runList } : {}),
    ...(period.kind === "INSTALLATION" ? { installation: installationSnapshot(data, site, floors, zones, periodStart) } : {}),
    incidents,
    inspections,
    dataGapDays,
    unsupportedMetrics,
    includesRunsReceivedUntil: latestReceived || asOf,
  };
}

/** 설치 완료보고서: 집계 시점의 사업장 구성(배치 로봇·층·지도·구역·등록 작업·예약). 확정하면 이 스냅샷이 고정된다. */
function installationSnapshot(data: AggregateInput, site: Site, floors: Floor[], zones: Zone[], installedOn: string): NonNullable<ReportAggregates["installation"]> {
  const floorName = (id: string) => floors.find((f) => f.id === id)?.name ?? "-";
  const robots = data.robots
    .filter((r) => r.siteId === site.id && r.active)
    .sort((a, b) => a.name.localeCompare(b.name, "ko"))
    .map((r) => ({ name: r.name, model: `${r.vendor} ${r.model}`, floorName: floorName(r.floorId) }));
  const floorRows = floors.map((f) => {
    const mv = data.mapVersions?.find((m) => m.id === f.currentMapVersionId);
    return {
      name: f.name,
      mapVersion: mv?.version ?? null,
      mapSource: !mv ? "미등록" : mv.vendor ? `${mv.vendor} 지도` : "자체 등록",
      zones: zones.filter((z) => z.floorId === f.id).length,
    };
  });
  const siteTasks = (data.tasks ?? []).filter((t) => t.siteId === site.id);
  const tasks = siteTasks.map((t) => ({ name: t.name, robotName: data.robots.find((r) => r.id === t.robotId)?.name ?? t.robotId, zones: t.zoneIds.length }));
  const schedules = (data.schedules ?? [])
    .filter((s) => siteTasks.some((t) => t.id === s.taskId))
    .map((s) => ({
      taskName: siteTasks.find((t) => t.id === s.taskId)?.name ?? s.taskId,
      days: [...s.daysOfWeek].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAY_NAMES[d]).join(""),
      time: s.time,
      enabled: s.enabled,
    }));
  // 층별 지도와 청소 구역(제조사 지도에 등록된 구역 = 청소 범위)
  const maps = floors
    .map((f) => {
      const mv = data.mapVersions?.find((m) => m.id === f.currentMapVersionId);
      const fz = zones.filter((z) => z.floorId === f.id);
      if (!mv || (fz.length === 0 && !mv.imageUrl)) return null;
      return { floorId: f.id, floorName: f.name, mapVersionId: mv.id, hasImage: !!mv.imageUrl, widthPx: mv.widthPx, heightPx: mv.heightPx, zones: fz.map((z) => ({ name: z.name, polygon: z.polygon, areaM2: Math.round(z.areaM2) })) };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);
  // 주간 예약 타임라인: 사용 중인 예약, 소요 시간은 그 작업의 최근 실적 평균(없으면 미정)
  const weekly = (data.schedules ?? [])
    .filter((s) => s.enabled && siteTasks.some((t) => t.id === s.taskId))
    .map((s) => {
      const task = siteTasks.find((t) => t.id === s.taskId)!;
      const robot = data.robots.find((r) => r.id === task.robotId);
      const runs = data.actualRuns
        .filter((r) => r.taskId === task.id && r.durationMin > 0)
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .slice(-20);
      const durationMin = runs.length ? Math.round(runs.reduce((a, r) => a + r.durationMin, 0) / runs.length) : null;
      return { robotName: robot?.name ?? task.robotId, taskName: task.name, floorName: robot ? floorName(robot.floorId) : "-", daysOfWeek: [...s.daysOfWeek].sort(), time: s.time, durationMin };
    })
    .sort((a, b) => a.time.localeCompare(b.time) || a.robotName.localeCompare(b.robotName, "ko"));
  return { installedOn, robots, floors: floorRows, tasks, schedules, maps, weekly };
}
