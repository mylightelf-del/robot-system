import type { ActualRun, Floor, Incident, Inspection, PlannedRun, ReportAggregates, Robot, RobotPlacement, Severity, Site, Zone } from "@/lib/domain/types";
import { localDateKey, localMonthKey } from "@/lib/util/time";

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
}

/**
 * 월간 보고서 자동 집계.
 *
 * - 월 경계는 사업장 시간대 기준(작업 시작 시각 / 예정 시각).
 * - asOf 이전에 수신한 실적만 포함한다. 확정 스냅샷은 이 시각으로 고정되고, 이후 수신분은 "늦은 실적"으로 분리한다.
 * - 계획 완료율 = 정상 완료된 계획 회차 / 유효 계획 회차 × 100. 분모 0 이면 null(해당 없음).
 * - 즉시 지시(ADHOC/REMOTE)는 별도 집계. 누적 청소 면적은 중복 포함.
 * - 물·세제는 값이 제공된 실적만 합산하고, 전부 미제공이면 null.
 */
export function computeAggregates(data: AggregateInput, siteId: string, month: string, asOf: string): ReportAggregates {
  const site = data.sites.find((s) => s.id === siteId);
  if (!site) throw new Error("사업장을 찾을 수 없습니다.");
  const tz = site.timezone;

  const runs = data.actualRuns.filter((r) => r.siteId === siteId && localMonthKey(r.startedAt, tz) === month && r.receivedAt <= asOf);
  const planned = data.plannedRuns.filter((p) => p.siteId === siteId && localMonthKey(p.plannedAt, tz) === month);

  const validPlanned = planned.filter((p) => p.status !== "CANCELLED" && p.status !== "EXCLUDED" && !(p.status === "PLANNED" && p.plannedAt > asOf));
  const runById = new Map(runs.map((r) => [r.id, r]));
  const plannedCompleted = validPlanned.filter((p) => p.status === "DONE" && p.actualRunId && runById.get(p.actualRunId)?.result === "COMPLETED");
  const completionRatePct = validPlanned.length === 0 ? null : Math.round((plannedCompleted.length / validPlanned.length) * 1000) / 10;

  const sum = (arr: ActualRun[], f: (r: ActualRun) => number) => arr.reduce((s, r) => s + f(r), 0);
  const waterRuns = runs.filter((r) => r.waterL !== null);
  const detRuns = runs.filter((r) => r.detergentMl !== null);

  const floors = data.floors.filter((f) => f.siteId === siteId);
  const byFloor = floors.map((f) => {
    const fr = runs.filter((r) => r.floorId === f.id);
    return { floorId: f.id, floorName: f.name, runs: fr.length, areaM2: Math.round(sum(fr, (r) => r.areaM2)), durationMin: Math.round(sum(fr, (r) => r.durationMin)) };
  });

  const zones = data.zones.filter((z) => floors.some((f) => f.id === z.floorId));
  const byZone = zones
    .map((z) => {
      const zr = runs.filter((r) => r.zoneIds.includes(z.id));
      const floorName = floors.find((f) => f.id === z.floorId)?.name ?? "";
      // 구역별 면적은 작업 면적을 구역 수로 균등 배분한 근사치(샘플). 제조사 API 가 구역별 면적을 주면 그 값을 사용한다.
      const areaM2 = Math.round(zr.reduce((s, r) => s + r.areaM2 / Math.max(1, r.zoneIds.length), 0));
      return { zoneId: z.id, zoneName: z.name, floorName, runs: zr.length, areaM2 };
    });

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

  const incidents = data.incidents
    .filter((i) => i.siteId === siteId && localMonthKey(i.occurredAt, tz) === month && i.occurredAt <= asOf)
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

  const inspMonth = data.inspections.filter((x) => x.siteId === siteId && localMonthKey(x.dueAt, tz) === month && x.dueAt <= asOf);
  const inspItems = Array.from(new Set(inspMonth.map((x) => x.item)));
  const inspections = inspItems.map((item) => ({
    item,
    done: inspMonth.filter((x) => x.item === item && x.doneAt !== null).length,
    total: inspMonth.filter((x) => x.item === item).length,
  }));

  // 데이터 미수신 일자: 계획이 있었는데 실적·수행 기록이 전혀 없는 날(샘플 정의). 실제 운영에서는 상태 수신 이력으로 판단한다.
  const dayKeys = Array.from(new Set(planned.filter((p) => p.plannedAt <= asOf).map((p) => localDateKey(p.plannedAt, tz)))).sort();
  const dataGapDays = dayKeys.filter((d) => {
    const dayPlanned = planned.filter((p) => localDateKey(p.plannedAt, tz) === d && p.status !== "EXCLUDED" && p.status !== "CANCELLED");
    if (dayPlanned.length === 0) return false;
    return dayPlanned.every((p) => p.status === "MISSED");
  });

  const unsupportedMetrics: string[] = [];
  const vendorsInMonth = Array.from(new Set(runs.map((r) => data.robots.find((x) => x.id === r.robotId)?.vendor)));
  if (vendorsInMonth.includes("PUDU")) unsupportedMetrics.push("PUDU 모델 물(L)·세제(mL) 사용량: API 제공 여부 미검증 — 미제공으로 표시");
  if (waterRuns.length === 0) unsupportedMetrics.push("물 사용량(L): 이번 달 제공 데이터 없음");
  if (detRuns.length === 0) unsupportedMetrics.push("세제 사용량(mL): 이번 달 제공 데이터 없음");
  unsupportedMetrics.push("고유 청소 면적: 제공하지 않음(누적 면적은 반복 구역 포함)");
  unsupportedMetrics.push("청결 품질·인건비 절감액: 청소 면적만으로 단정하지 않음");

  const robotCount = data.placements.filter((p) => p.siteId === siteId && localMonthKey(p.from, tz) <= month && (p.to === null || localMonthKey(p.to, tz) > month || localMonthKey(p.to, tz) === month)).length;

  const latestReceived = runs.reduce((m, r) => (r.receivedAt > m ? r.receivedAt : m), "");

  return {
    generatedAt: asOf,
    siteName: site.name,
    month,
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
    incidents,
    inspections,
    dataGapDays,
    unsupportedMetrics,
    includesRunsReceivedUntil: latestReceived || asOf,
  };
}
