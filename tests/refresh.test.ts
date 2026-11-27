import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { lastRobotRefreshAt, refreshRobotsAndSchedules, resetRefreshCooldownForTest } from "@/lib/services/refresh";
import { getDb, resetAndSeed, schema, user } from "./helpers";

describe("로봇 현황·일정 지금 업데이트", () => {
  beforeAll(() => {
    process.env.CENOBOTS_MODE = "mock"; // 모의 제조사로 실제 동기화 경로를 돌린다(시험 환경은 production 이 아니라 저장됨)
  });
  afterAll(() => {
    delete process.env.CENOBOTS_MODE;
  });
  beforeEach(async () => {
    await resetAndSeed();
    resetRefreshCooldownForTest();
  });

  it("본사 관리자만 실행, 현장·고객은 거부", async () => {
    await expect(refreshRobotsAndSchedules(await user("u-site-a"))).rejects.toThrow(/본사 관리자/);
    await expect(refreshRobotsAndSchedules(await user("u-cust-1"))).rejects.toThrow(/본사 관리자/);
  });

  it("켜진 연동(CENOBOT 모의)의 상태·작업/일정·예정 회차를 돌리고, 감사 기록·마지막 업데이트 시각을 남긴다", async () => {
    const r = await refreshRobotsAndSchedules(await user("u-hq"));
    expect(r.steps.map((s) => s.name)).toEqual(["CENOBOT 로봇 상태", "CENOBOT 작업·일정", "CENOBOT 예정 회차", "CENOBOT 층 지도"]);
    expect(r.steps.every((s) => s.ok)).toBe(true);
    const logs = await getDb().select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "SYNC:MANUAL_REFRESH"));
    expect(logs).toHaveLength(1);
    expect(logs[0].result).toBe("OK");
    expect(await lastRobotRefreshAt()).not.toBeNull();
  });

  it("60초 안에 다시 누르면 막는다(제조사 API 부담), 시스템 실행은 예외", async () => {
    const hq = await user("u-hq");
    await refreshRobotsAndSchedules(hq);
    await expect(refreshRobotsAndSchedules(hq)).rejects.toThrow(/초 뒤에 다시/);
    await expect(refreshRobotsAndSchedules()).resolves.toBeTruthy();
  });

  it("켜진 연동이 없으면(샘플 모드) 실패 단계 하나로 알린다", async () => {
    process.env.CENOBOTS_MODE = "unconfigured";
    const r = await refreshRobotsAndSchedules(await user("u-hq"));
    expect(r.steps).toEqual([{ name: "연동", ok: false, detail: "켜져 있는 로봇 연동이 없습니다(샘플 모드)." }]);
    process.env.CENOBOTS_MODE = "mock";
  });
});
