import { generateKeyPairSync, verify } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { BibApi } from "@/lib/vendors/bib/api";
import { BibClient, type BibFetch } from "@/lib/vendors/bib/client";
import { mapBibStatus } from "@/lib/vendors/bib/mapping";
import { syncBibCatalog, syncBibStatus } from "@/worker/bib";
import { getDb, resetAndSeed, schema } from "./helpers";

/** BIB(라이노스) 파트너 API — 가이드 v0.1 의 로그인 서명·토큰·조회 응답을 가짜 서버로 재현(실 계정 값 없음). */
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const ID = "test-partner";
const RID = "11111111-2222-4333-8444-555555555555";

function fakeServer(opts: { expireFirst?: boolean; task?: () => string | null } = {}) {
  const calls: { method: string; path: string; auth?: string }[] = [];
  let logins = 0;
  const f: BibFetch = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace("/rhibot/api", "");
    calls.push({ method: init.method, path, auth: init.headers.Authorization });
    const json = (status: number, b: unknown) => ({ status, json: async () => b, text: async () => JSON.stringify(b) });
    if (path === "/partner/v1/auth/service") {
      const b = JSON.parse(init.body!) as { serviceKey: string; timestamp: number; nonceB64: string; signatureB64: string };
      const ok = b.serviceKey === ID && Math.abs(b.timestamp - Date.now() / 1000) < 180 && verify(null, Buffer.from(b.serviceKey + b.timestamp + b.nonceB64, "utf8"), publicKey, Buffer.from(b.signatureB64, "base64"));
      if (!ok) return json(400, { statusCode: 400, errorCode: "PARAMETER_INVALID" });
      logins += 1;
      return json(201, { accessToken: `tok-${logins}`, expiresIn: 86400, expiresAt: new Date(Date.now() + 86400_000).toISOString(), tokenType: "Bearer" });
    }
    if (opts.expireFirst && init.headers.Authorization === "Bearer tok-1") return json(401, { statusCode: 401, errorCode: "UNAUTHORIZED" });
    if (path === "/partner/v1/robot/list") return json(200, { robotListCountTotal: 1, robotList: [{ robotId: RID, handle1: "J40-TEST-0001", name: "CG_테스트", availableActionList: ["task:start"] }] });
    if (path.endsWith("/status")) return json(200, { robotId: RID, online: true, batteryPercent: 77, movingStatus: "MOVING", activityState: "BUSY", actionReadinessList: [], timeObserved: "2026-11-26T09:00:00.000Z", timeReceived: "2026-11-26T09:00:01.000Z", freshness: "FRESH" });
    if (path.endsWith("/task/current")) {
      const t = opts.task ? opts.task() : "task_abc";
      return json(200, { supported: true, task: t ? { taskId: t, state: "UNKNOWN" } : null });
    }
    if (path.endsWith("/task/list")) return json(200, { taskList: [{ taskId: "task_abc", name: "CGP4F_전체 진공흡입" }, { taskId: "task_def", name: null }] });
    if (path.endsWith("/localmap/list")) return json(200, { robotId: RID, activeMapHandle: "m-6", localMapList: [{ mapHandle: "m-6", name: "CGP6F" }] });
    return json(404, { statusCode: 404, errorCode: "RESOURCE_NOT_FOUND" });
  };
  return { f, calls, logins: () => logins };
}
const cfg = { baseUrl: "https://bib.example.invalid/rhibot/api", serviceKey: ID, privateKey, timeoutMs: 5000 };

describe("BIB 파트너 API 클라이언트(조회 전용)", () => {
  it("서명 로그인(아이디+시각+난수, Ed25519) → 토큰을 재사용하고 Bearer 로 조회", async () => {
    const s = fakeServer();
    const api = new BibApi(new BibClient(cfg, s.f));
    expect((await api.listRobots())[0].handle1).toBe("J40-TEST-0001");
    await api.status(RID);
    expect(s.logins()).toBe(1); // 매 요청 로그인하지 않음
    expect(s.calls.filter((c) => c.method === "GET").every((c) => c.auth === "Bearer tok-1")).toBe(true);
  });

  it("조회 401 이면 한 번만 다시 로그인해 재요청", async () => {
    const s = fakeServer({ expireFirst: true });
    const api = new BibApi(new BibClient(cfg, s.f));
    await api.status(RID);
    expect(s.logins()).toBe(2);
  });

  it("제어 경로는 요청 전에 막는다(작업 시작·일시정지 등)", async () => {
    const s = fakeServer();
    const c = new BibClient(cfg, s.f);
    for (const p of [`/partner/v1/robot/${RID}/task/task_abc/start`, `/partner/v1/robot/${RID}/task/task_abc/action/pause`, "/partner/v1/auth/service"]) {
      await expect(c.get(p)).rejects.toThrow(/조회 전용/);
    }
    expect(s.calls).toHaveLength(0);
  });

  it("상태 매핑: 작업 있는 BUSY=청소 중, 작업 없는 BUSY=대기, 오프라인·일시정지", () => {
    const base = { robotId: RID, online: true, batteryPercent: 50, movingStatus: "STOPPED", timeObserved: null, timeReceived: "", freshness: "FRESH" };
    expect(mapBibStatus({ ...base, activityState: "BUSY" }, { supported: true, task: { taskId: "t", state: "UNKNOWN" } }).common).toBe("CLEANING");
    expect(mapBibStatus({ ...base, activityState: "BUSY" }, { supported: true, task: null }).common).toBe("IDLE");
    expect(mapBibStatus({ ...base, activityState: "WORKING" }, null).common).toBe("CLEANING");
    expect(mapBibStatus({ ...base, activityState: "PAUSED" }, null).common).toBe("PAUSED");
    expect(mapBibStatus({ ...base, online: false, activityState: "IDLE" }, null).common).toBe("OFFLINE");
  });
});

describe("BIB 동기화(워커)", () => {
  beforeEach(async () => {
    await resetAndSeed();
    const site = (await getDb().select().from(schema.sites))[0];
    const floor = (await getDb().select().from(schema.floors).where(eq(schema.floors.siteId, site.id)))[0];
    await getDb().insert(schema.robots).values({ id: "PW-R-BIB-T", vendor: "BIB", model: "J40", vendorRobotId: "J40-TEST-0001", siteId: site.id, floorId: floor.id, name: "CG 시험", serial: "J40-TEST-0001", active: false, supportedCommands: [], vendorMeta: { source: "pending", sn: "J40-TEST-0001" } });
  });

  it("일련번호로 연결·다시 사용·등록 작업 → 상태(배터리·청소 중·현재 지도) 저장, 층은 바꾸지 않음", async () => {
    const s = fakeServer();
    const api = new BibApi(new BibClient(cfg, s.f));
    const c = await syncBibCatalog(api);
    expect(c.ok).toBe(true);
    const r = (await getDb().select().from(schema.robots).where(eq(schema.robots.id, "PW-R-BIB-T")))[0];
    expect(r).toMatchObject({ vendorRobotId: RID, active: true });
    expect(r.vendorMeta).toMatchObject({ source: "api", bibRobotId: RID });
    const tasks = await getDb().select().from(schema.registeredTasks).where(eq(schema.registeredTasks.robotId, "PW-R-BIB-T"));
    expect(tasks.map((t) => t.name).sort()).toEqual(["CGP4F_전체 진공흡입", "task_def"]);
    const st = await syncBibStatus(api);
    expect(st.ok).toBe(true);
    const status = (await getDb().select().from(schema.robotStatus).where(eq(schema.robotStatus.robotId, "PW-R-BIB-T")))[0];
    expect(status).toMatchObject({ common: "CLEANING", batteryPct: 77, online: true, currentMissionId: "task_abc" });
    expect(status.raw).toContain("map=CGP6F");
    expect((await getDb().select().from(schema.robots).where(eq(schema.robots.id, "PW-R-BIB-T")))[0].floorId).toBe(r.floorId);
  });

  it("관측 기반 작업 기록: 작업이 나타났다 사라지면 실적 1건(면적 0·관측 표시), 1분 미만은 버림", async () => {
    let task: string | null = "task_abc";
    const s = fakeServer({ task: () => task });
    const api = new BibApi(new BibClient(cfg, s.f));
    await syncBibCatalog(api);
    await syncBibStatus(api);
    const st = (await getDb().select().from(schema.robotStatus).where(eq(schema.robotStatus.robotId, "PW-R-BIB-T")))[0];
    expect((st.rawPayload as { obs: { taskId: string } }).obs.taskId).toBe("task_abc");
    // 25분 전에 시작한 것으로 당긴 뒤 작업 종료
    const started = new Date(Date.now() - 25 * 60_000).toISOString();
    await getDb().update(schema.robotStatus).set({ rawPayload: { ...(st.rawPayload as object), obs: { taskId: "task_abc", startedAt: started } } }).where(eq(schema.robotStatus.robotId, "PW-R-BIB-T"));
    task = null;
    await syncBibStatus(api);
    await syncBibStatus(api); // 다시 돌려도 중복 없음
    const runs = await getDb().select().from(schema.actualRuns).where(eq(schema.actualRuns.robotId, "PW-R-BIB-T"));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ vendor: "BIB", areaM2: 0, durationMin: 25, result: "COMPLETED", origin: "ADHOC" });
    expect(runs[0].endReason).toContain("관측 기반");
    expect(runs[0].endReason).toContain("CGP4F_전체 진공흡입");
    // 1분 미만 작업은 남기지 않음
    task = "task_def";
    await syncBibStatus(api);
    task = null;
    await syncBibStatus(api);
    expect(await getDb().select().from(schema.actualRuns).where(eq(schema.actualRuns.robotId, "PW-R-BIB-T"))).toHaveLength(1);
  });
});
