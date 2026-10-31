import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { buildQuery, contentMd5, signRequest, signingString, verifySignature } from "@/lib/vendors/pudu/signing";
import { PuduClient } from "@/lib/vendors/pudu/client";
import { PuduApi } from "@/lib/vendors/pudu/api";
import { buildExecBodies, mapCleanbotTaskCode, mapProductCode, mapReportStatus, mapReportToRun } from "@/lib/vendors/pudu/mapping";
import { PuduAdapter } from "@/lib/vendors/pudu/puduAdapter";
import { ingestPuduCallback } from "@/lib/vendors/pudu/webhook";
import { confirmPendingCommands, processPuduEvents, syncPuduCatalog, syncPuduErrors, syncPuduPlannedRuns, syncPuduReports, syncPuduStatus } from "@/worker/pudu";
import { addMinutes, localDateKey, localToUtcIso, nowIso } from "@/lib/util/time";
import { addDays } from "@/lib/reports/schedule";
import { issueCommand } from "@/lib/services/commands";
import { toggleSchedule } from "@/lib/services/tasks";
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
  it("명령 → CleanCommands 본문. 모든 명령에 task_id/version, STOP 은 청소 중이면 일시정지 후 취소, AREA_CLEAN 은 미지원", () => {
    const t = { vendorTaskId: "t1", version: 2, name: "n" };
    expect(buildExecBodies("START_TASK", MOCK_SN, t, "IDLE")![0]).toMatchObject({ type: 3, clean: { status: 1, task_id: "t1", version: 2 } });
    expect(buildExecBodies("PAUSE", MOCK_SN, t, "CLEANING")![0]).toMatchObject({ type: 3, clean: { status: 3, task_id: "t1", version: 2, name: "n" } });
    expect(buildExecBodies("STOP", MOCK_SN, t, "CLEANING")!.map((b) => b.clean.status)).toEqual([3, 4]);
    expect(buildExecBodies("STOP", MOCK_SN, t, "PAUSED")!.map((b) => b.clean.status)).toEqual([4]);
    expect(buildExecBodies("GO_HOME", MOCK_SN, t, "IDLE")![0]).toMatchObject({ type: 5, clean: { status: 1, task_id: "t1" } });
    expect(buildExecBodies("AREA_CLEAN", MOCK_SN, t, "IDLE")).toBeNull();
    expect(buildExecBodies("START_TASK", MOCK_SN, null, "IDLE")).toBeNull();
    expect(buildExecBodies("PAUSE", MOCK_SN, null, "CLEANING")).toBeNull(); // 작업 정보 없이는 보내지 않는다(실기: TASK_IS_EMPTY)
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
    Object.assign(state, { taskCode: 0, runState: "IDLE", battery: 77, execCalls: [], requests: [], failNext: null, mapName: undefined });
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
    expect(st.pose).toBeNull(); // 샘플 지도 층: 미터 좌표를 px 로 그리지 않는다(제조사 지도를 가져온 층에서만 변환) — tests/sites.test.ts
    expect(st.raw).toContain("pos=(12.3, -4.5)m map=1#1#lobby");
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
    expect(incs[0]).toMatchObject({ code: "CleanSewageFull", severity: "HIGH", status: "OPEN", occurrences: 2 }); // 25분 뒤 재발생은 묶음
    expect(incs[0].lastOccurredAt).toBe("2026-10-27T14:30:00.000Z");
    expect(incs[0].rawMessage).toContain("again");
    // 과거 로그 적재는 현재 상태를 덮지 않는다(실기에서 정상 로봇이 ERROR 로 표시되던 문제)
    expect((await db().query.robotStatus.findFirst({ where: eq(schema.robotStatus.robotId, id) }))!.common).not.toBe("ERROR");
  });

  it("예약 → 계획 회차: 오늘·내일만 만들고(멱등), 3시간 지나면 실적과 맞춰 수행/미실행 판정", async () => {
    const id = await registerMockRobot();
    await db().insert(schema.registeredTasks).values({ id: "task-plan-t", siteId: "site-01", robotId: id, name: "야간 청소", zoneIds: [], mode: "SCRUB", vendorTaskRef: "t@1" });
    await db().insert(schema.schedules).values({ id: "sch-plan-t", taskId: "task-plan-t", daysOfWeek: [0, 1, 2, 3, 4, 5, 6], time: "10:00", enabled: true, executor: "VENDOR" });
    const d0 = localDateKey(nowIso());
    const at = (day: string, hhmm: string) => localToUtcIso(day, hhmm);
    const r1 = await syncPuduPlannedRuns(at(d0, "12:00"));
    expect(r1.counts).toMatchObject({ created: 2, done: 0, missed: 0 });
    expect((await syncPuduPlannedRuns(at(d0, "12:00"))).counts?.created).toBe(0);
    const startedAt = at(d0, "10:20");
    await db().insert(schema.actualRuns).values({ id: "run-plan-t", vendor: "PUDU", vendorRobotId: MOCK_SN, vendorRunId: "vr-plan-t", robotId: id, siteId: "site-01", floorId: "site-01-f1", taskId: null, zoneIds: [], startedAt, endedAt: addMinutes(startedAt, 40), result: "COMPLETED", endReason: null, areaM2: 300, durationMin: 40, waterL: null, detergentMl: null, origin: "PLANNED", receivedAt: addMinutes(startedAt, 50) });
    expect((await syncPuduPlannedRuns(at(d0, "14:00"))).counts).toMatchObject({ done: 1, missed: 0 });
    const d1 = addDays(d0, 1);
    expect((await syncPuduPlannedRuns(at(d1, "14:00"))).counts).toMatchObject({ created: 1, done: 0, missed: 1 }); // 내일(d1) 실적 없음, 모레 회차 생성
    const plans = await db().select().from(schema.plannedRuns).where(eq(schema.plannedRuns.robotId, id)).orderBy(schema.plannedRuns.plannedAt);
    expect(plans.map((p) => p.status)).toEqual(["DONE", "MISSED", "PLANNED"]);
    expect(plans[0].actualRunId).toBe("run-plan-t");
    // 긴 작업: 보고서가 늦게 올라오면 '미실행' 판정을 48시간 안에 다시 맞춘다
    const late = at(d1, "10:30");
    await db().insert(schema.actualRuns).values({ id: "run-plan-late", vendor: "PUDU", vendorRobotId: MOCK_SN, vendorRunId: "vr-plan-late", robotId: id, siteId: "site-01", floorId: "site-01-f1", taskId: null, zoneIds: [], startedAt: late, endedAt: addMinutes(late, 240), result: "COMPLETED", endReason: null, areaM2: 900, durationMin: 240, waterL: null, detergentMl: null, origin: "PLANNED", receivedAt: addMinutes(late, 250) });
    await syncPuduPlannedRuns(at(d1, "15:00"));
    expect((await db().query.plannedRuns.findFirst({ where: eq(schema.plannedRuns.id, plans[1].id) }))!).toMatchObject({ status: "DONE", actualRunId: "run-plan-late" });
  });

  it("폴링 알림: 방금 생긴 장애 로그는 수신자에게 알림, 오래된 로그는 보내지 않음", async () => {
    const id = await registerMockRobot();
    const saved = state.errors;
    const kst = (msAgo: number) => new Date(Date.now() - msAgo + 9 * 3600_000).toISOString().replace("T", " ").slice(0, 19);
    state.errors = [
      { ...saved[0], id: "f1", error_id: "fresh-1", error_type: "FreshFault", task_time: kst(5 * 60_000) },
      { ...saved[0], id: "o1", error_id: "old-1", error_type: "OldFault", task_time: kst(3 * 3600_000) },
    ];
    try {
      await syncPuduErrors(api, 24);
      const incs = await db().select().from(schema.incidents).where(eq(schema.incidents.robotId, id));
      const logs = async (code: string) => db().select().from(schema.notificationLogs).where(eq(schema.notificationLogs.incidentId, incs.find((i) => i.code === code)!.id));
      expect((await logs("FreshFault")).length).toBeGreaterThan(0); // 샘플 사업장 1 수신자 설정(모의 발송/억제 기록)
      expect((await logs("OldFault")).length).toBe(0);
    } finally {
      state.errors = saved;
    }
  });

  it("과거 이력 적재(구간 지정): 7일보다 오래된 장애 로그는 복구 상태 이력으로, 같은 코드끼리 묶는다", async () => {
    const id = await registerMockRobot();
    const saved = state.errors;
    const kst = (daysAgo: number, hhmm: string) => {
      const d = new Date(Date.now() - daysAgo * 86_400_000 + 9 * 3600_000).toISOString().slice(0, 10);
      return `${d} ${hhmm}:00`;
    };
    state.errors = [
      { ...saved[0], id: "h1", error_id: "hist-1", task_time: kst(30, "10:00") },
      { ...saved[0], id: "h2", error_id: "hist-2", task_time: kst(30, "11:00"), error_detail: "sewage tank full later" },
      { ...saved[0], id: "h3", error_id: "recent-1", task_time: kst(1, "10:00") },
    ];
    try {
      const end = Math.floor(Date.now() / 1000);
      const r = await syncPuduErrors(api, 0, { start: end - 40 * 86_400, end });
      expect(r.ok).toBe(true);
      const incs = await db().select().from(schema.incidents).where(eq(schema.incidents.robotId, id)).orderBy(schema.incidents.occurredAt);
      expect(incs.length).toBe(2);
      expect(incs[0]).toMatchObject({ status: "RESOLVED", occurrences: 2 });
      expect(incs[0].resolvedAt).toBe(incs[0].lastOccurredAt);
      const acts = await db().select().from(schema.incidentActions).where(eq(schema.incidentActions.incidentId, incs[0].id));
      expect(acts[0].note).toContain("이력");
      expect(incs[1].status).toBe("OPEN"); // 최근 것은 조치 대상
    } finally {
      state.errors = saved;
    }
  });

  it("명령 안전장치: 상태가 오래되면 거부, 실행 확인 전 시작은 두 번 보내지 않음, PUDU 예약은 화면에서 못 바꿈", async () => {
    const id = await registerMockRobot();
    await syncPuduCatalog(api);
    await syncPuduStatus(new PuduAdapter(api));
    const task = (await db().query.registeredTasks.findFirst({ where: eq(schema.registeredTasks.id, `task-pudu-${MOCK_SN}-897176785820073984`) }))!;
    const hq = await user("u-hq");
    await db().update(schema.robotStatus).set({ lastReceivedAt: addMinutes(nowIso(), -30) }).where(eq(schema.robotStatus.robotId, id));
    await expect(issueCommand(hq, { robotId: id, type: "START_TASK", params: { taskId: task.id } })).rejects.toThrow(/갱신되지 않아/);
    expect(state.execCalls.length).toBe(0);
    await syncPuduStatus(new PuduAdapter(api));
    expect((await issueCommand(hq, { robotId: id, type: "START_TASK", params: { taskId: task.id } })).state).toBe("ACCEPTED");
    await expect(issueCommand(await user("u-site-a"), { robotId: id, type: "START_TASK", params: { taskId: task.id } })).rejects.toThrow(/처리 중/);
    expect(state.execCalls.length).toBe(1);
    // PUDU 에서 지운 예약은 동기화 때 사용 중지, PUDU 예약 토글은 거부
    await db().insert(schema.schedules).values({ id: `sch-pudu-${MOCK_SN}-gone-1`, taskId: task.id, daysOfWeek: [1], time: "09:00", enabled: true, executor: "VENDOR" });
    await syncPuduCatalog(api);
    expect((await db().query.schedules.findFirst({ where: eq(schema.schedules.id, `sch-pudu-${MOCK_SN}-gone-1`) }))!.enabled).toBe(false);
    const live = (await db().select().from(schema.schedules).where(eq(schema.schedules.taskId, task.id))).find((x) => x.enabled)!;
    await expect(toggleSchedule(hq, live.id, false)).rejects.toThrow(/PUDU 앱/);
  });

  it("명령: 등록 작업 실행 → 접수(ACCEPTED, trace_id) → 폴링으로 실행 확인(EXECUTING)", async () => {
    const id = await registerMockRobot();
    await syncPuduCatalog(api);
    await syncPuduStatus(new PuduAdapter(api));
    const task = (await db().query.registeredTasks.findFirst({ where: eq(schema.registeredTasks.id, `task-pudu-${MOCK_SN}-897176785820073984`) }))!;
    const cmd = await issueCommand(await user("u-hq"), { robotId: id, type: "START_TASK", params: { taskId: task.id } });
    expect(cmd.state).toBe("ACCEPTED");
    expect(cmd.vendorTraceId).toBeTruthy();
    expect(cmd.vendorTraceId).not.toContain(MOCK_KEY); // trace_id 의 키 접두사는 떼고 저장
    expect(state.execCalls[0].body).toMatchObject({ sn: MOCK_SN, type: 3, clean: { status: 1, task_id: "897176785820073984", version: 1694070080109 } });
    expect(state.taskCode).toBe(302); // 모의 로봇이 청소 시작
    await syncPuduStatus(new PuduAdapter(api));
    expect((await db().query.commands.findFirst({ where: eq(schema.commands.id, cmd.id) }))!.state).toBe("EXECUTING");
    // 일시정지 → 재개 → 중단(일시정지 후 취소) → 복귀: 모두 진행 중 작업의 task_id 를 붙인다
    const pause = await issueCommand(await user("u-hq"), { robotId: id, type: "PAUSE" });
    expect(pause.state).toBe("ACCEPTED");
    expect(state.execCalls.at(-1)!.body).toMatchObject({ type: 3, clean: { status: 3, task_id: "897176785820073984", version: 1694070080109 } });
    await syncPuduStatus(new PuduAdapter(api)); // 301 → PAUSED
    expect((await db().query.commands.findFirst({ where: eq(schema.commands.id, pause.id) }))!.state).toBe("COMPLETED");
    const resume = await issueCommand(await user("u-hq"), { robotId: id, type: "RESUME" });
    expect(resume.state).toBe("ACCEPTED");
    await syncPuduStatus(new PuduAdapter(api)); // 302
    const stop = await issueCommand(await user("u-hq"), { robotId: id, type: "STOP" });
    expect(stop.state).toBe("ACCEPTED");
    expect(state.execCalls.slice(-2).map((c) => (c.body as { clean: { status: number; task_id?: string } }).clean)).toMatchObject([{ status: 3, task_id: "897176785820073984" }, { status: 4, task_id: "897176785820073984" }]);
    await syncPuduStatus(new PuduAdapter(api)); // 303 → IDLE(취소 처리)
    expect((await db().query.commands.findFirst({ where: eq(schema.commands.id, stop.id) }))!.state).toBe("COMPLETED");
    // 취소 직후(303)에는 제조사가 복귀를 거부(CLEANBOT_CLEANING_CANCELED) → 어댑터가 303 이 풀릴 때까지 기다렸다가 보낸다
    const home = await issueCommand(await user("u-hq"), { robotId: id, type: "GO_HOME" });
    expect(home.state).toBe("ACCEPTED");
    expect(state.execCalls.filter((c) => (c.body as { message?: string }).message).length).toBe(0);
    expect(state.execCalls.at(-1)!.body).toMatchObject({ type: 5, clean: { status: 1, task_id: "897176785820073984" } }); // 마지막 작업(last_task)으로 보강
    await syncPuduStatus(new PuduAdapter(api)); // 102 → RETURNING
    expect((await db().query.commands.findFirst({ where: eq(schema.commands.id, home.id) }))!.state).toBe("EXECUTING");
    state.taskCode = 202;
    await syncPuduStatus(new PuduAdapter(api));
    expect((await db().query.commands.findFirst({ where: eq(schema.commands.id, home.id) }))!.state).toBe("COMPLETED");
    // 영역 청소는 PUDU 미지원 → 지원 명령 목록에 없음
    const robot = (await db().query.robots.findFirst({ where: eq(schema.robots.id, id) }))!;
    expect(robot.supportedCommands).not.toContain("AREA_CLEAN");
  });

  it("명령: 제조사 오류 응답은 FAILED, 서버 무응답은 결과 불명", async () => {
    const id = await registerMockRobot();
    await syncPuduCatalog(api); // 복귀 명령도 마지막 작업 정보가 필요
    await syncPuduStatus(new PuduAdapter(api));
    state.failNext = { status: 200, message: "CLEANBOT_ROBOT_OFFLINE", path: "/cleanbot-service/v1/api/open/task/exec" };
    const c1 = await issueCommand(await user("u-hq"), { robotId: id, type: "GO_HOME" });
    expect(c1.state).toBe("FAILED");
    expect(c1.message).toContain("CLEANBOT_ROBOT_OFFLINE");
    // 무응답: 존재하지 않는 서버
    process.env.PUDU_API_BASE_URL = "http://127.0.0.1:9/pudu-entry";
    process.env.PUDU_API_TIMEOUT_MS = "500";
    try {
      await db().update(schema.robotStatus).set({ common: "IDLE" }).where(eq(schema.robotStatus.robotId, id));
      const c2 = await issueCommand(await user("u-site-a"), { robotId: id, type: "GO_HOME" });
      expect(c2.state).toBe("UNKNOWN"); // 상세 조회가 안 돼도 기억해 둔 마지막 작업으로 본문을 만들고, 무응답은 결과 불명
    } finally {
      process.env.PUDU_API_BASE_URL = mock.url;
      delete process.env.PUDU_API_TIMEOUT_MS;
    }
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
    // 관리 화면 자가 점검용 selfTest 는 저장하지 않고 응답만 한다(CallbackCode 는 필요)
    const self = await POST(new Request("http://localhost/api/webhooks/pudu", { method: "POST", headers: { "Content-Type": "application/json", CallbackCode: process.env.PUDU_CALLBACK_CODE! }, body: JSON.stringify({ callback_type: "selfTest", data: {} }) }));
    expect(await self.json()).toMatchObject({ ok: true, selfTest: true });
    expect((await db().select().from(schema.vendorEvents)).some((e) => e.eventType === "selfTest")).toBe(false);
    await processPuduEvents();
    const incs = await db().select().from(schema.incidents).where(eq(schema.incidents.robotId, id));
    expect(incs.filter((i) => i.code === "CleanWaterEmpty").length).toBe(1);
    expect(incs.find((i) => i.code === "CleanWaterEmpty")?.severity).toBe("MEDIUM");
  });

  it("접수 후 실행 확인이 없으면 타임아웃으로 결과 불명", async () => {
    const id = await registerMockRobot();
    await syncPuduCatalog(api);
    await syncPuduStatus(new PuduAdapter(api));
    const cmd = await issueCommand(await user("u-hq"), { robotId: id, type: "GO_HOME" });
    state.taskCode = 0; // 로봇이 반응하지 않음
    await db().update(schema.commands).set({ stateChangedAt: new Date(Date.now() - 120_000).toISOString() }).where(eq(schema.commands.id, cmd.id));
    const robot = (await db().query.robots.findFirst({ where: eq(schema.robots.id, id) }))!;
    await confirmPendingCommands(robot, "IDLE");
    expect((await db().query.commands.findFirst({ where: eq(schema.commands.id, cmd.id) }))!.state).toBe("UNKNOWN");
  });
});
