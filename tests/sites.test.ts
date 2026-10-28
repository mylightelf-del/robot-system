import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { PuduApi } from "@/lib/vendors/pudu/api";
import { PuduClient } from "@/lib/vendors/pudu/client";
import { PuduAdapter } from "@/lib/vendors/pudu/puduAdapter";
import { syncPuduStatus } from "@/worker/pudu";
import { puduImportRobots } from "@/lib/services/admin";
import { relocateRobot } from "@/lib/services/admin";
import { createFloor, createSite, deleteFloor, deleteSite, importPuduMap, listPuduMapsForSite, polygonAreaM2, renameFloor, updateSite } from "@/lib/services/sites";
import { getRobotDetail } from "@/lib/services/robots";
import { worldToPixel } from "@/lib/domain/types";
import { getDb, resetAndSeed, schema, user } from "./helpers";
import { MOCK_KEY, MOCK_SECRET, MOCK_SHOP, MOCK_SN, startMockPudu, type MockState } from "./pudu-mock-server";

describe("사업장·층·지도 관리(운영 준비)", () => {
  const db = getDb;
  let mock: Awaited<ReturnType<typeof startMockPudu>>;
  let state: MockState;
  let api: PuduApi;
  beforeAll(async () => {
    mock = await startMockPudu();
    state = mock.state;
    process.env.VENDOR_MODE = "live";
    process.env.PUDU_API_APP_KEY = MOCK_KEY;
    process.env.PUDU_API_APP_SECRET = MOCK_SECRET;
    process.env.PUDU_API_BASE_URL = mock.url;
    process.env.PUDU_SHOP_IDS = MOCK_SHOP;
    api = new PuduApi(new PuduClient({ apiAppKey: MOCK_KEY, apiAppSecret: MOCK_SECRET, baseUrl: mock.url, shopIds: [MOCK_SHOP] }));
  });
  afterAll(async () => {
    await mock.close();
    process.env.VENDOR_MODE = "sample";
    delete process.env.PUDU_API_BASE_URL;
  });
  beforeEach(async () => {
    await resetAndSeed();
    Object.assign(state, { taskCode: 0, runState: "IDLE", battery: 77, execCalls: [], requests: [], failNext: null, mapName: undefined });
  });

  it("사업장 생성·수정·층 추가·이름 변경·삭제 — 본사 관리자만, 알림 설정 동반 생성, 감사 기록", async () => {
    const hq = await user("u-hq");
    await expect(createSite(await user("u-site-a"), { name: "포스코센터 선릉", address: "서울 강남구" })).rejects.toThrow();
    const { id } = await createSite(hq, { name: "포스코센터 선릉", address: "서울 강남구 테헤란로 440" });
    expect(id.startsWith("site-")).toBe(true);
    expect(id).toMatch(/^[a-z0-9-]+$/); // URL 경로용 ASCII ID
    const site = (await db().query.sites.findFirst({ where: eq(schema.sites.id, id) }))!;
    expect(site).toMatchObject({ name: "포스코센터 선릉", timezone: "Asia/Seoul", isSample: false });
    expect(await db().query.notificationSettings.findFirst({ where: eq(schema.notificationSettings.siteId, id) })).toBeTruthy();
    await expect(createSite(hq, { name: "포스코센터 선릉", address: "" })).rejects.toThrow(/이미/);
    await expect(createSite(hq, { name: "X", address: "" })).rejects.toThrow(/2자/);
    await expect(createSite(hq, { name: "시간대 오류", address: "", timezone: "Mars/Olympus" })).rejects.toThrow(/시간대/);
    await updateSite(hq, id, { name: "포스코센터(선릉)", address: "변경" });
    expect((await db().query.sites.findFirst({ where: eq(schema.sites.id, id) }))!.name).toBe("포스코센터(선릉)");

    const f = await createFloor(hq, id, "1층");
    const floor = (await db().query.floors.findFirst({ where: eq(schema.floors.id, f.id) }))!;
    const map = (await db().query.mapVersions.findFirst({ where: eq(schema.mapVersions.id, floor.currentMapVersionId) }))!;
    expect(map).toMatchObject({ version: 1, corners: null });
    expect(map.imageUrl).toBeNull();
    await expect(createFloor(hq, id, "1층")).rejects.toThrow(/이미/);
    await renameFloor(hq, f.id, "1F 로비");
    expect((await db().query.floors.findFirst({ where: eq(schema.floors.id, f.id) }))!.name).toBe("1F 로비");
    // 층이 있으면 사업장 삭제 불가 → 층 삭제 후 가능
    await expect(deleteSite(hq, id)).rejects.toThrow(/층/);
    await deleteFloor(hq, f.id);
    expect(await db().query.mapVersions.findFirst({ where: eq(schema.mapVersions.floorId, f.id) })).toBeUndefined();
    await deleteSite(hq, id);
    expect(await db().query.sites.findFirst({ where: eq(schema.sites.id, id) })).toBeUndefined();
    // 로봇이 배치된 샘플 층/사업장은 삭제 불가
    await expect(deleteFloor(hq, "site-01-f1")).rejects.toThrow(/로봇/);
    const acts = await db().select().from(schema.auditLogs);
    expect(acts.map((a) => a.action)).toEqual(expect.arrayContaining(["SITE:CREATE", "SITE:UPDATE", "FLOOR:CREATE", "FLOOR:RENAME", "FLOOR:DELETE", "SITE:DELETE"]));
  });

  it("PUDU 지도 가져오기: 매장 지도 목록 → 새 지도 버전(이미지·해상도·원점·모서리) + area 구역(m→px) → 로봇 위치가 px 로 표시, 지도 불일치 감지", async () => {
    const hq = await user("u-hq");
    // 새 사업장·층을 만들고 모의 로봇을 등록해 옮긴다
    const { id: siteId } = await createSite(hq, { name: "포스코센터 선릉", address: "" });
    const { id: floorId } = await createFloor(hq, siteId, "1층");
    await expect(listPuduMapsForSite(hq, siteId)).rejects.toThrow(/PUDU API 로 등록한 로봇이 없어/);
    expect(await puduImportRobots(hq, "site-01", "site-01-f1", [MOCK_SN])).toBe(1);
    const robot = (await db().query.robots.findFirst({ where: and(eq(schema.robots.vendor, "PUDU"), eq(schema.robots.vendorRobotId, MOCK_SN)) }))!;
    await relocateRobot(hq, robot.id, siteId, floorId);

    const maps = await listPuduMapsForSite(hq, siteId);
    expect(maps.shopId).toBe(MOCK_SHOP);
    expect(maps.maps.map((m) => m.name)).toEqual(["-1#0#basement", "1#1#lobby"]);
    await expect(importPuduMap(hq, floorId, "nope")).rejects.toThrow();
    const r = await importPuduMap(hq, floorId, "1#1#lobby");
    expect(r).toMatchObject({ version: 2, zones: 2 });
    const floor = (await db().query.floors.findFirst({ where: eq(schema.floors.id, floorId) }))!;
    expect(floor.currentMapVersionId).toBe(r.mapVersionId);
    const map = (await db().query.mapVersions.findFirst({ where: eq(schema.mapVersions.id, r.mapVersionId) }))!;
    expect(map).toMatchObject({ vendor: "PUDU", vendorMapName: "1#1#lobby", imageUrl: "https://example.invalid/maps/lobby.png", widthPx: 1000, heightPx: 800, resolution: 0.05, origin: [-10, -20] });
    expect(map.corners).toEqual({ bl: [-10, -20], tl: [-10, 20], tr: [40, 20], br: [40, -20] });
    const zones = await db().select().from(schema.zones).where(eq(schema.zones.floorId, floorId));
    const lobby = zones.find((z) => z.name === "로비 중앙")!;
    expect(lobby.polygon).toEqual([[200, 400], [400, 400], [400, 300], [200, 300]]); // (0,0)m → (200,400)px, y 는 위로 갈수록 px 감소
    expect(lobby.areaM2).toBe(50);
    expect(zones.find((z) => z.name === "구역 2")).toBeTruthy(); // 이름 없는 area 는 번호로
    expect(polygonAreaM2([0, 0, 10, 0, 10, 5, 0, 5])).toBe(50);
    expect(worldToPixel(map, 12.3, -4.5)).toEqual({ x: 446, y: 490 });

    // 상태 폴링: 로봇이 보고한 지도 이름이 층 지도와 같으면 위치를 px 로 변환하고 mapVersionId 가 일치
    await syncPuduStatus(new PuduAdapter(api));
    let st = (await db().query.robotStatus.findFirst({ where: eq(schema.robotStatus.robotId, robot.id) }))!;
    expect(st.pose).toEqual({ x: 446, y: 490, headingDeg: 0 });
    expect(st.mapVersionId).toBe(r.mapVersionId);
    expect(st.raw).toContain("pos=(12.3, -4.5)m");
    const detail = await getRobotDetail(hq, robot.id);
    expect(detail.mapMismatch).toBe(false);
    expect(detail.map?.imageUrl).toBe("https://example.invalid/maps/lobby.png");
    // 로봇이 다른 지도를 보고하면 불일치
    state.mapName = "2#0#other";
    await syncPuduStatus(new PuduAdapter(api));
    st = (await db().query.robotStatus.findFirst({ where: eq(schema.robotStatus.robotId, robot.id) }))!;
    expect(st.mapVersionId).toBe("pudu:2#0#other");
    expect((await getRobotDetail(hq, robot.id)).mapMismatch).toBe(true);
    // 샘플 지도 층에 있는 로봇은 미터 좌표를 px 로 오인해 그리지 않는다
    await relocateRobot(hq, robot.id, "site-01", "site-01-f1");
    await syncPuduStatus(new PuduAdapter(api));
    st = (await db().query.robotStatus.findFirst({ where: eq(schema.robotStatus.robotId, robot.id) }))!;
    expect(st.pose).toBeNull();
    expect(st.mapVersionId).toBeNull();
  });
});
