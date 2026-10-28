import { beforeEach, describe, expect, it } from "vitest";
import { resetStore, getStore } from "@/lib/store/store";
import { computeAggregates } from "@/lib/services/reportAggregates";
import { confirmReport, createDraft, getReport, publishReport, recomputeDraft, submitForReview, updateComments } from "@/lib/services/reports";
import { relocateRobot } from "@/lib/services/admin";
import { upsertActualRun } from "@/lib/store/data";
import { ForbiddenError, ValidationError } from "@/lib/util/errors";
import { addMinutes, localMonthKey, localToUtcIso, nowIso, shiftMonth } from "@/lib/util/time";
import type { User } from "@/lib/domain/types";

const user = (id: string): User => getStore().users.find((u) => u.id === id)!;
const prevMonth = () => shiftMonth(localMonthKey(nowIso()), -1);

describe("월간 보고서 집계 · 확정 스냅샷", () => {
  beforeEach(() => {
    resetStore();
  });

  it("분모 0 이면 계획 완료율은 null(해당 없음)", () => {
    const agg = computeAggregates(getStore(), "site-01", "2024-01", nowIso());
    expect(agg.validPlanned).toBe(0);
    expect(agg.completionRatePct).toBeNull();
    expect(agg.totalRuns).toBe(0);
  });

  it("즉시 지시 작업은 계획 완료율 분자에 섞이지 않고 별도 집계된다", () => {
    const agg = computeAggregates(getStore(), "site-01", prevMonth(), nowIso());
    expect(agg.adhocRuns).toBeGreaterThan(0);
    expect(agg.plannedCompleted).toBeLessThanOrEqual(agg.validPlanned);
    expect(agg.totalRuns).toBeGreaterThanOrEqual(agg.plannedCompleted + agg.adhocRuns);
  });

  it("물·세제 미제공(PUDU 만 있는 사업장)은 null 로 표시된다", () => {
    const data = getStore();
    // 사업장 4 의 L4(PW-R-016) 실적을 제거해 PUDU 만 남긴다
    data.actualRuns = data.actualRuns.filter((r) => !(r.siteId === "site-04" && r.robotId === "PW-R-016"));
    const agg = computeAggregates(data, "site-04", prevMonth(), nowIso());
    expect(agg.waterL).toBeNull();
    expect(agg.unsupportedMetrics.some((m) => m.includes("PUDU"))).toBe(true);
  });

  it("월 경계: 사업장 시간대 기준으로 월을 나눈다", () => {
    const data = getStore();
    const m = prevMonth();
    const next = shiftMonth(m, 1);
    const before = computeAggregates(data, "site-05", m, nowIso()).totalRuns;
    // 전월 마지막 날 23:30 KST 시작 = UTC 로는 같은 날 14:30 → 전월에 포함되어야 한다
    const lastDay = new Date(localToUtcIso(`${next}-01`, "00:00")).getTime() - 30 * 60_000;
    const startedAt = new Date(lastDay).toISOString();
    upsertActualRun(data, {
      id: "run-boundary",
      vendorRunId: "vrun-boundary",
      robotId: "PW-R-020",
      siteId: "site-05",
      floorId: "site-05-f1",
      taskId: null,
      zoneIds: ["site-05-f1-z1"],
      startedAt,
      endedAt: addMinutes(startedAt, 50),
      result: "COMPLETED",
      endReason: null,
      areaM2: 100,
      durationMin: 50,
      waterL: null,
      detergentMl: null,
      origin: "ADHOC",
      receivedAt: addMinutes(startedAt, 55),
    });
    expect(computeAggregates(data, "site-05", m, nowIso()).totalRuns).toBe(before + 1);
    expect(computeAggregates(data, "site-05", next, nowIso()).totalRuns).toBe(
      data.actualRuns.filter((r) => r.siteId === "site-05" && localMonthKey(r.startedAt) === next && r.receivedAt <= nowIso()).length,
    );
  });

  it("확정 보고서는 재집계·의견 수정이 불가하고, 늦은 실적은 새 버전으로만 반영된다", () => {
    const data = getStore();
    const hq = user("u-hq");
    const v1 = data.reports.find((r) => r.siteId === "site-01" && r.version === 1)!; // PUBLISHED
    const snapshotRuns = v1.aggregates.totalRuns;
    expect(() => recomputeDraft(hq, v1.id)).toThrow(ValidationError);
    expect(() => updateComments(hq, v1.id, { overallOpinion: "변경 시도" })).toThrow(ValidationError);
    // 늦게 수신한 실적이 1건 있다(샘플)
    const row = getReport(hq, v1.id);
    expect(row.lateRuns).toBeGreaterThanOrEqual(1);
    // 새 버전 작성 → v2 초안, v1 은 그대로
    const v2 = createDraft(user("u-site-a"), "site-01", v1.month);
    expect(v2.version).toBe(2);
    expect(v2.aggregates.totalRuns).toBeGreaterThan(snapshotRuns);
    expect(data.reports.find((r) => r.id === v1.id)!.aggregates.totalRuns).toBe(snapshotRuns);
    expect(data.reports.find((r) => r.id === v1.id)!.status).toBe("PUBLISHED");
  });

  it("흐름: 초안 → 검토 → 확정(본사만) → 고객 공개", () => {
    const data = getStore();
    const siteA = user("u-site-a");
    const hq = user("u-hq");
    const draft = data.reports.find((r) => r.siteId === "site-03" && r.status === "DRAFT")!;
    const siteB = user("u-site-b");
    expect(() => submitForReview(siteB, draft.id)).toThrow(ValidationError); // 종합 의견 없음
    updateComments(siteB, draft.id, { overallOpinion: "정상 운영" });
    submitForReview(siteB, draft.id);
    expect(() => confirmReport(siteB, draft.id)).toThrow(ForbiddenError); // 현장 담당자 확정 불가(설정 기본값)
    expect(() => confirmReport(siteA, draft.id)).toThrow(); // 타 사업장
    expect(() => publishReport(hq, draft.id)).toThrow(ValidationError); // 확정 전 공개 불가
    confirmReport(hq, draft.id);
    expect(draft.status).toBe("CONFIRMED");
    expect(() => getReport(user("u-cust-1"), draft.id)).toThrow(); // 고객 1 은 사업장 1
    publishReport(hq, draft.id);
    expect(draft.status).toBe("PUBLISHED");
    data.settings.siteManagerCanConfirmReports = true;
    expect(() => recomputeDraft(hq, draft.id)).toThrow(ValidationError);
  });

  it("로봇이 사업장을 이동해도 과거 실적은 이전 사업장에 남는다", () => {
    const data = getStore();
    const m = prevMonth();
    const beforeS1 = computeAggregates(data, "site-01", m, nowIso()).totalRuns;
    const beforeS2 = computeAggregates(data, "site-02", m, nowIso()).totalRuns;
    relocateRobot(user("u-hq"), "PW-R-003", "site-02", "site-02-f1"); // IDLE 로봇
    expect(data.robots.find((r) => r.id === "PW-R-003")!.siteId).toBe("site-02");
    expect(computeAggregates(data, "site-01", m, nowIso()).totalRuns).toBe(beforeS1);
    expect(computeAggregates(data, "site-02", m, nowIso()).totalRuns).toBe(beforeS2);
    // 샘플의 PW-R-012 도 전월 실적은 사업장 2 소속
    expect(data.actualRuns.filter((r) => r.robotId === "PW-R-012" && localMonthKey(r.startedAt) === m).every((r) => r.siteId === "site-02")).toBe(true);
  });
});
