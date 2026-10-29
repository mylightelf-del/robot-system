import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { checkDb, checkEnv, migrationCountInRepo, summarize } from "@/lib/ops/preflight";
import { HEARTBEAT_ID, purgeOldVendorEvents, workerStatus, writeHeartbeat } from "@/lib/ops/heartbeat";
import { GET as health } from "@/app/api/health/route";
import { POST as webhook } from "@/app/api/webhooks/pudu/route";
import { getDb, resetAndSeed, schema } from "./helpers";

describe("배포 전 점검·운영 보조", () => {
  const db = getDb;
  beforeEach(async () => {
    await resetAndSeed();
  });

  it("환경변수 규칙: 운영에서 https·샘플 초기화·PUDU live 필수값을 검사한다", () => {
    const bad = checkEnv({ APP_ENV: "production", APP_BASE_URL: "http://localhost:3000", ALLOW_SAMPLE_RESET: "true", VENDOR_MODE: "live", PUDU_API_APP_KEY: "k", PUDU_API_APP_SECRET: "s", PUDU_API_CLUSTER: "mars", PUDU_SHOP_IDS: "" } as unknown as NodeJS.ProcessEnv);
    const codes = bad.filter((f) => f.level === "error").map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(["DATABASE_URL", "APP_BASE_URL", "ALLOW_SAMPLE_RESET", "PUDU_CLUSTER", "PUDU_SHOP_IDS"]));
    expect(summarize(bad).errors).toBeGreaterThanOrEqual(5);

    const good = checkEnv({ DATABASE_URL: "postgres://x", APP_ENV: "production", APP_BASE_URL: "https://robot.example.com", ALLOW_SAMPLE_RESET: "false", VENDOR_MODE: "live", PUDU_API_APP_KEY: "k", PUDU_API_APP_SECRET: "s", PUDU_API_CLUSTER: "sea", PUDU_SHOP_IDS: "602550006,641450007", PUDU_CALLBACK_CODE: "abcdefghijklmnopqrstuvwxyz012345", DOMAIN: "robot.example.com", ACME_EMAIL: "ops@example.com" } as unknown as NodeJS.ProcessEnv);
    expect(summarize(good).errors).toBe(0);
    expect(good.find((f) => f.code === "ENV")?.level).toBe("ok");
    // 도메인 불일치·ACME 이메일 없음은 주의
    const dom = checkEnv({ DATABASE_URL: "postgres://x", APP_ENV: "production", APP_BASE_URL: "https://widebot.kro.kr", DOMAIN: "other.kro.kr", ALLOW_SAMPLE_RESET: "false", VENDOR_MODE: "sample" } as unknown as NodeJS.ProcessEnv);
    expect(dom.find((f) => f.code === "DOMAIN")?.level).toBe("warn");
    expect(dom.find((f) => f.code === "ACME_EMAIL")?.level).toBe("warn");

    // 콜백 코드 없음은 '주의'(폴링만으로 동작), 개발 환경의 localhost 는 허용
    const dev = checkEnv({ DATABASE_URL: "postgres://x", APP_ENV: "development", APP_BASE_URL: "http://localhost:3000", VENDOR_MODE: "live", PUDU_API_APP_KEY: "k", PUDU_API_APP_SECRET: "s", PUDU_API_CLUSTER: "sea", PUDU_SHOP_IDS: "1" } as unknown as NodeJS.ProcessEnv);
    expect(summarize(dev).errors).toBe(0);
    expect(dev.find((f) => f.code === "PUDU_CALLBACK_CODE")?.level).toBe("warn");
    // 비밀값은 메시지에 나오지 않는다
    expect(JSON.stringify([...bad, ...good, ...dev])).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
  });

  it("DB 점검: 연결·마이그레이션 수·관리자·샘플·워커 하트비트", async () => {
    const expected = migrationCountInRepo();
    expect(expected).toBeGreaterThanOrEqual(6);
    let f = await checkDb(db(), { expectedMigrations: expected, production: true });
    expect(f.find((x) => x.code === "DB")?.level).toBe("ok");
    expect(f.find((x) => x.code === "MIGRATIONS")?.level).toBe("ok");
    expect(f.find((x) => x.code === "SAMPLE_DATA")?.level).toBe("warn"); // 시드에는 샘플 사업장이 있다
    expect(f.find((x) => x.code === "WORKER")?.level).toBe("warn");
    expect(f.find((x) => x.code === "ADMIN")).toBeUndefined(); // 시드에 본사 관리자 있음
    // 저장소보다 많은 마이그레이션을 기대하면 오류
    f = await checkDb(db(), { expectedMigrations: expected + 1 });
    expect(f.find((x) => x.code === "MIGRATIONS")?.level).toBe("error");
    await writeHeartbeat({ test: true });
    f = await checkDb(db(), { expectedMigrations: expected });
    expect(f.find((x) => x.code === "WORKER")).toBeUndefined();
  });

  it("워커 하트비트 → /api/health 의 worker 상태(up/stale/unknown)", async () => {
    expect((await workerStatus()).state).toBe("unknown");
    await writeHeartbeat();
    expect((await workerStatus()).state).toBe("up");
    expect((await workerStatus(Date.now() + 10 * 60_000)).state).toBe("stale");
    const res = await health();
    const body = (await res.json()) as { ok: boolean; db: string; worker: string; workerAgeSeconds: number };
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, db: "up", worker: "up" });
    expect(body.workerAgeSeconds).toBeLessThan(60);
    // 비밀값·내부 정보 없음
    expect(Object.keys(body).sort()).toEqual(["db", "ok", "time", "worker", "workerAgeSeconds"]);
    expect(await db().query.vendorSyncState.findFirst({ where: eq(schema.vendorSyncState.id, HEARTBEAT_ID) })).toBeTruthy();
  });

  it("보관 정책: 처리 끝난 콜백 원문만 N일 뒤 삭제, 미처리는 남긴다", async () => {
    const old = new Date(Date.now() - 40 * 86400_000).toISOString();
    const recent = new Date(Date.now() - 5 * 86400_000).toISOString();
    await db().insert(schema.vendorEvents).values([
      { id: "ev-old-done", vendor: "PUDU", eventKey: "k1", eventType: "robotStatus", vendorRobotId: "x", payload: {}, receivedAt: old, occurredAt: old, processedAt: old, processError: null, traceId: null },
      { id: "ev-old-pending", vendor: "PUDU", eventKey: "k2", eventType: "robotStatus", vendorRobotId: "x", payload: {}, receivedAt: old, occurredAt: old, processedAt: null, processError: null, traceId: null },
      { id: "ev-recent-done", vendor: "PUDU", eventKey: "k3", eventType: "robotStatus", vendorRobotId: "x", payload: {}, receivedAt: recent, occurredAt: recent, processedAt: recent, processError: null, traceId: null },
    ]);
    expect(await purgeOldVendorEvents(30)).toBe(1);
    const left = (await db().select({ id: schema.vendorEvents.id }).from(schema.vendorEvents)).map((r) => r.id).sort();
    expect(left).toEqual(["ev-old-pending", "ev-recent-done"]);
    expect(await purgeOldVendorEvents(0)).toBe(0); // 0 이면 비활성
  });

  it("콜백 endpoint: 256KB 초과 본문은 413", async () => {
    process.env.PUDU_CALLBACK_CODE = "cb-secret-32bytes-xxxxxxxxxxxxxxxx";
    const big = JSON.stringify({ callback_type: "robotStatus", data: { sn: "x", pad: "a".repeat(300 * 1024) } });
    const res = await webhook(new Request("http://localhost/api/webhooks/pudu", { method: "POST", headers: { "Content-Type": "application/json", CallbackCode: process.env.PUDU_CALLBACK_CODE }, body: big }));
    expect(res.status).toBe(413);
  });
});
