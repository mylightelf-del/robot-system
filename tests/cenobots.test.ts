import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { CenobotsClient, signCenobots, type CenobotsTransport } from "@/lib/vendors/cenobots/client";
import { CenobotsApi, allMissions } from "@/lib/vendors/cenobots/api";
import { mapDeviceStatus, mapMissionToRun, maintenanceRemainingPct, parseCoverage, parseCzDays, parseCzTime } from "@/lib/vendors/cenobots/mapping";
import { MOCK_ACCESS_KEY, MOCK_SECRET_KEY, mockConfig, mockState, mockTransport } from "@/lib/vendors/cenobots/mock";
import { decryptCzWebhook, encryptCzWebhook } from "@/lib/vendors/cenobots/webhook";
import { createCenobotsApi } from "@/lib/vendors/cenobots/cenobotsAdapter";
import { isLiveRobot, vendorMode } from "@/lib/vendors";
import { cenobotsImportRobots, cenobotsTestConnection } from "@/lib/services/cenobotsAdmin";
import { nextRobotId } from "@/lib/services/admin";
import { createFloor, createSite } from "@/lib/services/sites";
import { issueCommand } from "@/lib/services/commands";
import { ForbiddenError } from "@/lib/util/errors";
import { processCenobotsEvents, syncCenobotsCatalog, syncCenobotsErrors, syncCenobotsPlannedRuns, syncCenobotsReports, syncCenobotsStatus } from "@/worker/cenobots";
import { POST as webhookPOST } from "@/app/api/webhooks/cenobots/route";
import { getDb, resetAndSeed, schema, user } from "./helpers";

const db = () => getDb();

describe("CENOBOTS 서명·클라이언트(조회 전용)", () => {
  it("서명: hex(HMAC-SHA256(secret, METHOD+timestamp+path)) — 문서 예제 값으로 고정(파이썬 hmac 으로 따로 계산한 값)", () => {
    expect(signCenobots("2xxxbd", "GET", "1712725202000", "/app/openapi/v1/device/status/ZXxxxxxx67")).toBe("25c08f3bfb38a6c7813b61d5eae0aa5ed7b1abe3d7278ec8838aef38d37536ca");
    expect(signCenobots("2xxxbd", "POST", "1712725202000", "/app/openapi/v1/mission/list")).toBe("ccb1c9bcf2ea8208628ffbc800d41a91f83ba512c1b76709ba15d19afa5dc171");
  });

  it("쿼리는 서명에서 빼고(문서 예제), 503 은 재시도, 실패는 rid·시계 힌트를 남기되 키·시크릿은 남기지 않는다", async () => {
    const seen: { path: string; headers: Record<string, string> }[] = [];
    let calls = 0;
    const t: CenobotsTransport = {
      async send(req) {
        calls += 1;
        seen.push({ path: req.path, headers: req.headers });
        if (calls === 1) return { status: 503, text: "busy" };
        if (req.path.includes("/map")) return { status: 200, text: JSON.stringify({ success: true, code: 0, data: [{ mapName: "B2", mapId: 1, mapVersion: "v", inUse: true, valid: true }], rid: "r1" }) };
        return { status: 200, text: JSON.stringify({ success: false, code: 401, info: "timestamp expired", rid: "rid-xyz" }) };
      },
    };
    const client = new CenobotsClient({ host: "https://h", accessKey: "AK-123", secretKey: "SK-456", allowed: ["x"], minIntervalMs: 0, maxRetries: 2 }, t, async () => undefined);
    const api = new CenobotsApi(client);
    const maps = await api.maps("DEV1");
    expect(maps[0].mapName).toBe("B2");
    expect(calls).toBe(2); // 503 → 재시도
    const last = seen[1];
    expect(last.path).toBe("/app/openapi/v1/map?deviceOpenId=DEV1");
    expect(last.headers["X-Api-signature"]).toBe(signCenobots("SK-456", "GET", last.headers["X-Api-timestamp"], "/app/openapi/v1/map"));
    const err = await api.status("DEV1").catch((e: Error) => e);
    expect(String(err)).toContain("rid-xyz");
    expect(String(err)).toContain("서버 시계");
    expect(String(err)).not.toContain("SK-456");
    expect(String(err)).not.toContain("AK-123");
  });

  it("쓰기 경로는 요청 전에 막는다(조회용 POST 만 허용)", async () => {
    const t: CenobotsTransport = { send: async () => ({ status: 200, text: "{}" }) };
    const client = new CenobotsClient({ host: "https://h", accessKey: "a", secretKey: "s", allowed: ["x"], minIntervalMs: 0 }, t);
    await expect(client.postQuery("/app/openapi/v1/mission", {})).rejects.toThrow(/조회 전용/);
    await expect(client.postQuery("/app/openapi/v1/schedule", {})).rejects.toThrow(/조회 전용/);
  });
});

describe("CENOBOTS 매핑 표", () => {
  const robot = { id: "PW-R-X", siteId: "s", floorId: "f", openId: "O1" };
  const base = { missionId: "m1", startTimeStamp: 1_762_000_000_000, endTimeStamp: 1_762_003_600_000, totalTime: 60, cleanedArea: 512.34, water: 12.345, cleaningSolution: 99.6 };
  it("작업 결과: DONE/success → 정상 완료, STOP/canceled → 중단, ABEND/error → 미완료(사유 저장), 모르는 값 → 미분류", () => {
    const r = (status: string, extra = {}) => mapMissionToRun({ ...base, status, ...extra }, robot, "2026-11-10T00:00:00Z")!;
    expect(r("DONE").run.result).toBe("COMPLETED");
    expect(r("success").run.result).toBe("COMPLETED");
    expect(r("STOP", { taskEndReasonEnum: "PAD_MANUAL" }).run).toMatchObject({ result: "ABORTED", endReason: "중단(사용자 취소) · PAD에서 수동 중지" });
    expect(r("canceled").run.result).toBe("ABORTED");
    expect(r("ABEND", { abendSubReasonEnum: "HIGH_AIR_PRESSURE", errDesc: "Air pressure too high" }).run).toMatchObject({ result: "INCOMPLETE", endReason: "미완료(작업 예외) · 진공 압력이 너무 높음" });
    expect(r("error", { errDesc: "Not running for a long time" }).run.endReason).toContain("Not running for a long time");
    const u = r("WEIRD");
    expect(u.unknownStatus).toBe(true);
    expect(u.run.endReason).toContain("미분류");
    expect(r("DONE").run).toMatchObject({ id: "run-cz-O1-m1", areaM2: 512.3, durationMin: 60, waterL: 12.35, detergentMl: 100, startedAt: "2025-11-01T12:26:40.000Z" });
    expect(mapMissionToRun({ ...base, endTimeStamp: 0, status: "DONE" }, robot, "x")).toBeNull(); // 진행 중
  });

  it("디바이스 상태 → 공통 상태(오프라인 > 비상정지 > 복귀 > 작업 상태 > 충전 > 대기)", () => {
    const s = (o: object) => mapDeviceStatus({ online: true, soc: 50, running: false, charging: false, ...o }).common;
    expect(s({ online: false, running: true })).toBe("OFFLINE");
    expect(s({ isEmergency: true, running: true })).toBe("ERROR");
    expect(s({ running: true, missionTaskDetail: { sweepMode: "Homing", taskStatus: "ON_GOING" } })).toBe("RETURNING");
    expect(s({ running: true, missionTaskDetail: { sweepMode: "Sweep", taskStatus: "ON_GOING", taskProgress: 0.42 } })).toBe("CLEANING");
    expect(s({ running: true, missionTaskDetail: { taskStatus: "PAUSE" } })).toBe("PAUSED");
    expect(s({ running: true, missionTaskDetail: { taskStatus: "MANUAL_HANDLING" } })).toBe("ERROR");
    expect(s({ charging: true })).toBe("CHARGING");
    expect(s({})).toBe("IDLE");
    expect(mapDeviceStatus({ online: true, soc: 1, running: true, charging: false, missionTaskDetail: { taskStatus: "ON_GOING", taskProgress: 0.42 } }).progressPct).toBe(42);
  });

  it("예약 시각·요일·커버리지·소모품 파싱", () => {
    expect(parseCzTime("10:40 am")).toBe("10:40");
    expect(parseCzTime("04:42 PM")).toBe("16:42");
    expect(parseCzTime("12:05 am")).toBe("00:05");
    expect(parseCzTime("22:00")).toBe("22:00");
    expect(parseCzTime("bad")).toBeNull();
    expect(parseCzDays(["Mon.", "Thur.", "Sun.", "Sat"])).toEqual([0, 1, 4, 6]);
    expect(parseCoverage("96%")).toBe(96);
    expect(parseCoverage("0.95")).toBe(95);
    expect(parseCoverage(null)).toBeNull();
    expect(maintenanceRemainingPct({ name: "x", remainPercent: "63%" })).toBe(63);
    expect(maintenanceRemainingPct({ name: "x", life: 480, remainHours: 240 })).toBe(50);
  });
});

describe("CENOBOTS mock 픽스처·페이징", () => {
  it("mission/list 페이지를 끝까지 모으고 missionId 로 중복을 없앤다", async () => {
    const api = new CenobotsApi(new CenobotsClient(mockConfig([]), mockTransport));
    const end = Date.now();
    const all = await allMissions(api, "MOCK05408A", end - 10 * 86400_000, end, 3);
    expect(all.length).toBeGreaterThanOrEqual(18); // 하루 2건 × 9~10일
    expect(new Set(all.map((m) => m.missionId)).size).toBe(all.length);
  });
  it("mock 은 서명을 검사한다(틀린 키 → 401)", async () => {
    const bad = new CenobotsApi(new CenobotsClient({ ...mockConfig([]), secretKey: "wrong" }, mockTransport));
    await expect(bad.listDevices()).rejects.toThrow(/401/);
    expect(MOCK_ACCESS_KEY).toMatch(/^mock-/);
    expect(MOCK_SECRET_KEY).toMatch(/^mock-/);
  });
});

describe("CENOBOTS 웹훅 복호화·수신", () => {
  const SECRET = "AabHnFvuKE54rMbS5Gafsw9fD0ja4mefAlRtv3THAM4"; // 문서 예시 형식(가짜)
  it("AES-256-GCM 왕복, 변조·다른 시크릿은 거부(fail closed)", () => {
    const env = encryptCzWebhook(SECRET, { messageType: "challenge", data: { challenge: "abc" } });
    expect(decryptCzWebhook(SECRET, env)).toEqual({ messageType: "challenge", data: { challenge: "abc" } });
    expect(() => decryptCzWebhook("other", env)).toThrow();
    const tampered = { ...env, encrypt: env.encrypt.slice(0, -2) + (env.encrypt.endsWith("A") ? "BB" : "AA") };
    expect(() => decryptCzWebhook(SECRET, tampered)).toThrow();
    expect(() => decryptCzWebhook(SECRET, { iv: "x", encrypt: "y" })).toThrow();
  });

  describe("라우트", () => {
    beforeAll(() => {
      process.env.CENOBOTS_MODE = "mock";
      process.env.CENOBOTS_WEBHOOK_SECRET = SECRET;
    });
    afterAll(() => {
      delete process.env.CENOBOTS_MODE;
      delete process.env.CENOBOTS_WEBHOOK_SECRET;
    });
    beforeEach(async () => {
      await resetAndSeed();
    });
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      webhookPOST(new Request("http://x/api/webhooks/cenobots", { method: "POST", headers: { "content-type": "application/json", "x-webhook-id": "evt_t", "x-webhook-timestamp": String(Math.floor(Date.now() / 1000)), ...headers }, body: JSON.stringify(body) }));

    it("challenge 를 그대로 돌려주고, 시각 5분 초과·복호화 실패는 401", async () => {
      const r = await post(encryptCzWebhook(SECRET, { messageType: "challenge", data: { challenge: "c-123" } }));
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ challenge: "c-123" });
      expect((await post(encryptCzWebhook(SECRET, { messageType: "challenge", data: { challenge: "c" } }), { "x-webhook-timestamp": String(Math.floor(Date.now() / 1000) - 400) })).status).toBe(401);
      expect((await post(encryptCzWebhook("wrong", { messageType: "challenge", data: { challenge: "c" } }))).status).toBe(401);
    });

    it("업무 이벤트는 data.id 로 한 번만 저장, 위치 이벤트는 저장 안 함", async () => {
      const ev = { messageType: "event", data: { id: "evt_1", type: "robot.error.changed", occurredAt: Date.now(), device: { openId: "MOCK05408A" }, data: { codes: [{ code: 204801, desc: "Emergency stop button is pressed" }], addedCodes: [204801], removedCodes: [], previousCodes: [] } } };
      expect((await post(encryptCzWebhook(SECRET, ev))).status).toBe(200);
      expect((await post(encryptCzWebhook(SECRET, ev))).status).toBe(200);
      await post(encryptCzWebhook(SECRET, { messageType: "event", data: { id: "evt_p", type: "robot.pose.changed", device: { openId: "MOCK05408A" }, data: {} } }));
      const rows = await db().select().from(schema.vendorEvents).where(eq(schema.vendorEvents.vendor, "CENOBOTS"));
      expect(rows.map((r) => r.eventKey)).toEqual(["evt_1"]);
    });

    it("연동을 끄면(unconfigured) 503", async () => {
      process.env.CENOBOTS_MODE = "unconfigured";
      expect((await post(encryptCzWebhook(SECRET, { messageType: "challenge", data: { challenge: "c" } }))).status).toBe(503);
      process.env.CENOBOTS_MODE = "mock";
    });
  });
});

describe("CENOBOTS 모드 결정", () => {
  const keep = { ...process.env };
  afterAll(() => {
    process.env = keep;
  });
  it("mock/unconfigured/live, PUDU 는 영향 없음", () => {
    process.env.VENDOR_MODE = "live";
    delete process.env.CENOBOTS_MODE;
    delete process.env.CENOBOTS_ACCESS_KEY;
    expect(vendorMode("CENOBOTS")).toBe("unconfigured");
    process.env.CENOBOTS_MODE = "mock";
    expect(vendorMode("CENOBOTS")).toBe("mock");
    process.env.CENOBOTS_MODE = "live";
    process.env.CENOBOTS_HOST = "apac";
    process.env.CENOBOTS_ACCESS_KEY = "k";
    process.env.CENOBOTS_SECRET_KEY = "s";
    expect(vendorMode("CENOBOTS")).toBe("unconfigured"); // 허용 장비 없음
    process.env.CENOBOTS_ALLOWED_DEVICE_OPEN_IDS = "L4-05408";
    expect(vendorMode("CENOBOTS")).toBe("live");
    process.env.CENOBOTS_MODE = "unconfigured";
    expect(vendorMode("CENOBOTS")).toBe("unconfigured"); // 키가 있어도 끔
    expect(vendorMode("BIB")).toBe("unconfigured");
    process.env.VENDOR_MODE = "sample";
    delete process.env.CENOBOTS_MODE;
    expect(vendorMode("CENOBOTS")).toBe("sample");
    expect(isLiveRobot({ vendor: "CENOBOTS", vendorMeta: { source: "api" } })).toBe(false);
    for (const k of ["CENOBOTS_HOST", "CENOBOTS_ACCESS_KEY", "CENOBOTS_SECRET_KEY", "CENOBOTS_ALLOWED_DEVICE_OPEN_IDS"]) delete process.env[k];
  });
});

describe("CENOBOTS mock 전체 파이프라인(로컬 적재) · 운영 dry-run · 명령 차단", () => {
  let siteId = "";
  let b2 = "";
  let b3 = "";
  beforeAll(() => {
    process.env.CENOBOTS_MODE = "mock";
    delete process.env.CENOBOTS_ALLOWED_DEVICE_OPEN_IDS;
  });
  afterAll(() => {
    delete process.env.CENOBOTS_MODE;
    process.env.APP_ENV = "test";
  });
  beforeEach(async () => {
    process.env.APP_ENV = "test";
    mockState.requests.length = 0;
    await resetAndSeed();
    const hq = await user("u-hq");
    siteId = (await createSite(hq, { name: "포스코센터(시험)", address: "" })).id;
    b2 = (await createFloor(hq, siteId, "지하2층")).id;
    b3 = (await createFloor(hq, siteId, "지하3층")).id;
  });

  it("번호판으로 미리 등록한 로봇에 연결 → 상태·예약·소모품·작업 이력·장애·계획 회차, 허용 밖 장비는 무시", async () => {
    const hq = await user("u-hq");
    // 사전 등록(scripts/register-cenobot-bib.ts 와 같은 형태, 사용 중지)
    await db().insert(schema.robots).values({ id: "PW-R-031", vendor: "CENOBOTS", model: "L4", vendorRobotId: "plate:L4-05408", siteId, floorId: b2, name: "포스코센터 2호기", serial: "E250918008A", active: false, supportedCommands: [], vendorMeta: { source: "api", licensePlate: "L4-05408" } });
    await db().insert(schema.robotPlacements).values({ id: "plc-t31", robotId: "PW-R-031", siteId, from: "2026-01-01T00:00:00.000Z", to: null });
    await db().insert(schema.robotStatus).values({ robotId: "PW-R-031", common: "UNKNOWN", raw: "-", online: false, batteryPct: null, pose: null, poseIsLastKnown: true, mapVersionId: null, currentMissionId: null, progressPct: null, lastReceivedAt: null, dataAt: null });

    const conn = await cenobotsTestConnection(hq);
    expect(conn.ok).toBe(true);
    expect(conn.devices.map((d) => d.licensePlate).sort()).toEqual(["L4-05408", "L4-05590"]); // L4-09999 제외
    expect(conn.devices.find((d) => d.licensePlate === "L4-05408")?.registered).toBe("PW-R-031");

    // 05590 은 새로 등록, 05408 은 장비 동기화가 번호판으로 연결
    expect(await cenobotsImportRobots(hq, siteId, b3, ["MOCK05590A"])).toBe(1);
    await expect(cenobotsImportRobots(hq, siteId, b3, ["MOCK09999X"])).rejects.toThrow(/허용 장비/);
    const api = createCenobotsApi();
    const cat = await syncCenobotsCatalog(api);
    expect(cat.ok).toBe(true);
    const r31 = (await db().query.robots.findFirst({ where: eq(schema.robots.id, "PW-R-031") }))!;
    expect(r31.vendorMeta).toMatchObject({ deviceOpenId: "MOCK05408A", boundMode: "mock" });
    expect(r31.active).toBe(false); // 사용 여부는 그대로
    await db().update(schema.robots).set({ active: true }).where(eq(schema.robots.id, "PW-R-031"));
    await syncCenobotsCatalog(api);

    const newRobot = (await db().select().from(schema.robots).where(eq(schema.robots.vendorRobotId, "MOCK05590A")))[0];
    expect(newRobot.supportedCommands).toEqual([]);
    const schedules = await db().select().from(schema.schedules).where(eq(schema.schedules.executor, "VENDOR"));
    const cz = schedules.filter((s) => s.id.startsWith("sch-cz-"));
    expect(cz.map((s) => s.time).sort()).toEqual(["05:30", "13:00", "22:00"]);
    expect(cz.find((s) => s.time === "05:30")!.daysOfWeek).toEqual([1, 2, 3, 4, 5, 6]);
    const mnt = await db().select().from(schema.maintenanceItems).where(eq(schema.maintenanceItems.robotId, "PW-R-031"));
    expect(mnt.map((m) => [m.name, m.remainingPct]).sort()).toEqual([["디스크 브러시 잔여 수명", 90], ["세제 잔여 수명", 63], ["스퀴지 블레이드 잔여 수명", 0]]);

    const st = await syncCenobotsStatus();
    expect(st.counts).toMatchObject({ robots: 2, updated: 2, failed: 0 });
    const s31 = (await db().query.robotStatus.findFirst({ where: eq(schema.robotStatus.robotId, "PW-R-031") }))!;
    expect(["CLEANING", "CHARGING"]).toContain(s31.common);
    expect(s31.batteryPct).not.toBeNull();
    expect(s31.pose).toBeNull(); // 지도 연결 전에는 위치를 그리지 않음

    const rep = await syncCenobotsReports(api, 24 * 10);
    expect(rep.ok).toBe(true);
    const runs = (await db().select().from(schema.actualRuns).where(eq(schema.actualRuns.vendor, "CENOBOTS"))).filter((r) => r.vendorRobotId.startsWith("MOCK"));
    expect(runs.length).toBe(rep.counts!.inserted);
    expect(runs.length).toBeGreaterThan(10);
    expect(new Set(runs.map((r) => r.result))).toContain("COMPLETED");
    expect(runs.every((r) => r.vendorRobotId === "MOCK05408A" || r.vendorRobotId === "MOCK05590A")).toBe(true);
    const abend = runs.find((r) => r.endReason?.includes("진공 압력"));
    if (abend) expect(abend.result).toBe("INCOMPLETE");
    const again = await syncCenobotsReports(api, 24 * 10);
    expect(again.counts!.inserted).toBe(0); // 멱등

    const err = await syncCenobotsErrors(api);
    expect(err.counts).toMatchObject({ active: 1, inserted: 1 });
    const inc = (await db().select().from(schema.incidents).where(eq(schema.incidents.code, "CZ-703903")))[0];
    expect(inc).toMatchObject({ robotId: newRobot.id, severity: "HIGH", status: "OPEN", customerMessage: "충전에 실패했습니다. 현장 확인이 필요합니다." });
    expect((await syncCenobotsErrors(api)).counts).toMatchObject({ inserted: 0 }); // 미해결이 있으면 다시 만들지 않음

    const plan = await syncCenobotsPlannedRuns();
    expect(plan.ok).toBe(true);
    expect((await db().select().from(schema.plannedRuns).where(eq(schema.plannedRuns.robotId, "PW-R-031"))).length).toBeGreaterThan(0);

    // 웹훅 이벤트 처리: 작업 시작 → 상태 CLEANING, 문 열기 요청 → 장애(보통)
    const now = Date.now();
    await db().insert(schema.vendorEvents).values([
      { id: "e1", vendor: "CENOBOTS", eventType: "robot.task.status_changed", vendorRobotId: "MOCK05408A", eventKey: "evt_a", receivedAt: new Date(now).toISOString(), occurredAt: new Date(now + 1000).toISOString(), traceId: null, payload: { id: "evt_a", type: "robot.task.status_changed", occurredAt: now + 1000, device: { openId: "MOCK05408A" }, data: { isRunning: true, previousIsRunning: false, taskId: "t1", status: { code: 1, name: "ON_GOING" }, sweepType: "Sweep", progress: 0.1 } } },
      { id: "e2", vendor: "CENOBOTS", eventType: "robot.need_help_door_call", vendorRobotId: "MOCK05408A", eventKey: "evt_b", receivedAt: new Date(now).toISOString(), occurredAt: new Date(now).toISOString(), traceId: null, payload: { id: "evt_b", type: "robot.need_help_door_call", occurredAt: now, device: { openId: "MOCK05408A" }, data: {} } },
    ]);
    const evr = await processCenobotsEvents();
    expect(evr.counts).toMatchObject({ events: 2, done: 2, errors: 0 });
    expect((await db().query.robotStatus.findFirst({ where: eq(schema.robotStatus.robotId, "PW-R-031") }))!).toMatchObject({ common: "CLEANING", progressPct: 10 });
    expect((await db().select().from(schema.incidents).where(and(eq(schema.incidents.code, "CZ-DOOR_CALL"), eq(schema.incidents.robotId, "PW-R-031"))))[0]?.severity).toBe("MEDIUM");

    // 쓰기 API 는 한 번도 부르지 않았다
    expect(mockState.requests.filter((r) => r.method !== "GET" && !/mission\/list$/.test(r.path))).toEqual([]);
  });

  it("운영 서버의 mock 은 dry-run: 등록·연결·적재하지 않는다", async () => {
    process.env.APP_ENV = "production";
    const hq = await user("u-hq");
    await expect(cenobotsImportRobots(hq, siteId, b3, ["MOCK05590A"])).rejects.toThrow(/모의\(mock\)/);
    const cat = await syncCenobotsCatalog(createCenobotsApi());
    expect(cat.ok).toBe(true);
    expect(cat.counts).toMatchObject({ devices: 2, dryRun: 1 });
    expect(cat.counts!.runs).toBeGreaterThan(0);
    expect((await db().select().from(schema.actualRuns).where(eq(schema.actualRuns.vendor, "CENOBOTS"))).filter((r) => r.vendorRobotId.startsWith("MOCK"))).toEqual([]);
    expect(await db().select().from(schema.robots).where(eq(schema.robots.vendor, "CENOBOTS")).then((r) => r.filter((x) => x.vendorMeta?.source === "api"))).toEqual([]);
  });

  it("원격 제어 스위치가 켜진 운영 사업장에서도 CENOBOTS 로봇에는 명령을 만들지 않는다(감사 기록 DENIED, 업체 호출 없음)", async () => {
    const hq = await user("u-hq");
    await cenobotsImportRobots(hq, siteId, b3, ["MOCK05590A"]);
    const robot = (await db().select().from(schema.robots).where(eq(schema.robots.vendorRobotId, "MOCK05590A")))[0];
    await db().update(schema.sites).set({ remoteControlEnabled: true }).where(eq(schema.sites.id, siteId));
    // 지원 명령이 있어도(누가 잘못 넣어도) 막혀야 한다
    await db().update(schema.robots).set({ supportedCommands: ["START_TASK", "PAUSE", "STOP", "GO_HOME", "RESUME"] }).where(eq(schema.robots.id, robot.id));
    mockState.requests.length = 0;
    for (const type of ["PAUSE", "STOP", "GO_HOME", "RESUME"] as const) {
      await expect(issueCommand(hq, { robotId: robot.id, type })).rejects.toThrow(ForbiddenError);
    }
    expect(await db().select().from(schema.commands).where(eq(schema.commands.robotId, robot.id))).toEqual([]);
    const denied = await db().select().from(schema.auditLogs).where(and(eq(schema.auditLogs.robotId, robot.id), eq(schema.auditLogs.result, "DENIED")));
    expect(denied.length).toBe(4);
    expect(denied.every((a) => a.detail === "조회 전용 제조사")).toBe(true);
    expect(mockState.requests).toEqual([]);
  });

  it("관리번호: 가장 큰 번호 + 1(중간 번호를 먼저 써도 충돌 없음)", async () => {
    const before = await nextRobotId();
    await db().insert(schema.robots).values({ id: "PW-R-090", vendor: "BIB", model: "J40", vendorRobotId: "sn:x", siteId, floorId: b2, name: "x", active: false, supportedCommands: [] });
    expect(await nextRobotId()).toBe("PW-R-091");
    expect(before).toMatch(/^PW-R-\d{3}$/);
  });
});
