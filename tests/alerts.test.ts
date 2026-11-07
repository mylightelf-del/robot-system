import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { setEmailSenderForTest, buildMime, type EmailAttachment } from "@/lib/notify/email";
import { notifyRecipients } from "@/lib/notify/notifier";
import { notifyMissedRuns, notifyNoActivity } from "@/lib/services/alerts";
import { addRecipient, updateNotificationThresholds, updateRecipient } from "@/lib/services/admin";
import { mySubscriptions, subscribeMe, unsubscribeMe, updateMySubscription } from "@/lib/services/notify";
import { confirmReport, createDraft, getReport, publishReport, submitForReview, updateComments } from "@/lib/services/reports";
import { sendReportNotifications } from "@/lib/services/reportNotify";
import { getDashboard, getTodo } from "@/lib/services/dashboard";
import { getNotificationSetting } from "@/lib/db/repo";
import { periodKey, reportSchedule } from "@/lib/reports/schedule";
import { localDateKey, nowIso } from "@/lib/util/time";
import { ValidationError } from "@/lib/util/errors";
import { getDb, resetAndSeed, schema, user } from "./helpers";

const db = () => getDb();
type Sent = { to: string; subject: string; text: string; attachments?: EmailAttachment[] };

describe("운영 알림(미실행·무실적)·보고서 발송·구독·KPI", () => {
  const saved = { ...process.env };
  const sent: Sent[] = [];
  beforeEach(async () => {
    await resetAndSeed();
    sent.length = 0;
    process.env.APP_BASE_URL = "https://widebot.example";
    Object.assign(process.env, { MAIL_MODE: "live", MAIL_FROM: "관제 <noreply@widebot.kro.kr>", SES_ACCESS_KEY_ID: "AKIA-TEST", SES_SECRET_ACCESS_KEY: "x" });
    setEmailSenderForTest(async (m) => {
      sent.push(m);
      return { messageId: "test-id" };
    });
  });
  afterAll(() => {
    process.env = saved;
    setEmailSenderForTest(null);
  });

  it("수신자 통보 종류(kinds): 종류가 빠진 수신자는 억제, 보고서는 시간대 무관", async () => {
    const hq = await user("u-hq");
    await db().delete(schema.notificationRecipients).where(eq(schema.notificationRecipients.siteId, "site-01"));
    await addRecipient(hq, "site-01", { channel: "EMAIL", address: "only-incident@example.com", minSeverity: "LOW", hoursFrom: "00:00", hoursTo: "23:59", kinds: ["INCIDENT"] });
    await addRecipient(hq, "site-01", { channel: "EMAIL", address: "night@example.com", minSeverity: "LOW", hoursFrom: "23:50", hoursTo: "23:51", kinds: ["REPORT", "MISSED_RUN"] });
    await expect(addRecipient(hq, "site-01", { channel: "EMAIL", address: "none@example.com", minSeverity: "LOW", hoursFrom: "00:00", hoursTo: "23:59", kinds: [] })).rejects.toThrow(ValidationError);
    const setting = await getNotificationSetting("site-01");
    const msg = async () => ({ subject: "s", title: "t", lines: ["a: b"], url: "https://x" });
    const l1 = await notifyRecipients(setting, "site-01", nowIso(), "Asia/Seoul", { kind: "MISSED_RUN", label: "예정 작업 미실행" }, msg);
    expect(l1.find((l) => l.recipient === "only-incident@example.com")?.status).toBe("SUPPRESSED");
    expect(l1.find((l) => l.recipient === "night@example.com")?.status).toBe("SUPPRESSED"); // 시간대 외
    const l2 = await notifyRecipients(setting, "site-01", nowIso(), "Asia/Seoul", { kind: "REPORT", label: "보고서 발행", applyHours: false }, msg);
    expect(l2.find((l) => l.recipient === "night@example.com")?.status).toBe("SENT"); // 보고서는 시간대 무관
    expect(l2.find((l) => l.recipient === "only-incident@example.com")?.status).toBe("SUPPRESSED");
    // 종류 변경
    const rid = (await db().query.notificationRecipients.findFirst({ where: eq(schema.notificationRecipients.address, "only-incident@example.com") }))!.id;
    await updateRecipient(hq, "site-01", rid, { kinds: ["INCIDENT", "MISSED_RUN"] });
    const l3 = await notifyRecipients(await getNotificationSetting("site-01"), "site-01", nowIso(), "Asia/Seoul", { kind: "MISSED_RUN", label: "x" }, msg);
    expect(l3.find((l) => l.recipient === "only-incident@example.com")?.status).toBe("SENT");
  });

  it("예정 작업 미실행 알림: 자동 판정 회차만, 한 번만, 사용 중지 로봇·사업장 제외", async () => {
    const hq = await user("u-hq");
    await db().delete(schema.notificationRecipients);
    await addRecipient(hq, "site-01", { channel: "EMAIL", address: "ops@example.com", minSeverity: "LOW", hoursFrom: "00:00", hoursTo: "23:59" });
    const now = nowIso();
    const recent = new Date(Date.now() - 2 * 3600_000).toISOString();
    // 샘플 MISSED 는 사람이 적은 사유(자동 판정 아님) → 대상 아님. 자동 판정 회차 2건을 만든다(site-01, site-02)
    const p1 = (await db().query.plannedRuns.findFirst({ where: eq(schema.plannedRuns.siteId, "site-01") }))!;
    const p2 = (await db().query.plannedRuns.findFirst({ where: eq(schema.plannedRuns.siteId, "site-02") }))!;
    await db().update(schema.plannedRuns).set({ status: "MISSED", reason: "예정 시각 ±90분 안에 실적 없음(자동 판정)", plannedAt: recent, actualRunId: null }).where(eq(schema.plannedRuns.id, p1.id));
    await db().update(schema.plannedRuns).set({ status: "MISSED", reason: "예정 시각 ±90분 안에 실적 없음(자동 판정)", plannedAt: recent, actualRunId: null }).where(eq(schema.plannedRuns.id, p2.id));
    const n = await notifyMissedRuns(now);
    expect(n).toBe(1); // site-02 는 수신자 없음 → 발송 0, 하지만 기록은 남아 다시 보지 않는다
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("미실행");
    expect(sent[0].text).toContain("예정:");
    const logs = await db().select().from(schema.notificationLogs).where(eq(schema.notificationLogs.kind, "MISSED_RUN"));
    expect(logs.map((l) => l.refId).sort()).toEqual([p1.id, p2.id].sort());
    expect(logs.every((l) => l.incidentId === null)).toBe(true);
    // 두 번째 실행: 아무것도 안 보냄
    expect(await notifyMissedRuns(now)).toBe(0);
    expect(sent).toHaveLength(1);
    // 사용 중지 로봇의 회차는 제외
    const p3 = (await db().select().from(schema.plannedRuns).where(and(eq(schema.plannedRuns.siteId, "site-01"), sql`${schema.plannedRuns.id} <> ${p1.id}`)).limit(1))[0];
    await db().update(schema.plannedRuns).set({ status: "MISSED", reason: "(자동 판정)", plannedAt: recent }).where(eq(schema.plannedRuns.id, p3.id));
    await db().update(schema.robots).set({ active: false }).where(eq(schema.robots.id, p3.robotId));
    expect(await notifyMissedRuns(now)).toBe(0);
    // 대시보드 '오늘 할 일'에 미실행 회차가 보인다(사용 중지 로봇 포함 여부와 무관하게 회차 자체는 보임)
    const todo = await getTodo(hq);
    expect(todo.missedRuns.some((m) => m.id === p1.id)).toBe(true);
    expect(todo.plannedToday.total).toBeGreaterThanOrEqual(0);
  });

  it("장기간 무실적 알림: 사업장 설정 시간 기준, 실제 로봇만, 로봇당 하루 한 번, 설정 0 이면 끔", async () => {
    const hq = await user("u-hq");
    await db().delete(schema.notificationRecipients);
    await addRecipient(hq, "site-01", { channel: "EMAIL", address: "ops@example.com", minSeverity: "LOW", hoursFrom: "00:00", hoursTo: "23:59" });
    const now = nowIso();
    expect(await notifyNoActivity(now)).toBe(0); // 기본 0 = 끔
    await expect(updateNotificationThresholds(hq, "site-01", 30, 60, 10000)).rejects.toThrow(ValidationError);
    await updateNotificationThresholds(hq, "site-01", 30, 60, 48);
    expect((await getNotificationSetting("site-01"))!.noActivityHours).toBe(48);
    // 샘플 로봇은 source 가 api 가 아니므로 대상 아님
    expect(await notifyNoActivity(now)).toBe(0);
    // PW-R-001 을 실제 로봇으로 표시하고 마지막 실적을 3일 전으로
    await db().update(schema.robots).set({ vendorMeta: { source: "api" } }).where(eq(schema.robots.id, "PW-R-001"));
    const old = new Date(Date.now() - 72 * 3600_000).toISOString();
    await db().update(schema.actualRuns).set({ endedAt: old, startedAt: old }).where(eq(schema.actualRuns.robotId, "PW-R-001"));
    expect(await notifyNoActivity(now)).toBe(1);
    expect(sent.at(-1)?.subject).toContain("무실적");
    expect(await notifyNoActivity(now)).toBe(0); // 하루 한 번
    const tomorrow = new Date(Date.now() + 25 * 3600_000).toISOString();
    expect(await notifyNoActivity(tomorrow)).toBe(1);
    // 최근 실적이 생기면 통보 안 함
    await db().update(schema.actualRuns).set({ endedAt: nowIso() }).where(eq(schema.actualRuns.robotId, "PW-R-001"));
    expect(await notifyNoActivity(new Date(Date.now() + 30 * 3600_000).toISOString())).toBe(0); // 마지막 실적이 30시간 전(기준 48시간 안)
  });

  it("보고서 발송: 고객 공개 때 자동(PPT·Excel 첨부), 수동 재발송, 확정 전·고객 불가, 기록·감사", async () => {
    const hq = await user("u-hq");
    await db().delete(schema.notificationRecipients);
    await addRecipient(hq, "site-01", { channel: "EMAIL", address: "customer@example.com", minSeverity: "LOW", hoursFrom: "09:00", hoursTo: "09:01" }); // 시간대 무관하게 받아야 함
    await addRecipient(hq, "site-01", { channel: "EMAIL", address: "no-report@example.com", minSeverity: "LOW", hoursFrom: "00:00", hoursTo: "23:59", kinds: ["INCIDENT"] });
    const s1 = (await db().query.sites.findFirst({ where: eq(schema.sites.id, "site-01") }))!;
    const w1 = reportSchedule(s1.installedOn!, localDateKey(nowIso())).find((e) => e.kind === "WEEKLY")!;
    const r = await createDraft(hq, "site-01", periodKey(w1));
    await expect(sendReportNotifications(hq, r.id, "MANUAL")).rejects.toThrow(/확정/);
    await updateComments(hq, r.id, { overallOpinion: "이번 주 정상 운영" });
    await submitForReview(hq, r.id);
    await confirmReport(hq, r.id);
    expect(sent).toHaveLength(0);
    await publishReport(hq, r.id);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("customer@example.com");
    expect(sent[0].subject).toContain("보고서");
    expect(sent[0].attachments?.map((a) => a.filename.split(".").pop())).toEqual(["pptx", "xlsx"]);
    expect(sent[0].attachments![0].data.length).toBeGreaterThan(10_000);
    expect(sent[0].text).toContain("이번 주 정상 운영");
    const logs = await db().select().from(schema.notificationLogs).where(and(eq(schema.notificationLogs.kind, "REPORT"), eq(schema.notificationLogs.refId, r.id)));
    expect(logs.map((l) => l.status).sort()).toEqual(["SENT", "SUPPRESSED"]);
    const a = (await db().select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "REPORT:NOTIFY"))).at(-1)!;
    expect(a.params).toMatchObject({ trigger: "PUBLISH", sent: 1, suppressed: 1 });
    // 수동 재발송
    const c = await sendReportNotifications(hq, r.id, "MANUAL");
    expect(c).toMatchObject({ sent: 1, suppressed: 1, failed: 0, recipients: 2 });
    expect(sent).toHaveLength(2);
    await expect(sendReportNotifications(await user("u-cust-1"), r.id, "MANUAL")).rejects.toThrow();
    // MIME 원문: 첨부·제목 인코딩
    const mime = Buffer.from(buildMime({ from: "관제 <noreply@widebot.kro.kr>", to: "a@b.c", subject: "보고서", text: "본문", html: "<b>본문</b>", attachments: sent[0].attachments! })).toString("latin1");
    expect(mime).toContain("Content-Type: multipart/mixed");
    expect(mime).toContain("Content-Disposition: attachment");
    expect(mime).toContain("Subject: =?UTF-8?B?");
    expect((mime.match(/--mixed-/g) ?? []).length).toBeGreaterThanOrEqual(4);
    // 보고서에 생산성·전기 비교가 있다
    const row = await getReport(hq, r.id);
    expect(row.aggregates.productivityM2PerHour === null || typeof row.aggregates.productivityM2PerHour === "number").toBe(true);
    expect(row.aggregates.prev).toBeTruthy();
    expect(row.aggregates.prev!.periodEnd < row.aggregates.periodStart!).toBe(true);
  });

  it("내 구독: 접근 가능한 사업장만, 중복 불가, 종류·시간대 변경, 해제, 남의 행은 불가", async () => {
    const siteA = await user("u-site-a"); // site-01, site-02
    await db().delete(schema.notificationRecipients);
    expect(await mySubscriptions(siteA)).toHaveLength(0);
    await subscribeMe(siteA, "site-01", "EMAIL", ["INCIDENT", "REPORT"]);
    await expect(subscribeMe(siteA, "site-01", "EMAIL")).rejects.toThrow(/이미/);
    await expect(subscribeMe(siteA, "site-03", "EMAIL")).rejects.toThrow(); // 권한 없음
    await expect(subscribeMe(siteA, "site-01", "KAKAO")).rejects.toThrow(/카카오/); // 미연결
    const mine = await mySubscriptions(siteA);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ siteId: "site-01", channel: "EMAIL", address: siteA.email, kinds: ["INCIDENT", "REPORT"] });
    await updateMySubscription(siteA, mine[0].id, { kinds: ["MISSED_RUN"], hoursFrom: "08:00", hoursTo: "20:00" });
    expect((await mySubscriptions(siteA))[0]).toMatchObject({ kinds: ["MISSED_RUN"], hoursFrom: "08:00", hoursTo: "20:00" });
    // 관리자가 등록한 내 이메일 수신자도 내 구독으로 보인다
    const hq = await user("u-hq");
    await addRecipient(hq, "site-02", { channel: "EMAIL", address: siteA.email, minSeverity: "HIGH", hoursFrom: "00:00", hoursTo: "23:59" });
    expect((await mySubscriptions(siteA)).map((s) => s.siteId).sort()).toEqual(["site-01", "site-02"]);
    // 남의 행은 못 바꾼다
    await addRecipient(hq, "site-01", { channel: "EMAIL", address: "other@example.com", minSeverity: "HIGH", hoursFrom: "00:00", hoursTo: "23:59" });
    const other = (await db().query.notificationRecipients.findFirst({ where: eq(schema.notificationRecipients.address, "other@example.com") }))!;
    await expect(updateMySubscription(siteA, other.id, { kinds: ["REPORT"] })).rejects.toThrow();
    await expect(unsubscribeMe(siteA, other.id)).rejects.toThrow();
    await unsubscribeMe(siteA, mine[0].id);
    expect((await mySubscriptions(siteA)).map((s) => s.siteId)).toEqual(["site-02"]);
  });

  it("대시보드 KPI: 최근 7일·전주 비교, 생산성, 평균 조치 시간, 오늘 할 일", async () => {
    const hq = await user("u-hq");
    const d = await getDashboard(hq);
    expect(d.week.runs).toBeGreaterThan(0);
    expect(d.prevWeek.runs).toBeGreaterThan(0);
    expect(d.week.productivityM2PerHour).toBeGreaterThan(0);
    expect(d.sites.every((s) => typeof s.week.runs === "number" && typeof s.prevWeek.runs === "number")).toBe(true);
    expect(d.mttrMin30d === null || d.mttrMin30d > 0).toBe(true);
    const todo = await getTodo(hq);
    expect(Array.isArray(todo.lowConsumables)).toBe(true);
    expect(todo.lowConsumables.every((c) => c.remainingPct < 20)).toBe(true);
    // 고객은 자기 사업장만
    const cust = await getDashboard(await user("u-cust-1"));
    expect(cust.sites.map((s) => s.siteId)).toEqual(["site-01"]);
  });
});
