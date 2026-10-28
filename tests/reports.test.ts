import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { computeAggregates } from "@/lib/services/reportAggregates";
import { loadAggregateInput } from "@/lib/services/reportData";
import { confirmReport, createDraft, getReport, publishReport, recomputeDraft, submitForReview, updateComments } from "@/lib/services/reports";
import { relocateRobot } from "@/lib/services/admin";
import { ForbiddenError, ValidationError } from "@/lib/util/errors";
import { addMinutes, localMonthKey, localToUtcIso, nowIso, shiftMonth } from "@/lib/util/time";
import { getDb, resetAndSeed, schema, user } from "./helpers";

const db = () => getDb();
const prevMonth = () => shiftMonth(localMonthKey(nowIso()), -1);
const agg = async (siteId: string, month: string) => computeAggregates(await loadAggregateInput(siteId), siteId, month, nowIso());

describe("월간 보고서 집계 · 확정 스냅샷 (DB)", () => {
  beforeEach(async () => {
    await resetAndSeed();
  });

  it("분모 0 이면 계획 완료율은 null(해당 없음)", async () => {
    const a = await agg("site-01", "2024-01");
    expect(a.validPlanned).toBe(0);
    expect(a.completionRatePct).toBeNull();
    expect(a.totalRuns).toBe(0);
  });

  it("즉시 지시 작업은 계획 완료율 분자에 섞이지 않고 별도 집계된다", async () => {
    const a = await agg("site-01", prevMonth());
    expect(a.adhocRuns).toBeGreaterThan(0);
    expect(a.plannedCompleted).toBeLessThanOrEqual(a.validPlanned);
    expect(a.totalRuns).toBeGreaterThanOrEqual(a.plannedCompleted + a.adhocRuns);
  });

  it("물·세제 미제공(PUDU 만 있는 사업장)은 null 로 표시된다", async () => {
    await db().delete(schema.actualRuns).where(and(eq(schema.actualRuns.siteId, "site-04"), eq(schema.actualRuns.robotId, "PW-R-016")));
    const a = await agg("site-04", prevMonth());
    expect(a.waterL).toBeNull();
    expect(a.unsupportedMetrics.some((m) => m.includes("PUDU"))).toBe(true);
  });

  it("월 경계: 사업장 시간대 기준으로 월을 나눈다", async () => {
    const m = prevMonth();
    const next = shiftMonth(m, 1);
    const before = (await agg("site-05", m)).totalRuns;
    const beforeNext = (await agg("site-05", next)).totalRuns;
    // 전월 마지막 날 23:30 KST 시작 = UTC 로는 같은 날 14:30 → 전월에 포함되어야 한다
    const startedAt = new Date(new Date(localToUtcIso(`${next}-01`, "00:00")).getTime() - 30 * 60_000).toISOString();
    await db().insert(schema.actualRuns).values({
      id: "run-boundary",
      vendor: "PUDU",
      vendorRobotId: "sample-pudu-pw-r-020",
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
    expect((await agg("site-05", m)).totalRuns).toBe(before + 1);
    expect((await agg("site-05", next)).totalRuns).toBe(beforeNext);
  });

  it("확정 보고서는 재집계·의견 수정이 불가하고, 늦은 실적은 새 버전으로만 반영된다", async () => {
    const hq = await user("u-hq");
    const v1 = (await db().select().from(schema.reportVersions).where(and(eq(schema.reportVersions.siteId, "site-01"), eq(schema.reportVersions.version, 1))))[0]; // PUBLISHED
    const snapshotRuns = v1.aggregates.totalRuns;
    await expect(recomputeDraft(hq, v1.id)).rejects.toThrow(ValidationError);
    await expect(updateComments(hq, v1.id, { overallOpinion: "변경 시도" })).rejects.toThrow(ValidationError);
    const row = await getReport(hq, v1.id);
    expect(row.lateRuns).toBeGreaterThanOrEqual(1);
    const v2 = await createDraft(await user("u-site-a"), "site-01", v1.month);
    expect(v2.version).toBe(2);
    expect(v2.aggregates.totalRuns).toBeGreaterThan(snapshotRuns);
    const v1After = (await db().query.reportVersions.findFirst({ where: eq(schema.reportVersions.id, v1.id) }))!;
    expect(v1After.aggregates.totalRuns).toBe(snapshotRuns);
    expect(v1After.status).toBe("PUBLISHED");
  });

  it("흐름: 초안 → 검토 → 확정(본사만) → 고객 공개", async () => {
    const siteA = await user("u-site-a");
    const siteB = await user("u-site-b");
    const hq = await user("u-hq");
    const draft = (await db().select().from(schema.reportVersions).where(and(eq(schema.reportVersions.siteId, "site-03"), eq(schema.reportVersions.status, "DRAFT"))))[0];
    await expect(submitForReview(siteB, draft.id)).rejects.toThrow(ValidationError); // 종합 의견 없음
    await updateComments(siteB, draft.id, { overallOpinion: "정상 운영" });
    await submitForReview(siteB, draft.id);
    await expect(confirmReport(siteB, draft.id)).rejects.toThrow(ForbiddenError); // 현장 담당자 확정 불가(설정 기본값)
    await expect(confirmReport(siteA, draft.id)).rejects.toThrow(); // 타 사업장
    await expect(publishReport(hq, draft.id)).rejects.toThrow(ValidationError); // 확정 전 공개 불가
    await confirmReport(hq, draft.id);
    expect((await db().query.reportVersions.findFirst({ where: eq(schema.reportVersions.id, draft.id) }))!.status).toBe("CONFIRMED");
    await expect(getReport(await user("u-cust-1"), draft.id)).rejects.toThrow(); // 고객 1 은 사업장 1
    await publishReport(hq, draft.id);
    expect((await db().query.reportVersions.findFirst({ where: eq(schema.reportVersions.id, draft.id) }))!.status).toBe("PUBLISHED");
    await expect(recomputeDraft(hq, draft.id)).rejects.toThrow(ValidationError);
  });

  it("로봇이 사업장을 이동해도 과거 실적은 이전 사업장에 남는다", async () => {
    const m = prevMonth();
    const beforeS1 = (await agg("site-01", m)).totalRuns;
    const beforeS2 = (await agg("site-02", m)).totalRuns;
    await relocateRobot(await user("u-hq"), "PW-R-003", "site-02", "site-02-f1"); // IDLE 로봇
    expect((await db().query.robots.findFirst({ where: eq(schema.robots.id, "PW-R-003") }))!.siteId).toBe("site-02");
    expect((await agg("site-01", m)).totalRuns).toBe(beforeS1);
    expect((await agg("site-02", m)).totalRuns).toBe(beforeS2);
    const r12 = await db().select().from(schema.actualRuns).where(eq(schema.actualRuns.robotId, "PW-R-012"));
    expect(r12.filter((r) => localMonthKey(r.startedAt) === m).every((r) => r.siteId === "site-02")).toBe(true);
  });
});
