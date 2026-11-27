import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { cornersToPixel, headingOnMap } from "@/lib/domain/types";
import { getSiteView } from "@/lib/services/robots";
import { floorKey } from "@/lib/services/vendorMaps";
import type { CenobotsApi, CzDeviceStatus } from "@/lib/vendors/cenobots/api";
import { CenobotsAdapter } from "@/lib/vendors/cenobots/cenobotsAdapter";
import { BibApi } from "@/lib/vendors/bib/api";
import { BibClient, type BibFetch } from "@/lib/vendors/bib/client";
import { syncCenobotsMaps } from "@/worker/cenobots";
import { syncBibMaps, syncBibStatus } from "@/worker/bib";
import { getDb, resetAndSeed, schema, user } from "./helpers";

/** CENOBOT·BIB 층 지도 자동 가져오기와 지도 위 위치(가짜 응답 — 실 계정 값 없음). */

// 가로 200 · 세로 100 짜리 PNG 머리(크기만 읽음)
function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

describe("모서리 좌표 변환", () => {
  it("축 정렬(월드 m) · 그림 픽셀 그대로 · 회전된 지도", () => {
    const m = { widthPx: 200, heightPx: 100, corners: { bl: [-10, -5], tl: [-10, 5], tr: [10, 5], br: [10, -5] } as const };
    const c = { ...m, corners: { bl: [...m.corners.bl], tl: [...m.corners.tl], tr: [...m.corners.tr], br: [...m.corners.br] } as never };
    expect(cornersToPixel(c, 0, 0)).toEqual({ x: 100, y: 50 });
    expect(cornersToPixel(c, -10, 5)).toEqual({ x: 0, y: 0 });
    expect(headingOnMap(c, 0, 0, 0)).toBe(90); // +x(동쪽) → 화면 오른쪽
    expect(headingOnMap(c, 0, 0, Math.PI / 2)).toBe(0); // +y → 화면 위
    const pix = { widthPx: 300, heightPx: 120, corners: { bl: [0, 120], tl: [0, 0], tr: [300, 0], br: [300, 120] } as never };
    const q = cornersToPixel(pix, 12.5, 40)!;
    expect(q.x).toBeCloseTo(12.5);
    expect(q.y).toBeCloseTo(40);
    // 90° 회전: 그림의 오른쪽이 월드 +y
    const rot = { widthPx: 100, heightPx: 100, corners: { bl: [0, 0], tl: [-10, 0], tr: [-10, 10], br: [0, 10] } as never };
    const p = cornersToPixel(rot, -5, 5)!;
    expect(p.x).toBeCloseTo(50);
    expect(p.y).toBeCloseTo(50);
  });
});

describe("층 이름 짝짓기", () => {
  it("지하·지상 층 이름과 지도 이름", () => {
    expect(["지하3층", "B3", "B3F", "POSCO B6F", "지하 2층"].map(floorKey)).toEqual(["B3", "B3", "B3", "B6", "B2"]);
    expect(["2F", "7층", "CGP7F", "CGP4F", "1F 메인홀", "3F 영화관층", "B동 3F"].map(floorKey)).toEqual(["2", "7", "7", "4", "1", "3", "3"]);
    expect(floorKey("로비")).toBeNull();
  });
});

describe("CENOBOT 층 지도 가져오기·위치", () => {
  let status: CzDeviceStatus;
  let maps: { mapName: string; mapId: number; mapVersion: string; inUse: boolean; valid: boolean }[];
  const calls: string[] = [];
  const api = {
    status: async () => status,
    maps: async () => maps,
    mapPic: async (ver: string) => {
      calls.push(`pic:${ver}`);
      return { width: 200, height: 100, picUrl: `https://cz.example.invalid/${ver}.png`, vertexCoordinates: [{ x: -10, y: -5 }, { x: -10, y: 5 }, { x: 10, y: 5 }, { x: 10, y: -5 }] };
    },
    areas: async () => ({ mapId: 7, areaList: [{ id: "a1", name: "로비", geo: [{ x: -10, y: -5 }, { x: 0, y: -5 }, { x: 0, y: 5 }, { x: -10, y: 5 }] }] }),
  } as unknown as CenobotsApi;
  const floorMap = async (floorId: string) => {
    const f = (await getDb().query.floors.findFirst({ where: eq(schema.floors.id, floorId) }))!;
    return (await getDb().query.mapVersions.findFirst({ where: eq(schema.mapVersions.id, f.currentMapVersionId) }))!;
  };
  beforeAll(() => {
    // live 연결로 표시된 로봇만 조회 대상 → 시험용 가짜 설정(실제 호출은 가짜 api 로만)
    Object.assign(process.env, { CENOBOTS_MODE: "live", CENOBOTS_HOST: "apac", CENOBOTS_ACCESS_KEY: "k", CENOBOTS_SECRET_KEY: "s", CENOBOTS_ALLOWED_DEVICE_OPEN_IDS: "OPEN1" });
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(png(200, 100)), { status: 200, headers: { "content-type": "binary/octet-stream" } }));
  });
  afterAll(() => {
    for (const k of ["CENOBOTS_MODE", "CENOBOTS_HOST", "CENOBOTS_ACCESS_KEY", "CENOBOTS_SECRET_KEY", "CENOBOTS_ALLOWED_DEVICE_OPEN_IDS"]) delete process.env[k];
    vi.unstubAllGlobals();
  });
  beforeEach(async () => {
    await resetAndSeed();
    calls.length = 0;
    status = { online: true, soc: 80, running: false, charging: false, currentMapName: "POSCO 3F", currentMapVersion: "v3a", currentMapId: 7, pose: { x: 0, y: 0, yaw: Math.PI / 2 } };
    maps = [
      { mapName: "POSCO 3F", mapId: 7, mapVersion: "v3a", inUse: true, valid: true },
      { mapName: "POSCO 1F", mapId: 8, mapVersion: "v1a", inUse: false, valid: true },
      { mapName: "POSCO B9F", mapId: 9, mapVersion: "v9a", inUse: false, valid: true },
    ];
    // 1층에 등록된 로봇이 3층 지도를 쓰는 중(실측과 같은 꼴)
    await getDb().insert(schema.robots).values({ id: "PW-R-CZ-T", vendor: "CENOBOTS", model: "L4", vendorRobotId: "OPEN1", siteId: "site-03", floorId: "site-03-f1", name: "CZ 시험", serial: "S1", active: true, supportedCommands: [], vendorMeta: { source: "api", deviceOpenId: "OPEN1", boundMode: "live" } });
  });

  it("지도 이름으로 층에 짝지어 모두 가져오고, 위치는 지금 쓰는 지도의 층에 그린다(등록 층은 그대로)", async () => {
    const r1 = await syncCenobotsMaps(api);
    expect(r1.ok).toBe(true);
    expect(r1.detail).toContain("층 이름을 못 찾은 지도 1개(POSCO B9F)");
    expect(calls.sort()).toEqual(["pic:v1a", "pic:v3a"]);
    const m3 = await floorMap("site-03-f3");
    expect(m3).toMatchObject({ vendor: "CENOBOTS", vendorMapName: "POSCO 3F", vendorMapVersion: "v3a", widthPx: 200, heightPx: 100 });
    expect(m3.imageUrl).toBe(`/api/maps/${encodeURIComponent(m3.id)}`); // 그림 보관
    expect((await floorMap("site-03-f1")).vendorMapName).toBe("POSCO 1F");
    const zones = await getDb().select().from(schema.zones).where(eq(schema.zones.floorId, "site-03-f3"));
    expect(zones.map((z) => [z.name, z.areaM2])).toEqual([["로비", 100]]);
    expect(zones[0].polygon[0]).toEqual([0, 100]);

    const robot = (await getDb().query.robots.findFirst({ where: eq(schema.robots.id, "PW-R-CZ-T") }))!;
    const st = (await new CenobotsAdapter(api).fetchStatus(robot as never))!;
    expect(st.pose).toEqual({ x: 100, y: 50, headingDeg: 0 });
    expect(st.mapVersionId).toBe(m3.id);
    await getDb().insert(schema.robotStatus).values({ ...st, rawPayload: null });
    const hq = await user("u-hq");
    expect((await getSiteView(hq, "site-03", "site-03-f3")).robots.map((r) => r.robot.id)).toContain("PW-R-CZ-T");
    expect((await getSiteView(hq, "site-03", "site-03-f1")).robots.map((r) => r.robot.id)).not.toContain("PW-R-CZ-T");
    expect((await getDb().query.robots.findFirst({ where: eq(schema.robots.id, "PW-R-CZ-T") }))!.floorId).toBe("site-03-f1"); // 등록 층은 그대로

    calls.length = 0;
    await syncCenobotsMaps(api);
    expect(calls).toEqual([]); // 같은 판은 다시 받지 않음

    // 쓰는 중인 3층 지도가 새 판으로 → 3층만 다시
    maps = maps.map((m) => (m.mapName === "POSCO 3F" ? { ...m, mapVersion: "v3b" } : m));
    status = { ...status, currentMapVersion: "v3b" };
    expect((await new CenobotsAdapter(api).fetchStatus(robot as never))!.pose).toBeNull(); // 아직 새 판이 없으면 그리지 않음
    await syncCenobotsMaps(api);
    expect(calls).toEqual(["pic:v3b"]);
    expect((await floorMap("site-03-f3")).vendorMapVersion).toBe("v3b");
  });

  it("층 지도가 PUDU 지도면 바꾸지 않음", async () => {
    const f3 = (await getDb().query.floors.findFirst({ where: eq(schema.floors.id, "site-03-f3") }))!;
    await getDb().update(schema.mapVersions).set({ vendor: "PUDU", imageUrl: "/api/maps/x", vendorMapName: "pudu" }).where(eq(schema.mapVersions.id, f3.currentMapVersionId));
    const r = await syncCenobotsMaps(api);
    expect(r.detail).toContain("PUDU 지도라 그대로");
    expect(calls).toEqual(["pic:v1a"]);
  });
});

describe("BIB 층 지도 가져오기·위치(그림 픽셀)", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const RID = "11111111-2222-4333-8444-555555555555";
  const f: BibFetch = async (url) => {
    const path = new URL(url).pathname.replace("/rhibot/api", "");
    const json = (status: number, b: unknown) => ({ status, json: async () => b, text: async () => JSON.stringify(b) });
    if (path === "/partner/v1/auth/service") return json(201, { accessToken: "tok", expiresIn: 86400, expiresAt: new Date(Date.now() + 86400_000).toISOString(), tokenType: "Bearer" });
    if (path.endsWith("/localmap/list")) return json(200, { robotId: RID, activeMapHandle: "m-3", localMapList: [{ mapHandle: "m-3", name: "CGP3F" }, { mapHandle: "m-1", name: "CGP1F" }] });
    if (path.endsWith("/localmap/m-3") || path.endsWith("/localmap/m-1")) return json(200, { robotId: RID, mapHandle: path.slice(-3), name: "x", image: { type: "BASE64", data: png(300, 120).toString("base64"), mimeType: "image/png" } });
    if (path.endsWith("/position")) return json(200, { robotId: RID, mapHandle: "m-3", localMapPosition: { x: 120.4, y: 40, frame: "image", unit: "pixel", originX: 0, originY: 0 } });
    if (path.endsWith("/status")) return json(200, { robotId: RID, online: true, batteryPercent: 50, movingStatus: "STOPPED", activityState: "IDLE", timeObserved: null, timeReceived: new Date().toISOString(), freshness: "FRESH" });
    if (path.endsWith("/task/current")) return json(200, { supported: true, task: null });
    return json(404, {});
  };
  const api = new BibApi(new BibClient({ baseUrl: "https://bib.example.invalid/rhibot/api", serviceKey: "t", privateKey, timeoutMs: 5000 }, f));
  beforeEach(async () => {
    await resetAndSeed();
    await getDb().insert(schema.robots).values({ id: "PW-R-BIB-T", vendor: "BIB", model: "J40", vendorRobotId: RID, siteId: "site-03", floorId: "site-03-f1", name: "CG", serial: "J40-TEST-0001", active: true, supportedCommands: [], vendorMeta: { source: "api", sn: "J40-TEST-0001" } });
  });

  it("BASE64 그림을 보관하고 크기를 그림에서 읽는다, 위치는 그림 좌표 그대로 · 지금 쓰는 지도의 층", async () => {
    const r = await syncBibMaps(api);
    expect(r.ok).toBe(true);
    const f3 = (await getDb().query.floors.findFirst({ where: eq(schema.floors.id, "site-03-f3") }))!;
    const mv = (await getDb().query.mapVersions.findFirst({ where: eq(schema.mapVersions.id, f3.currentMapVersionId) }))!;
    expect(mv).toMatchObject({ vendor: "BIB", vendorMapName: "CGP3F", vendorMapVersion: "m-3", widthPx: 300, heightPx: 120 });
    const img = await getDb().query.mapImages.findFirst({ where: eq(schema.mapImages.mapVersionId, mv.id) });
    expect(img).toMatchObject({ contentType: "image/png", sourceUrl: `bib:${RID}/m-3` });
    await syncBibStatus(api);
    const st = (await getDb().query.robotStatus.findFirst({ where: eq(schema.robotStatus.robotId, "PW-R-BIB-T") }))!;
    expect(st.pose).toMatchObject({ x: 120, y: 40 });
    expect(st.mapVersionId).toBe(mv.id);
  });
});
