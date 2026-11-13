import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { PuduApi } from "@/lib/vendors/pudu/api";
import { PuduClient } from "@/lib/vendors/pudu/client";
import { syncPuduCatalog, syncPuduReports } from "@/worker/pudu";
import { puduImportRobots } from "@/lib/services/admin";
import { createFloor, createSite, importPuduMap } from "@/lib/services/sites";
import { relocateRobot } from "@/lib/services/admin";
import { matchZoneIds, parseCoverage, actionGuideFor } from "@/lib/vendors/pudu/mapping";
import { getRunImage, recomputeCoverage, storeRunImage } from "@/lib/services/coverage";
import { addIncidentPhoto, deleteIncidentPhoto, getIncidentPhotoData, incidentPhotosFor, incidentStats, resolveIncident, simulateIncident } from "@/lib/services/incidents";
import { authenticateApiToken, createApiToken, listApiTokens, resetRateLimits, revokeApiToken, RATE_LIMIT_PER_MINUTE } from "@/lib/services/apiTokens";
import { incidentsPayload, parseRange, reportsPayload, robotsPayload, runsPayload, sitesPayload } from "@/lib/api/v1";
import { consumableForecast, snapshotMaintenance } from "@/lib/services/maintenance";
import { notifyConsumables } from "@/lib/services/alerts";
import { addRecipient } from "@/lib/services/admin";
import { getRobotDetail } from "@/lib/services/robots";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/util/errors";
import { nowIso } from "@/lib/util/time";
import { getDb, resetAndSeed, schema, user } from "./helpers";
import { MOCK_KEY, MOCK_SECRET, MOCK_SHOP, MOCK_SN, startMockPudu } from "./pudu-mock-server";

const db = () => getDb();
// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

describe("개선 B: 청소 범위 증빙 · 조치 가이드/분석 · 소모품 예측 · 오픈 API · 조치 사진", () => {
  let mock: Awaited<ReturnType<typeof startMockPudu>>;
  let api: PuduApi;
  beforeAll(async () => {
    mock = await startMockPudu();
    process.env.VENDOR_MODE = "live";
    process.env.PUDU_API_APP_KEY = MOCK_KEY;
    process.env.PUDU_API_APP_SECRET = MOCK_SECRET;
    process.env.PUDU_API_BASE_URL = mock.url;
    process.env.PUDU_SHOP_IDS = MOCK_SHOP;
    process.env.APP_BASE_URL = "https://widebot.example";
    api = new PuduApi(new PuduClient({ apiAppKey: MOCK_KEY, apiAppSecret: MOCK_SECRET, baseUrl: mock.url, shopIds: [MOCK_SHOP] }));
  });
  afterAll(async () => {
    await mock.close();
    process.env.VENDOR_MODE = "sample";
    delete process.env.PUDU_API_BASE_URL;
  });
  beforeEach(async () => {
    await resetAndSeed();
    resetRateLimits();
  });

  it("증빙 파싱: 실기 floor_list 문자열 → 수행률·구역·결과 지도 URL, 구역 ID/이름으로 우리 구역과 연결", () => {
    const floorList = JSON.stringify([{ map_name: "1#2#포스코센터1층_", map_version: 52, area_array: [{ area_id: "X1", area_name: "중앙청소", clean_count: 1, area: 637.8 }, { area_id: "X2", area_name: "우천시 회전문2", clean_count: 0, area: 26.1 }], task_result_url: "https://example.invalid/r.png", rubbish_distribution_url: "https://example.invalid/h.png" }]);
    const cov = parseCoverage({ floor_list: floorList, percentage: 88 })!;
    expect(cov).toMatchObject({ percentage: 88, mapName: "1#2#포스코센터1층_", mapVersion: 52, resultImageUrl: "https://example.invalid/r.png", heatmapUrl: "https://example.invalid/h.png" });
    expect(cov.areas).toEqual([{ vendorId: "X1", name: "중앙청소", cleanCount: 1, areaM2: 637.8 }, { vendorId: "X2", name: "우천시 회전문2", cleanCount: 0, areaM2: 26.1 }]);
    expect(parseCoverage({ floor_list: undefined, percentage: 50 })).toBeNull();
    expect(parseCoverage({ floor_list: "not json" })).toBeNull();
    // 연결: 제조사 ID 우선, 없으면 이름, 청소 안 한 구역은 제외
    expect(matchZoneIds(cov, [{ id: "z-a", name: "다른 이름", vendorZoneId: "X1" }, { id: "z-b", name: "우천시 회전문2", vendorZoneId: null }])).toEqual(["z-a"]);
    expect(matchZoneIds(cov, [{ id: "z-c", name: "중앙청소", vendorZoneId: null }])).toEqual(["z-c"]);
    expect(matchZoneIds(cov, [])).toEqual([]);
    // 조치 가이드: 알려진 코드는 현장 순서, 모르는 코드는 기본 안내
    expect(actionGuideFor("CleanSewageFull").field.length).toBeGreaterThan(0);
    expect(actionGuideFor("Whatever").vendor).toBe(true);
  });

  it("보고서 동기화가 증빙을 채우고(구역 연결·수행률) 결과 지도를 보관한다; 재계산 스크립트는 멱등", async () => {
    const hq = await user("u-hq");
    const { id: siteId } = await createSite(hq, { name: "증빙 시험장", address: "" });
    const { id: floorId } = await createFloor(hq, siteId, "1층");
    expect(await puduImportRobots(hq, "site-01", "site-01-f1", [MOCK_SN])).toBe(1);
    const robot = (await db().query.robots.findFirst({ where: and(eq(schema.robots.vendor, "PUDU"), eq(schema.robots.vendorRobotId, MOCK_SN)) }))!;
    await relocateRobot(hq, robot.id, siteId, floorId, "시험");
    const imp = await importPuduMap(hq, floorId, "1#1#lobby");
    expect(imp.zones).toBe(2);
    const zones = await db().select().from(schema.zones).where(eq(schema.zones.floorId, floorId));
    expect(zones.find((z) => z.name === "로비 중앙")?.vendorZoneId).toBe("a1"); // 제조사 구역 ID 저장
    await syncPuduReports(api, 24 * 30);
    const done = (await db().query.actualRuns.findFirst({ where: eq(schema.actualRuns.vendorRunId, "894770283318874112") }))!;
    expect(done.coverage).toMatchObject({ percentage: 92, mapName: "1#1#lobby" });
    expect(done.coverage!.areas.map((a) => [a.name, a.cleanCount])).toEqual([["로비 중앙", 1], ["엘리베이터 홀", 0]]);
    expect(done.zoneIds).toEqual([zones.find((z) => z.vendorZoneId === "a1")!.id]);
    // 결과 지도는 워커가 바로 보관
    const img = await db().query.runImages.findFirst({ where: eq(schema.runImages.runId, done.id) });
    expect(img?.contentType).toBe("image/png");
    // 화면 조회: 권한(로봇 접근) — 고객(site-01만)은 이 사업장 로봇을 볼 수 없다
    const got = await getRunImage(hq, done.id, "RESULT");
    expect(got.data.subarray(1, 4).toString()).toBe("PNG");
    await expect(getRunImage(await user("u-cust-1"), done.id, "RESULT")).rejects.toThrow(NotFoundError);
    expect(await storeRunImage(done.id, "RESULT")).toMatchObject({ stored: false, reason: "이미 보관" });
    expect(await storeRunImage(done.id, "HEATMAP")).toMatchObject({ stored: false });
    // 재계산: 지웠다가 다시 채운다
    await db().update(schema.actualRuns).set({ coverage: null, zoneIds: [] }).where(eq(schema.actualRuns.id, done.id));
    const r = await recomputeCoverage({});
    expect(r.updated).toBeGreaterThanOrEqual(2);
    const again = (await db().query.actualRuns.findFirst({ where: eq(schema.actualRuns.id, done.id) }))!;
    expect(again.coverage?.percentage).toBe(92);
    expect(again.zoneIds).toHaveLength(1);
    // 로봇 상세의 실적에 증빙이 붙는다
    const detail = await getRobotDetail(hq, robot.id);
    expect(detail.runs.find((x) => x.id === done.id)?.coverage?.percentage).toBe(92);
  });

  it("장애 조치 사진: 담당자만 올림, 고객은 비내부만, 삭제, 감사 기록 / 반복 장애 분석", async () => {
    const hq = await user("u-hq");
    const inc = (await simulateIncident(hq, "PW-R-001", "BRUSH_STUCK", "HIGH", `ph-${Date.now()}`))!;
    await expect(addIncidentPhoto(await user("u-cust-1"), inc.id, { caption: "x", internal: false, data: PNG })).rejects.toThrow(ForbiddenError);
    await expect(addIncidentPhoto(hq, inc.id, { caption: "x", internal: false, data: Buffer.from("not an image") })).rejects.toThrow(ValidationError);
    const pub = await addIncidentPhoto(hq, inc.id, { caption: "브러시 제거 후", internal: false, data: PNG });
    const priv = await addIncidentPhoto(hq, inc.id, { caption: "내부 메모 사진", internal: true, data: PNG });
    const cust = await user("u-cust-1");
    expect((await incidentPhotosFor(hq, [inc.id])).get(inc.id)?.map((p) => p.id)).toEqual([pub.id, priv.id]);
    expect((await incidentPhotosFor(cust, [inc.id])).get(inc.id)?.map((p) => p.id)).toEqual([pub.id]);
    expect((await getIncidentPhotoData(cust, pub.id)).contentType).toBe("image/png");
    await expect(getIncidentPhotoData(cust, priv.id)).rejects.toThrow(NotFoundError);
    await expect(getIncidentPhotoData(await user("u-cust-2"), pub.id)).rejects.toThrow(NotFoundError); // 다른 사업장 고객
    await deleteIncidentPhoto(hq, priv.id);
    expect((await incidentPhotosFor(hq, [inc.id])).get(inc.id)).toHaveLength(1);
    expect((await db().select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "INCIDENT:PHOTO_ADD"))).length).toBe(2);
    // 분석: 같은 로봇·같은 코드 반복이 잡히고, 고객은 못 본다
    const inc2 = (await simulateIncident(hq, "PW-R-001", "BRUSH_STUCK", "HIGH", `ph2-${Date.now()}`))!;
    await resolveIncident(hq, inc2.id, "정리");
    const st = await incidentStats(hq, { days: 90 });
    expect(st.total).toBeGreaterThan(0);
    expect(st.byCode.some((c) => c.code === "BRUSH_STUCK")).toBe(true);
    expect(st.byRobot.some((r) => r.robotId === "PW-R-001")).toBe(true);
    expect(st.recurrences.some((r) => r.robotId === "PW-R-001" && r.code === "BRUSH_STUCK" && r.count >= 2)).toBe(true);
    await expect(incidentStats(cust)).rejects.toThrow(ForbiddenError);
  });

  it("소모품 예측: 일별 이력 → 감소 속도·예상 교체일, 임계 미만·점검 기한 통보(7일에 한 번, 종류 CONSUMABLE)", async () => {
    const hq = await user("u-hq");
    const robotId = "PW-R-001";
    const tz = "Asia/Seoul";
    // 이력: 10일 전 90% → 오늘 60% (하루 3%p)
    const old = new Date(Date.now() - 10 * 86400_000).toISOString();
    await db().insert(schema.maintenanceHistory).values({ id: "mh-test-1", robotId, name: "시험 브러시 잔여 수명", remainingPct: 90, at: old });
    await db().insert(schema.maintenanceItems).values({ id: "mnt-test-brush", robotId, name: "시험 브러시 잔여 수명", remainingPct: 60, source: "API" });
    expect(await snapshotMaintenance(robotId, [{ key: "brush", name: "시험 브러시 잔여 수명", remainingPct: 60 }], tz)).toBe(1);
    expect(await snapshotMaintenance(robotId, [{ key: "brush", name: "시험 브러시 잔여 수명", remainingPct: 60 }], tz)).toBe(0); // 하루 1행
    const fc = (await consumableForecast(robotId, tz)).find((f) => f.name === "시험 브러시 잔여 수명")!;
    expect(fc.ratePctPerDay).toBeCloseTo(3, 0);
    expect(fc.daysLeft).toBe(20);
    expect(fc.expectedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 통보: 19% 항목 + 기한 지난 점검
    await db().delete(schema.notificationRecipients);
    await addRecipient(hq, "site-01", { channel: "EMAIL", address: "ops@example.com", minSeverity: "LOW", hoursFrom: "00:00", hoursTo: "23:59", kinds: ["CONSUMABLE"] });
    await db().insert(schema.maintenanceItems).values({ id: "mnt-test-filter", robotId, name: "시험 필터 잔여 수명", remainingPct: 19, source: "API" });
    await db().insert(schema.inspections).values({ id: "insp-test-overdue", siteId: "site-01", robotId, item: "오수통 세척", dueAt: new Date(Date.now() - 86400_000).toISOString(), doneAt: null, doneBy: null, note: null });
    const n = await notifyConsumables(nowIso());
    expect(n).toBeGreaterThanOrEqual(2);
    const logs = await db().select().from(schema.notificationLogs).where(eq(schema.notificationLogs.kind, "CONSUMABLE"));
    expect(logs.some((l) => l.refId === `cons:${robotId}:시험 필터 잔여 수명`)).toBe(true);
    expect(logs.some((l) => l.refId === "insp:insp-test-overdue")).toBe(true);
    expect(await notifyConsumables(nowIso())).toBe(0); // 반복 억제
    // 7일 뒤: 이 시험의 소모품은 다시 통보, 점검은 1회만. (샘플 데이터의 다른 점검도 그때쯤 기한이 지나므로 전체 건수가 아니라 이 시험 항목만 본다 — 달력에 따라 결과가 달라지던 문제)
    await notifyConsumables(new Date(Date.now() + 8 * 86400_000).toISOString());
    const later = await db().select().from(schema.notificationLogs).where(eq(schema.notificationLogs.kind, "CONSUMABLE"));
    expect(later.filter((l) => l.refId === `cons:${robotId}:시험 필터 잔여 수명`).length).toBe(logs.filter((l) => l.refId === `cons:${robotId}:시험 필터 잔여 수명`).length * 2);
    expect(later.filter((l) => l.refId === "insp:insp-test-overdue").length).toBe(logs.filter((l) => l.refId === "insp:insp-test-overdue").length);
  });

  it("오픈 API 토큰: 발급(한 번만 노출)·범위·인증·분당 제한·폐기, 응답은 고객 기준 필드", async () => {
    const hq = await user("u-hq");
    await expect(createApiToken(await user("u-site-a"), { name: "x", siteIds: [] })).rejects.toThrow();
    await expect(createApiToken(hq, { name: "x", siteIds: [] })).rejects.toThrow(ValidationError);
    const { token, meta } = await createApiToken(hq, { name: "고객사 BMS", siteIds: ["site-01", "nope"] });
    expect(token.startsWith("wbt_")).toBe(true);
    expect(meta.siteIds).toEqual(["site-01"]);
    expect((await listApiTokens(hq))[0].id).toBe(meta.id);
    expect((await db().query.apiTokens.findFirst({ where: eq(schema.apiTokens.id, meta.id) }))!.tokenHash).not.toContain(token.slice(4, 12));
    const req = (auth?: string) => new Request("https://widebot.example/api/v1/sites", { headers: auth ? { authorization: auth } : {} });
    expect((await authenticateApiToken(req())).ok).toBe(false);
    expect((await authenticateApiToken(req("Bearer wbt_wrong"))).ok).toBe(false);
    const ok = await authenticateApiToken(req(`Bearer ${token}`));
    expect(ok.ok && ok.siteIds).toEqual(["site-01"]);
    expect((await db().query.apiTokens.findFirst({ where: eq(schema.apiTokens.id, meta.id) }))!.useCount).toBe(1);
    // 응답 모양
    const sites = await sitesPayload(["site-01"]);
    expect(sites[0]).toMatchObject({ id: "site-01" });
    expect(sites[0].robotCount).toBeGreaterThan(0);
    const robots = await robotsPayload(["site-01"]);
    expect(robots[0]).not.toHaveProperty("vendorRobotId");
    expect(robots[0]).not.toHaveProperty("internalNote");
    const range = parseRange(new URLSearchParams({ from: "2026-01-01", to: "2026-03-01" }));
    expect("error" in range).toBe(true); // 31일 초과
    const r7 = parseRange(new URLSearchParams());
    expect("fromIso" in r7).toBe(true);
    const runs = await runsPayload(["site-01"], new Date(Date.now() - 7 * 86400_000).toISOString(), nowIso());
    expect(runs.length).toBeGreaterThan(0);
    expect(Object.keys(runs[0])).toContain("completionPct");
    const inc = await simulateIncident(hq, "PW-R-001", "BRUSH_STUCK", "HIGH", `api-${Date.now()}`);
    const incs = await incidentsPayload(["site-01"], new Date(Date.now() - 86400_000).toISOString(), nowIso(), "open");
    expect(incs.some((i) => i.id === inc!.id)).toBe(true);
    expect(incs[0]).not.toHaveProperty("code");
    expect(incs[0]).not.toHaveProperty("rawMessage");
    const reps = await reportsPayload(["site-01"]);
    expect(reps.every((r) => typeof r.url === "string")).toBe(true);
    // 분당 제한
    for (let i = 1; i < RATE_LIMIT_PER_MINUTE; i++) await authenticateApiToken(req(`Bearer ${token}`));
    const limited = await authenticateApiToken(req(`Bearer ${token}`));
    expect(limited.ok === false && limited.status).toBe(429);
    // 폐기
    await revokeApiToken(hq, meta.id, "교체");
    resetRateLimits();
    expect((await authenticateApiToken(req(`Bearer ${token}`))).ok).toBe(false);
  });

  it("카탈로그 동기화가 소모품 이력을 남긴다", async () => {
    const hq = await user("u-hq");
    await puduImportRobots(hq, "site-01", "site-01-f1", [MOCK_SN]);
    await syncPuduCatalog(api);
    const robot = (await db().query.robots.findFirst({ where: and(eq(schema.robots.vendor, "PUDU"), eq(schema.robots.vendorRobotId, MOCK_SN)) }))!;
    const hist = await db().select().from(schema.maintenanceHistory).where(eq(schema.maintenanceHistory.robotId, robot.id));
    expect(hist.length).toBeGreaterThan(0);
  });
});
