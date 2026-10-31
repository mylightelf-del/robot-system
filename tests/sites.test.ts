import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { PuduApi } from "@/lib/vendors/pudu/api";
import { PuduClient } from "@/lib/vendors/pudu/client";
import { PuduAdapter } from "@/lib/vendors/pudu/puduAdapter";
import { syncPuduStatus } from "@/worker/pudu";
import { puduImportRobots } from "@/lib/services/admin";
import { relocateRobot } from "@/lib/services/admin";
import { alignFloorMapsToRobots, createFloor, createSite, deleteFloor, deleteSite, getMapImage, importPuduMap, listPuduMapsForSite, polygonAreaM2, refetchMapImage, renameFloor, updateSite } from "@/lib/services/sites";
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
    await relocateRobot(hq, robot.id, siteId, floorId, "시험");

    const maps = await listPuduMapsForSite(hq, siteId);
    expect(maps.shopId).toBe(MOCK_SHOP);
    expect(maps.maps.map((m) => m.name)).toEqual(["-1#0#basement", "1#1#lobby"]);
    await expect(importPuduMap(hq, floorId, "nope")).rejects.toThrow();
    const r = await importPuduMap(hq, floorId, "1#1#lobby");
    expect(r).toMatchObject({ version: 2, zones: 2, imageStored: true });
    const floor = (await db().query.floors.findFirst({ where: eq(schema.floors.id, floorId) }))!;
    expect(floor.currentMapVersionId).toBe(r.mapVersionId);
    const map = (await db().query.mapVersions.findFirst({ where: eq(schema.mapVersions.id, r.mapVersionId) }))!;
    // 이미지는 내려받아 DB 에 보관하고 우리 경로로 서비스한다
    expect(map).toMatchObject({ vendor: "PUDU", vendorMapName: "1#1#lobby", imageUrl: `/api/maps/${encodeURIComponent(r.mapVersionId)}`, widthPx: 1000, heightPx: 800, resolution: 0.05, origin: [-10, -20] });
    const img = await getMapImage(hq, r.mapVersionId);
    expect(img.contentType).toBe("image/png");
    expect(img.size).toBeGreaterThan(50);
    expect(img.bytes.subarray(1, 4).toString()).toBe("PNG");
    // 접근 권한: 이 사업장 권한이 없는 고객사 사용자는 이미지를 받을 수 없다
    await expect(getMapImage(await user("u-cust-1"), r.mapVersionId)).rejects.toThrow(/권한/);
    // 다시 받기
    expect((await refetchMapImage(hq, r.mapVersionId)).size).toBe(img.size);
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
    expect(detail.map?.imageUrl).toBe(`/api/maps/${encodeURIComponent(r.mapVersionId)}`);
    // 로봇이 다른 지도를 보고하면 불일치
    state.mapName = "2#0#other";
    await syncPuduStatus(new PuduAdapter(api));
    st = (await db().query.robotStatus.findFirst({ where: eq(schema.robotStatus.robotId, robot.id) }))!;
    expect(st.mapVersionId).toBe("pudu:2#0#other");
    expect((await getRobotDetail(hq, robot.id)).mapMismatch).toBe(true);
    // 이미지 URL 이 죽은 지도: 가져오기는 되지만 보관 실패를 알리고 원격 URL 을 그대로 둔다 → 나중에 다시 받기 시도 가능
    const { id: f2 } = await createFloor(hq, siteId, "B1");
    await relocateRobot(hq, robot.id, siteId, f2, "시험");
    const r2 = await importPuduMap(hq, f2, "-1#0#basement");
    expect(r2.imageStored).toBe(false);
    expect(r2.imageError).toBeTruthy();
    expect((await db().query.mapVersions.findFirst({ where: eq(schema.mapVersions.id, r2.mapVersionId) }))!.imageUrl).toBe("http://127.0.0.1:9/maps/none.png");
    await expect(getMapImage(hq, r2.mapVersionId)).rejects.toThrow(/보관된 지도 이미지가 없습니다/);
    await expect(refetchMapImage(hq, r2.mapVersionId)).rejects.toThrow(/이미지/);
    await relocateRobot(hq, robot.id, siteId, floorId, "시험");
    // 샘플 지도 층에 있는 로봇은 미터 좌표를 px 로 오인해 그리지 않는다
    await relocateRobot(hq, robot.id, "site-01", "site-01-f1", "시험");
    await syncPuduStatus(new PuduAdapter(api));
    st = (await db().query.robotStatus.findFirst({ where: eq(schema.robotStatus.robotId, robot.id) }))!;
    expect(st.pose).toBeNull();
    // 위치는 그리지 않되, 로봇이 쓰는 지도 이름은 남겨 화면이 '층 지도 맞추기'를 안내한다
    expect(st.mapVersionId).toBe("pudu:2#0#other");
  });

  it("층 지도 맞추기: 미리 보기는 아무것도 바꾸지 않고, 고른 층만 적용, 로봇 배치(층)는 그대로", async () => {
    const hq = await user("u-hq");
    expect(await puduImportRobots(hq, "site-01", "site-01-f1", [MOCK_SN])).toBe(1);
    const robotBefore = (await db().query.robots.findFirst({ where: and(eq(schema.robots.vendor, "PUDU"), eq(schema.robots.vendorRobotId, MOCK_SN)) }))!;
    const floorBefore = (await db().query.floors.findFirst({ where: eq(schema.floors.id, "site-01-f1") }))!;
    state.mapName = "1#1#lobby";
    const preview = await alignFloorMapsToRobots(hq);
    const row = preview.find((x) => x.floorId === "site-01-f1")!;
    expect(row).toMatchObject({ status: "DIFFERENT", map: "1#1#lobby" });
    expect((await db().query.floors.findFirst({ where: eq(schema.floors.id, "site-01-f1") }))!.currentMapVersionId).toBe(floorBefore.currentMapVersionId); // 미리 보기는 변경 없음
    expect((await alignFloorMapsToRobots(hq, { apply: true, floorIds: [] })).length).toBe(0); // 고른 층이 없으면 아무것도 안 함
    const applied = await alignFloorMapsToRobots(hq, { apply: true, floorIds: ["site-01-f1"] });
    expect(applied[0].status).toBe("IMPORTED");
    const mv = (await db().query.mapVersions.findFirst({ where: eq(schema.mapVersions.id, (await db().query.floors.findFirst({ where: eq(schema.floors.id, "site-01-f1") }))!.currentMapVersionId) }))!;
    expect(mv).toMatchObject({ vendor: "PUDU", vendorMapName: "1#1#lobby" });
    const robotAfter = (await db().query.robots.findFirst({ where: eq(schema.robots.id, robotBefore.id) }))!;
    expect([robotAfter.siteId, robotAfter.floorId]).toEqual([robotBefore.siteId, robotBefore.floorId]); // 로봇 배치는 그대로
    expect(state.execCalls.length).toBe(0); // 로봇에 명령을 보내지 않음
    expect((await alignFloorMapsToRobots(hq)).find((x) => x.floorId === "site-01-f1")!.status).toBe("MATCH");
    await expect(alignFloorMapsToRobots(await user("u-site-a"))).rejects.toThrow();
  });

  it("실제 로봇의 배치 변경은 사유가 필요하다(로봇 자체 지도는 바꾸지 않음)", async () => {
    const hq = await user("u-hq");
    expect(await puduImportRobots(hq, "site-01", "site-01-f1", [MOCK_SN])).toBe(1);
    const r = (await db().query.robots.findFirst({ where: and(eq(schema.robots.vendor, "PUDU"), eq(schema.robots.vendorRobotId, MOCK_SN)) }))!;
    await expect(relocateRobot(hq, r.id, "site-01", "site-01-b1")).rejects.toThrow(/사유/);
    await relocateRobot(hq, r.id, "site-01", "site-01-b1", "실제로 2층으로 옮김");
    const a = (await db().select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "ROBOT:RELOCATE"))).at(-1)!;
    expect(a.detail).toBe("실제로 2층으로 옮김");
    expect(state.execCalls.length).toBe(0);
  });
});
