import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { addDays, calendarMonthPeriod, monthAnniversary, periodKey, reportSchedule, reportTitle } from "@/lib/reports/schedule";
import { autoCreateScheduledDrafts, createDraft, getReportSchedule } from "@/lib/services/reports";
import { computeAggregates } from "@/lib/services/reportAggregates";
import { loadAggregateInput } from "@/lib/services/reportData";
import { updateSite } from "@/lib/services/sites";
import { ForbiddenError, ValidationError } from "@/lib/util/errors";
import { addMinutes, localDateKey, localToUtcIso, nowIso } from "@/lib/util/time";
import { getDb, resetAndSeed, schema, user } from "./helpers";

const brief = (installedOn: string, until: string) => reportSchedule(installedOn, until).map((e) => `${reportTitle(e)} ${e.periodStart}~${e.periodEnd} @${e.draftOn}`);

describe("보고서 일정 규칙(설치일 기준)", () => {
  it("설치 → 일간 D+1~D+6 → 주간 D+7·14·21 → 월간(차월 같은 날짜)", () => {
    expect(brief("2026-10-15", "2026-12-16")).toEqual([
      "설치 완료보고서 2026-10-15~2026-10-15 @2026-10-15",
      "일간보고서 D+1 2026-10-16~2026-10-16 @2026-10-17",
      "일간보고서 D+2 2026-10-17~2026-10-17 @2026-10-18",
      "일간보고서 D+3 2026-10-18~2026-10-18 @2026-10-19",
      "일간보고서 D+4 2026-10-19~2026-10-19 @2026-10-20",
      "일간보고서 D+5 2026-10-20~2026-10-20 @2026-10-21",
      "일간보고서 D+6 2026-10-21~2026-10-21 @2026-10-22",
      "주간보고서 1주차 2026-10-16~2026-10-22 @2026-10-23",
      "주간보고서 2주차 2026-10-23~2026-10-29 @2026-10-30",
      "주간보고서 3주차 2026-10-30~2026-11-05 @2026-11-06",
      "월간보고서 1개월차 2026-10-16~2026-11-15 @2026-11-16",
      "월간보고서 2개월차 2026-11-16~2026-12-15 @2026-12-16",
    ]);
  });

  it("설치일이 없는 날짜의 달은 말일로 당긴다(31일·윤년)", () => {
    expect(monthAnniversary("2027-01-31", 1)).toBe("2027-02-28");
    expect(monthAnniversary("2028-01-31", 1)).toBe("2028-02-29");
    expect(monthAnniversary("2027-01-31", 2)).toBe("2027-03-31");
    const months = reportSchedule("2027-01-31", "2027-06-01").filter((e) => e.kind === "MONTHLY");
    expect(months.map((m) => `${m.periodStart}~${m.periodEnd}`)).toEqual(["2027-02-01~2027-02-28", "2027-03-01~2027-03-31", "2027-04-01~2027-04-30", "2027-05-01~2027-05-31"]);
  });

  it("월간 기간은 빈틈·겹침 없이 이어지고 1개월차는 D+1 부터다(29·30·31일 설치 포함)", () => {
    for (const d of ["2026-01-29", "2026-01-30", "2026-01-31", "2026-02-28", "2026-12-31", "2026-06-15"]) {
      const months = reportSchedule(d, addDays(d, 800)).filter((e) => e.kind === "MONTHLY");
      expect(months.length).toBeGreaterThanOrEqual(24);
      expect(months[0].periodStart).toBe(addDays(d, 1));
      for (let i = 1; i < months.length; i++) expect(months[i].periodStart).toBe(addDays(months[i - 1].periodEnd, 1));
    }
  });

  it("기간 키", () => {
    expect(periodKey(reportSchedule("2026-10-15", "2026-10-15")[0])).toBe("INSTALLATION:2026-10-15~2026-10-15");
    expect(periodKey(calendarMonthPeriod("2026-02"))).toBe("MONTHLY:2026-02-01~2026-02-28");
  });
});

describe("보고서 일정 (DB)", () => {
  const db = () => getDb();
  const today = () => localDateKey(nowIso());

  beforeEach(async () => {
    await resetAndSeed();
  });

  async function freshSite(installedOn: string) {
    await db().delete(schema.reportVersions).where(eq(schema.reportVersions.siteId, "site-04"));
    await updateSite(await user("u-hq"), "site-04", { installedOn });
  }

  it("자동 작성: 최근 7일 안에 작성일이 된 일정만, 한 번만 만든다", async () => {
    const installedOn = addDays(today(), -10);
    await freshSite(installedOn);
    const now = localToUtcIso(today(), "07:00");
    const r1 = await autoCreateScheduledDrafts(now);
    const mine = r1.created.filter((id) => id.startsWith("rpt-site-04-"));
    const expected = reportSchedule(installedOn, today()).filter((e) => e.draftOn >= addDays(today(), -7));
    expect(mine.length).toBe(expected.length);
    const rows = await db().select().from(schema.reportVersions).where(eq(schema.reportVersions.siteId, "site-04"));
    expect(rows.every((r) => r.status === "DRAFT" && r.createdBy === "system")).toBe(true);
    expect(rows.some((r) => r.kind === "INSTALLATION")).toBe(false); // 설치일(10일 전)은 7일 범위 밖
    const r2 = await autoCreateScheduledDrafts(now);
    expect(r2.created.filter((id) => id.startsWith("rpt-site-04-")).length).toBe(0);
    const audit = await db().select().from(schema.auditLogs).where(and(eq(schema.auditLogs.siteId, "site-04"), eq(schema.auditLogs.action, "REPORT:CREATE_DRAFT")));
    expect(audit.length).toBe(expected.length);
    expect(audit.every((a) => a.userId === "system")).toBe(true);
  });

  it("자동 작성: 설치 완료보고서는 설치 당일 바로, 일간은 다음 날 06시 이후", async () => {
    await freshSite(today());
    const early = localToUtcIso(today(), "01:00");
    const c1 = (await autoCreateScheduledDrafts(early)).created.filter((id) => id.startsWith("rpt-site-04-"));
    expect(c1.length).toBe(1);
    expect(c1[0]).toContain("-installation-");
    const inst = await db().query.reportVersions.findFirst({ where: and(eq(schema.reportVersions.siteId, "site-04"), eq(schema.reportVersions.kind, "INSTALLATION")) });
    expect(inst!.aggregates.installation!.robots.length).toBeGreaterThan(0);
    expect(inst!.aggregates.installation!.floors.length).toBeGreaterThan(0);
    // 다음 날 05시: D+1 일간은 아직, 07시: 작성
    const tomorrow = addDays(today(), 1);
    expect((await autoCreateScheduledDrafts(localToUtcIso(tomorrow, "05:00"))).created.filter((id) => id.startsWith("rpt-site-04-")).length).toBe(0);
    // D+1 의 다음 날(D+2) 07시에 D+1 일간이 만들어진다
    const d2 = addDays(today(), 2);
    const c3 = (await autoCreateScheduledDrafts(localToUtcIso(d2, "07:00"))).created.filter((id) => id.startsWith("rpt-site-04-"));
    expect(c3.length).toBe(1);
    expect(c3[0]).toContain(`-daily-${tomorrow}-${tomorrow}-`);
  });

  it("수동 작성: 일정에 있고 시작된 기간만, 담당자만", async () => {
    const installedOn = addDays(today(), -3);
    await freshSite(installedOn);
    const hq = await user("u-hq");
    const sched = reportSchedule(installedOn, addDays(today(), 40));
    const d1 = sched.find((e) => e.kind === "DAILY" && e.seq === 1)!;
    const w1 = sched.find((e) => e.kind === "WEEKLY" && e.seq === 1)!; // 진행 중(시작됨)
    const d5 = sched.find((e) => e.kind === "DAILY" && e.seq === 5)!; // 미래
    const r = await createDraft(hq, "site-04", periodKey(d1));
    expect(r.kind).toBe("DAILY");
    expect(r.seq).toBe(1);
    await expect(createDraft(hq, "site-04", periodKey(d1))).rejects.toThrow(ValidationError); // 작성 중 버전 중복
    expect((await createDraft(hq, "site-04", periodKey(w1))).kind).toBe("WEEKLY");
    await expect(createDraft(hq, "site-04", periodKey(d5))).rejects.toThrow(ValidationError);
    await expect(createDraft(hq, "site-04", `DAILY:${today()}~${addDays(today(), 1)}`)).rejects.toThrow(ValidationError); // 일정에 없음
    await expect(createDraft(await user("u-cust-1"), "site-01", periodKey(calendarMonthPeriod("2026-01")))).rejects.toThrow(ForbiddenError);
  });

  it("일정표: 상태(작성 필요·진행 중·예정)와 설치일 미등록", async () => {
    const installedOn = addDays(today(), -2);
    await freshSite(installedOn);
    const sc = await getReportSchedule(await user("u-hq"), "site-04", localToUtcIso(today(), "07:00"));
    const state = (title: string) => sc.rows.find((r) => r.title === title)?.state;
    expect(state("설치 완료보고서")).toBe("NEEDS_DRAFT");
    expect(state("일간보고서 D+1")).toBe("NEEDS_DRAFT");
    expect(state("일간보고서 D+2")).toBe("IN_PROGRESS"); // 오늘
    expect(state("일간보고서 D+3")).toBe("UPCOMING");
    await updateSite(await user("u-hq"), "site-04", { installedOn: null });
    const none = await getReportSchedule(await user("u-hq"), "site-04");
    expect(none.installedOn).toBeNull();
    expect(none.rows.length).toBe(0);
    await expect(updateSite(await user("u-hq"), "site-04", { installedOn: "2026-02-30" })).rejects.toThrow(ValidationError);
    await expect(getReportSchedule(await user("u-cust-1"), "site-01")).rejects.toThrow();
  });

  it("일간 집계는 사업장 날짜 경계(23:30 KST 시작은 그날)를 따른다", async () => {
    const day = addDays(today(), -1);
    const startedAt = new Date(new Date(localToUtcIso(addDays(day, 1), "00:00")).getTime() - 30 * 60_000).toISOString();
    await db().insert(schema.actualRuns).values({
      id: "run-day-boundary",
      vendor: "PUDU",
      vendorRobotId: "sample-pudu-pw-r-020",
      vendorRunId: "vrun-day-boundary",
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
    const input = await loadAggregateInput("site-05");
    const a = computeAggregates(input, "site-05", { kind: "DAILY", seq: 1, periodStart: day, periodEnd: day }, nowIso());
    const b = computeAggregates(input, "site-05", { kind: "DAILY", seq: 2, periodStart: addDays(day, 1), periodEnd: addDays(day, 1) }, nowIso());
    expect(a.runList!.some((r) => r.startedAt === startedAt)).toBe(true);
    expect(b.runList!.some((r) => r.startedAt === startedAt)).toBe(false);
    const w = computeAggregates(input, "site-05", { kind: "WEEKLY", seq: 1, periodStart: addDays(day, -6), periodEnd: day }, nowIso());
    expect(w.byDay!.length).toBe(7);
    expect(w.byDay!.reduce((s, d) => s + d.runs, 0)).toBe(w.totalRuns);
  });
});
