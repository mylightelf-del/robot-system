import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { buildQuery, contentMd5, signRequest, signingString, verifySignature } from "@/lib/vendors/pudu/signing";
import { PuduClient } from "@/lib/vendors/pudu/client";
import { PuduApi } from "@/lib/vendors/pudu/api";
import { buildExecBodies, mapCleanbotTaskCode, mapProductCode, mapReportStatus, mapReportToRun } from "@/lib/vendors/pudu/mapping";
import { PuduAdapter } from "@/lib/vendors/pudu/puduAdapter";
import { ingestPuduCallback } from "@/lib/vendors/pudu/webhook";
import { confirmPendingCommands, processPuduEvents, syncPuduCatalog, syncPuduErrors, syncPuduReports, syncPuduStatus } from "@/worker/pudu";
import { issueCommand } from "@/lib/services/commands";
import { puduImportRobots, puduTestConnection } from "@/lib/services/admin";
import { getAdapter } from "@/lib/vendors";
import { proxy } from "@/proxy";
import { POST } from "@/app/api/webhooks/pudu/route";
import { NextRequest } from "next/server";
import { getDb, resetAndSeed, schema, user } from "./helpers";
import { MOCK_KEY, MOCK_SECRET, MOCK_SHOP, MOCK_SN, OTHER_SN, startMockPudu, type MockState } from "./pudu-mock-server";

describe("PUDU 서명(공식 알고리즘)", () => {
  it("쿼리는 키 사전순·배열은 쉼표·빈 값은 키만, 서명 경로는 디코딩된 쿼리", () => {
    const q = buildQuery({ b: "2", a: "###Special Character Test", c: "3", arr: ["x", "y"], empty: "" });
    expect(q.forSign).toBe("a=###Special Character Test&arr=x,y&b=2&c=3&empty");
    expect(q.encoded).toBe("a=%23%23%23Special%20Character%20Test&arr=x,y&b=2&c=3&empty");
    // 값이 undefined 인 키는 보내지 않는다(실기: 키만 보내면 빈 값 필터로 해석돼 0건)
    expect(buildQuery({ shop_id: "1", product_code: undefined, limit: 5 }).forSign).toBe("limit=5&shop_id=1");
  });

  it("서명 문자열 형식과 Content-MD5(hex→base64), /release 접두사 제거", () => {
    expect(contentMd5("")).toBe("");
    // 문서 규칙: base64( hex(md5(body)) ) — 32자 hex 문자열을 다시 base64 로 감싼다
    expect(contentMd5('{"a":1}')).toBe(Buffer.from("bb6cb5c68df4652941caf652a366f2d8").toString("base64"));
    expect(contentMd5('{"a":1}')).toBe(Buffer.from(createHash("md5").update('{"a":1}').digest("hex")).toString("base64"));
    const s = signingString({ date: "Tue, 28 Oct 2026 10:00:00 GMT", method: "GET", md5: "", path: "/release/open-platform-service/v2/status/get_by_sn", queryForSign: "sn=123" });
    expect(s).toBe("x-date: Tue, 28 Oct 2026 10:00:00 GMT\nGET\napplication/json\napplication/json\n\n/open-platform-service/v2/status/get_by_sn?sn=123");
  });

  it("서명한 요청을 같은 규칙으로 검증할 수 있다(GET·POST)", () => {
    const get = signRequest({ apiAppKey: MOCK_KEY, apiAppSecret: MOCK_SECRET, method: "GET", path: "/pudu-entry/data-open-platform-service/v1/api/robot", query: { limit: 2, shop_id: 324100000 }, date: "Tue, 28 Oct 2026 10:00:00 GMT" });
    expect(get.headers.Authorization).toMatch(/^hmac id="test-app-key", algorithm="hmac-sha1", headers="x-date", signature="[A-Za-z0-9+/=]+"$/);
    expect(verifySignature({ apiAppSecret: MOCK_SECRET, method: "GET", pathWithQuery: get.path, date: get.headers["x-date"], md5: "", authorization: get.headers.Authorization })).toBe(true);
    expect(verifySignature({ apiAppSecret: "wrong", method: "GET", pathWithQuery: get.path, date: get.headers["x-date"], md5: "", authorization: get.headers.Authorization })).toBe(false);
    const post = signRequest({ apiAppKey: MOCK_KEY, apiAppSecret: MOCK_SECRET, method: "POST", path: "/pudu-entry/cleanbot-service/v1/api/open/task/exec", body: { sn: MOCK_SN, type: 3, clean: { status: 1 } } });
    expect(post.headers["Content-MD5"]).toBe(contentMd5(post.body));
    expect(verifySignature({ apiAppSecret: MOCK_SECRET, method: "POST", pathWithQuery: post.path, date: post.headers["x-date"], md5: post.headers["Content-MD5"], authorization: post.headers.Authorization })).toBe(true);
  });
});

describe("PUDU 매핑(문서 기준)", () => {
  it("청소로봇 상태 코드 → 공통 상태", () => {
    expect(mapCleanbotTaskCode(302).common).toBe("CLEANING");
    expect(mapCleanbotTaskCode(301).common).toBe("PAUSED");
    expect(mapCleanbotTaskCode(400).common).toBe("RETURNING");
    expect(mapCleanbotTaskCode(202).common).toBe("CHARGING");
    expect(mapCleanbotTaskCode(-100).common).toBe("ERROR");
    expect(mapCleanbotTaskCode(undefined).common).toBe("IDLE");
  });
  it("product_code → 모델, 모르는 코드는 null(보류)", () => {
    expect(mapProductCode("CC1")).toBe("CC1");
    expect(mapProductCode("CC1Pro")).toBe("CC1_PRO");
    expect(mapProductCode("MT1Vac")).toBe("MT1_VAC");
    expect(mapProductCode("PuduBot")).toBeNull();
  });
  it("보고서 status → 결과, 물 사용량 ml→L, 예약 보고서는 PLANNED", () => {
    expect(mapReportStatus(4).result).toBe("COMPLETED");
    expect(mapReportStatus(6).result).toBe("ABORTED");
    const run = mapReportToRun({ task_name: "t", report_id: "r1", mode: 2, start_time: 1761580800, end_time: 1761584400, clean_time: 3540, clean_area: 820.5, create_time: "", mac: "", sn: MOCK_SN, status: 4, cost_water: 2500, timed_report_id: "x" }, { id: "PW-R-001", siteId: "site-01", floorId: "site-01-f1" }, "2026-10-28T00:00:00.000Z", null);
    expect(run.waterL).toBe(2.5);
    expect(run.durationMin).toBe(59);
    expect(run.origin).toBe("PLANNED");
    expect(run.vendorRunId).toBe("r1");
  });
  it("명령 → CleanCommands 본문. STOP 은 청소 중이면 일시정지 후 취소, AREA_CLEAN 은 미지원", () => {
    expect(buildExecBodies("START_TASK", MOCK_SN, { vendorTaskId: "t1", version: 2 }, "IDLE")![0]).toMatchObject({ type: 3, clean: { status: 1, task_id: "t1", version: 2 } });
    expect(buildExecBodies("STOP", MOCK_SN, null, "CLEANING")!.map((b) => b.clean.status)).toEqual([3, 4]);
    expect(buildExecBodies("STOP", MOCK_SN, null, "PAUSED")!.map((b) => b.clean.status)).toEqual([4]);
    expect(buildExecBodies("GO_HOME", MOCK_SN, null, "IDLE")![0].type).toBe(5);
    expect(buildExecBodies("AREA_CLEAN", MOCK_SN, null, "IDLE")).toBeNull();
    expect(buildExecBodies("START_TASK", MOCK_SN, null, "IDLE")).toBeNull();
  });
});

describe("PUDU 클라이언트·어댑터·워커 (모의 서버)", () => {
  let mock: Awaited<ReturnType<typeof startMockPudu>>;
  let state: MockState;
  let api: PuduApi;
  const db = () => getDb();

  beforeAll(async () => {
    mock = await startMockPudu();
    state = mock.state;
    process.env.VENDOR_MODE = "live";
    process.env.PUDU_API_APP_KEY = MOCK_KEY;
    process.env.PUDU_API_APP_SECRET = MOCK_SECRET;
    process.env.PUDU_API_BASE_URL = mock.url;
    process.env.PUDU_CALLBACK_CODE = "cb-secret-32bytes-xxxxxxxxxxxxxxxx";
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
    Object.assign(state, { taskCode: 0, runState: "IDLE", battery: 77, execCalls: [], requests: [], failNext: null });
  });

  async function registerMockRobot(): Promise<string> {
    const hq = await user("u-hq");
    const n = await puduImportRobots(hq, "site-01", "site-01-f1", [MOCK_SN]);
    expect(n).toBe(1);
    const r = (await db().query.robots.findFirst({ where: and(eq(schema.robots.vendor, "PUDU"), eq(schema.robots.vendorRobotId, MOCK_SN)) }))!;
    return r.id;
  }

  it("잘못된 키는 문서의 인증 오류 문구로 거부된다", async () => {
    const bad = new PuduApi(new PuduClient({ apiAppKey: MOCK_KEY, apiAppSecret: "wrong", baseUrl: mock.url, shopIds: [] }));
    await expect(bad.listShops()).rejects.toThrow(/HMAC signature does not match/);
  });

  it("연결 확인: health check → 허용 매장의 로봇만(모델 매핑, 미지원 코드는 보류, 허용 밖 매장은 조회·등록 불가)", async () => {
    const r = await puduTestConnection(await user("u-hq"));
    expect(r.ok).toBe(true);
    expect(r.robots.find((x) => x.sn === MOCK_SN)?.model).toBe("CC1");
    expect(r.robots.find((x) => x.productCode === "PuduBot")?.model).toBeNull();
    expect(r.robots.find((x) => x.sn === OTHER_SN)).toBeUndefined(); // 다른 고객사 매장의 로봇은 보이지 않는다
    expect(r.robots.every((x) => x.shopId === MOCK_SHOP)).toBe(true);
    await expect(puduImportRobots(await user("u-hq"), "site-01", "site-01-f1", ["OP2023090702"])).rejects.toThrow(/문서에 없는 모델/);
    await expect(puduImportRobots(await user("u-hq"), "site-01", "site-01-f1", [OTHER_SN])).rejects.toThrow(/허용 매장/);
    // 허용 매장이 없으면 인증은 통과해도 로봇을 내보내지 않는다
    const saved = process.env.PUDU_SHOP_IDS;
    process.env.PUDU_SHOP_IDS = "";
    const none = await puduTestConnection(await user("u-hq"));
    expect(none.ok).toBe(false);
    expect(none.message).toContain("PUDU_SHOP_IDS");
    expect(none.robots.length).toBe(0);
    process.env.PUDU_SHOP_IDS = saved;
  });

  it("live 모드에서도 샘플 적재 로봇은 실제 API 에 조회·명령하지 않는다(실제/샘플 분리)", async () => {
    const id = await registerMockRobot();
    state.requests = [];
    const r = await syncPuduStatus(new PuduAdapter(api));
    expect(r.ok).toBe(true);
    // 샘플 PUDU 로봇이 15대 있지만 상세 조회는 API 등록 로봇 1대에 대해서만 나간다
    expect(state.requests.filter((q) => q.path === "/cleanbot-service/v1/api/open/robot/detail").length).toBe(1);
    const sample = (await db().query.robots.findFirst({ where: and(eq(schema.robots.vendor, "PUDU"), eq(schema.robots.id, "PW-R-001")) }))!;
    expect(sample.vendorMeta?.source).toBeUndefined();
    expect(getAdapter(sample).isSimulation).toBe(true);
    const live = (await db().query.robots.findFirst({ where: eq(schema.robots.id, id) }))!;
    expect(getAdapter(live).isSimulation).toBe(false);
    // 샘플 로봇에 내린 명령은 모의 서버로 가지 않는다
    state.execCalls = [];
    const c = await issueCommand(await user("u-hq"), { robotId: "PW-R-001", type: "GO_HOME" });
    expect(c.simulation).not.toBeNull();
    expect(state.execCalls.length).toBe(0);
  });

  it("로봇 등록 → 상태 폴링이 상세·V2 를 공통 상태로 저장한다(오프라인 우선)", async () => {
    const id = await registerMockRobot();
    state.taskCode = 302;
    let r = await syncPuduStatus(new PuduAdapter(api));
    expect(r.ok).toBe(true);
    let st = (await db().query.robotStatus.findFirst({ where: eq(schema.robotStatus.robotId, id) }))!;
    expect(st.common).toBe("CLEANING");
    expect(st.progressPct).toBe(42);
    expect(st.batteryPct).toBe(77);
    expect(st.pose).toMatchObject({ x: 12.3, y: -4.5 });
    state.runState = "OFFLINE";
    r = await syncPuduStatus(new PuduAdapter(api));
    st = (await db().query.robotStatus.findFirst({ where: eq(schema.robotStatus.robotId, id) }))!;
    expect(st.common).toBe("OFFLINE");
    expect(st.poseIsLastKnown).toBe(true);
  });

  it("작업·예약·소모품 동기화 → 등록 작업(vendorTaskRef, product 필수)·예약에만 있는 작업도 등록·제조사 예약(읽기 전용)·소모품 잔여 수명", async () => {
    const id = await registerMockRobot();
    const robot = (await db().query.robots.findFirst({ where: eq(schema.robots.id, id) }))!;
    expect(robot.vendorMeta?.product).toBe("cleanbot"); // 등록 시 소모품 응답의 product 를 저장
    state.requests = [];
    const r = await syncPuduCatalog(api);
    expect(r.ok).toBe(true);
    expect(state.requests.some((q) => q.path === "/cleanbot-service/v1/api/open/task/list?product=cleanbot")).toBe(true);
    const tasks = await db().select().from(schema.registeredTasks).where(eq(schema.registeredTasks.robotId, id));
    const main = tasks.find((t) => t.vendorTaskRef === "897176785820073984@1694070080109")!;
    expect(main).toBeTruthy();
    // task/list 에는 없고 예약에만 있는 작업도 등록 작업으로 들어온다(실기: task/list 가 비어 있는 로봇)
    expect(tasks.find((t) => t.vendorTaskRef === "1276527192427741184@1790831844170")?.name).toBe("우천시 회전문");
    const sch = await db().select().from(schema.schedules).where(eq(schema.schedules.taskId, main.id));
    expect(sch[0]).toMatchObject({ time: "22:00", executor: "VENDOR", enabled: true });
    expect(sch[0].daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    const mnt = await db().select().from(schema.maintenanceItems).where(eq(schema.maintenanceItems.robotId, id));
    expect(mnt[0]?.remainingPct).toBe(99);
  });

  it("보고서 동기화: 종료·취소만 적재, 진행 중 제외, 중복 재실행 시 추가 없음, 물 사용량 보강", async () => {
    const id = await registerMockRobot();
    const r1 = await syncPuduReports(api, 24 * 30);
    expect(r1.ok).toBe(true);
    const runs = await db().select().from(schema.actualRuns).where(eq(schema.actualRuns.robotId, id));
    expect(runs.length).toBe(2);
    const done = runs.find((x) => x.vendorRunId === "894770283318874112")!;
    expect(done.result).toBe("COMPLETED");
    expect(done.waterL).toBe(2.5);
    expect(done.origin).toBe("PLANNED");
    expect(runs.find((x) => x.vendorRunId === "894770283318874113")?.result).toBe("ABORTED");
    // 다른 고객사 매장의 보고서는 조회 대상이 아니다(shop_id 필터)
    expect((await db().select().from(schema.actualRuns).where(eq(schema.actualRuns.vendorRobotId, OTHER_SN))).length).toBe(0);
    const r2 = await syncPuduReports(api, 24 * 30);
    expect(r2.counts?.inserted).toBe(0);
  });

  it("장애 로그 동기화: 중복 키로 1회만 적재, Error 등급 → HIGH", async () => {
    const id = await registerMockRobot();
    await syncPuduErrors(api, 24 * 30);
    await syncPuduErrors(api, 24 * 30);
    const incs = await db().select().from(schema.incidents).where(eq(schema.incidents.robotId, id));
    expect(incs.length).toBe(1);
    expect(incs[0]).toMatchObject({ code: "CleanSewageFull", severity: "HIGH", status: "OPEN" });
    // 과거 로그 적재는 현재 상태를 덮지 않는다(실기에서 정상 로봇이 ERROR 로 표시되던 문제)
    expect((await db().query.robotStatus.findFirst({ where: eq(schema.robotStatus.robotId, id) }))!.common).not.toBe("ERROR");
  });

  it("명령: 등록 작업 실행 → 접수(ACCEPTED, trace_id) → 폴링으로 실행 확인(EXECUTING)", async () => {
    const id = await registerMockRobot();
    await syncPuduCatalog(api);
    await syncPuduStatus(new PuduAdapter(api));
    const task = (await db().query.registeredTasks.findFirst({ where: eq(schema.registeredTasks.id, `task-pudu-${MOCK_SN}-897176785820073984`) }))!;
    const cmd = await issueCommand(await user("u-hq"), { robotId: id, type: "START_TASK", params: { taskId: task.id } });
    expect(cmd.state).toBe("ACCEPTED");
    expect(cmd.vendorTraceId).toMatch(/^test-app-key_/);
    expect(state.execCalls[0].body).toMatchObject({ sn: MOCK_SN, type: 3, clean: { status: 1, task_id: "897176785820073984", version: 1694070080109 } });
    expect(state.taskCode).toBe(302); // 모의 로봇이 청소 시작
    await syncPuduStatus(new PuduAdapter(api));
    expect((await db().query.commands.findFirst({ where: eq(schema.commands.id, cmd.id) }))!.state).toBe("EXECUTING");
    // 영역 청소는 PUDU 미지원 → 지원 명령 목록에 없음
    const robot = (await db().query.robots.findFirst({ where: eq(schema.robots.id, id) }))!;
    expect(robot.supportedCommands).not.toContain("AREA_CLEAN");
  });

  it("명령: 제조사 오류 응답은 FAILED, 서버 무응답은 결과 불명", async () => {
    const id = await registerMockRobot();
    await syncPuduStatus(new PuduAdapter(api));
    state.failNext = { status: 200, message: "CLEANBOT_ROBOT_OFFLINE" };
    const c1 = await issueCommand(await user("u-hq"), { robotId: id, type: "GO_HOME" });
    expect(c1.state).toBe("FAILED");
    expect(c1.message).toContain("CLEANBOT_ROBOT_OFFLINE");
    // 무응답: 존재하지 않는 서버
    process.env.PUDU_API_BASE_URL = "http://127.0.0.1:9/pudu-entry";
    process.env.PUDU_API_TIMEOUT_MS = "500";
    await db().update(schema.robotStatus).set({ common: "IDLE" }).where(eq(schema.robotStatus.robotId, id));
    const c2 = await issueCommand(await user("u-site-a"), { robotId: id, type: "GO_HOME" });
    expect(c2.state).toBe("UNKNOWN");
    process.env.PUDU_API_BASE_URL = mock.url;
    delete process.env.PUDU_API_TIMEOUT_MS;
  });

  it("콜백: CallbackCode 검증, 중복 재시도 무시, 역순 이벤트는 상태를 덮지 않음, 명령 확인", async () => {
    const id = await registerMockRobot();
    await syncPuduCatalog(api);
    await syncPuduStatus(new PuduAdapter(api));
    const task = (await db().query.registeredTasks.findFirst({ where: eq(schema.registeredTasks.id, `task-pudu-${MOCK_SN}-897176785820073984`) }))!;
    const cmd = await issueCommand(await user("u-hq"), { robotId: id, type: "START_TASK", params: { taskId: task.id } });
    const now = Math.floor(Date.now() / 1000);
    const begin = { callback_type: "notifyCleanStatus", data: { task_id: "897176785820073984", task_name: "1층 야간", status: "BEGIN", task_time: now, remark: "", sn: MOCK_SN, mac: "B4", timestamp: now, task_method: "", notify_timestamp: now * 1000 } };
    expect((await ingestPuduCallback(begin, "trace-1")).stored).toBe(true);
    expect((await ingestPuduCallback(begin, "trace-1-retry")).duplicate).toBe(true); // PUDU 재시도
    await processPuduEvents();
    expect((await db().query.commands.findFirst({ where: eq(schema.commands.id, cmd.id) }))!.state).toBe("EXECUTING");
    let st = (await db().query.robotStatus.findFirst({ where: eq(schema.robotStatus.robotId, id) })) as { common: string } | undefined;
    expect(st?.common).toBe("CLEANING");
    const end = { callback_type: "notifyCleanStatus", data: { ...begin.data, status: "END", task_time: now + 60, notify_timestamp: (now + 60) * 1000 } };
    await ingestPuduCallback(end, "trace-2");
    await processPuduEvents();
    expect((await db().query.commands.findFirst({ where: eq(schema.commands.id, cmd.id) }))!.state).toBe("COMPLETED");
    st = (await db().query.robotStatus.findFirst({ where: eq(schema.robotStatus.robotId, id) })) as { common: string } | undefined;
    expect(st?.common).toBe("IDLE");
    // 역순: 더 과거의 BEGIN 이 늦게 도착해도 IDLE 을 덮지 않는다
    const late = { callback_type: "notifyCleanStatus", data: { ...begin.data, status: "BEGIN", task_time: now - 100, notify_timestamp: (now - 100) * 1000 } };
    await ingestPuduCallback(late, "trace-3");
    await processPuduEvents();
    st = (await db().query.robotStatus.findFirst({ where: eq(schema.robotStatus.robotId, id) })) as { common: string } | undefined;
    expect(st?.common).toBe("IDLE");
    // 장애 콜백 → 장애 1건(재시도 중복 무시)
    const err = { callback_type: "robotErrorNotice", data: { sn: MOCK_SN, error_type: "CleanWaterEmpty", error_level: "Error", error_detail: "", error_id: "err-cb-1", timestamp: now + 120, extend_info: { battery: 50 } } };
    await ingestPuduCallback(err, "t4");
    await ingestPuduCallback(err, "t4");
    await processPuduEvents();
    const incs = await db().select().from(schema.incidents).where(eq(schema.incidents.robotId, id));
    expect(incs.filter((i) => i.code === "CleanWaterEmpty").length).toBe(1);
    expect(incs.find((i) => i.code === "CleanWaterEmpty")?.customerMessage).toContain("청수");
  });

  it("콜백 endpoint: 세션 없이 접근 가능(프록시 예외)하고 CallbackCode 로만 인증한다", async () => {
    // 프록시: /api/webhooks/* 는 로그인 리다이렉트 대상이 아니다(제조사 서버는 세션 쿠키가 없다)
    const hook = proxy(new NextRequest("http://localhost/api/webhooks/pudu", { method: "POST" }));
    expect(hook.headers.get("location")).toBeNull();
    const page = proxy(new NextRequest("http://localhost/admin"));
    expect(page.headers.get("location")).toContain("/login");
    // 라우트: 코드 불일치/누락 401, 일치 200, 같은 이벤트 재전송은 duplicate
    const id = await registerMockRobot();
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ callback_type: "robotErrorNotice", data: { sn: MOCK_SN, error_type: "CleanWaterEmpty", error_level: "Warning", error_detail: "", error_id: "err-route-1", timestamp: now } });
    const post = (headers: Record<string, string>) => POST(new Request("http://localhost/api/webhooks/pudu", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body }));
    expect((await post({ CallbackCode: "wrong" })).status).toBe(401);
    expect((await post({})).status).toBe(401);
    const ok = await post({ CallbackCode: process.env.PUDU_CALLBACK_CODE!, TraceId: "t-route" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, stored: true, duplicate: false });
    expect(await (await post({ CallbackCode: process.env.PUDU_CALLBACK_CODE! })).json()).toMatchObject({ stored: false, duplicate: true });
    await processPuduEvents();
    const incs = await db().select().from(schema.incidents).where(eq(schema.incidents.robotId, id));
    expect(incs.filter((i) => i.code === "CleanWaterEmpty").length).toBe(1);
    expect(incs.find((i) => i.code === "CleanWaterEmpty")?.severity).toBe("MEDIUM");
  });

  it("접수 후 실행 확인이 없으면 타임아웃으로 결과 불명", async () => {
    const id = await registerMockRobot();
    await syncPuduStatus(new PuduAdapter(api));
    const cmd = await issueCommand(await user("u-hq"), { robotId: id, type: "GO_HOME" });
    state.taskCode = 0; // 로봇이 반응하지 않음
    await db().update(schema.commands).set({ stateChangedAt: new Date(Date.now() - 120_000).toISOString() }).where(eq(schema.commands.id, cmd.id));
    const robot = (await db().query.robots.findFirst({ where: eq(schema.robots.id, id) }))!;
    await confirmPendingCommands(robot, "IDLE");
    expect((await db().query.commands.findFirst({ where: eq(schema.commands.id, cmd.id) }))!.state).toBe("UNKNOWN");
  });
});
