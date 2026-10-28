import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { issueCommand, canRetry } from "@/lib/services/commands";
import { simulationTick } from "@/worker/simulation";
import { ConflictError, ValidationError } from "@/lib/util/errors";
import { addMinutes } from "@/lib/util/time";
import { getDb, resetAndSeed, schema, setRobotStatus, user } from "./helpers";

const db = () => getDb();
const cmdRow = async (id: string) => (await db().query.commands.findFirst({ where: eq(schema.commands.id, id) }))!;
const statusRow = async (robotId: string) => (await db().query.robotStatus.findFirst({ where: eq(schema.robotStatus.robotId, robotId) }))!;

describe("명령 상태 · 충돌 · 응답 유실 (DB + 워커 시뮬레이션)", () => {
  beforeEach(async () => {
    await resetAndSeed();
  });

  it("HTTP 접수만으로 완료 처리하지 않는다(ACCEPTED → 실행 확인 → COMPLETED, 실적 생성)", async () => {
    const cmd = await issueCommand(await user("u-hq"), { robotId: "PW-R-003", type: "START_TASK", params: { taskId: "task-PW-R-003-night" } }); // IDLE
    expect(cmd.state).toBe("ACCEPTED");
    expect(cmd.vendorTraceId).toBeTruthy();
    await simulationTick(addMinutes(cmd.stateChangedAt, 0.1)); // 6초 후
    expect((await cmdRow(cmd.id)).state).toBe("EXECUTING");
    expect((await statusRow("PW-R-003")).common).toBe("CLEANING");
    await simulationTick(addMinutes(cmd.stateChangedAt, 2)); // 작업 90초 후
    expect((await cmdRow(cmd.id)).state).toBe("COMPLETED");
    expect((await statusRow("PW-R-003")).common).toBe("IDLE");
    const run = await db().query.actualRuns.findFirst({ where: eq(schema.actualRuns.id, `run-sim-${cmd.id}`) });
    expect(run?.origin).toBe("REMOTE");
    // 같은 틱이 다시 돌아도 실적이 중복 생성되지 않는다(중복 키)
    await simulationTick(addMinutes(cmd.stateChangedAt, 3));
    const runs = await db().select().from(schema.actualRuns).where(eq(schema.actualRuns.robotId, "PW-R-003"));
    expect(runs.filter((r) => r.id === `run-sim-${cmd.id}`).length).toBe(1);
  });

  it("응답 유실 시 결과 불명(UNKNOWN)으로 기록하고 허위 성공 표시를 하지 않는다", async () => {
    const cmd = await issueCommand(await user("u-hq"), { robotId: "PW-R-001", type: "PAUSE", simulation: "LOST_RESPONSE" });
    expect(cmd.state).toBe("UNKNOWN");
    expect(cmd.message).toContain("응답 유실");
    expect((await statusRow("PW-R-001")).common).toBe("CLEANING");
    expect(canRetry(cmd, cmd.requestedAt).ok).toBe(true);
    expect(canRetry(cmd, addMinutes(cmd.requestedAt, 10)).ok).toBe(false);
  });

  it("제조사 거부는 FAILED", async () => {
    const cmd = await issueCommand(await user("u-hq"), { robotId: "PW-R-001", type: "PAUSE", simulation: "REJECTED" });
    expect(cmd.state).toBe("FAILED");
  });

  it("같은 버튼 중복 클릭(동일 키)은 거부된다", async () => {
    await issueCommand(await user("u-hq"), { robotId: "PW-R-001", type: "PAUSE", idempotencyKey: "k1" });
    await expect(issueCommand(await user("u-hq"), { robotId: "PW-R-001", type: "PAUSE", idempotencyKey: "k1" })).rejects.toThrow(ConflictError);
  });

  it("선 조작 우선: 처리 중 명령이 있으면 본사 명령도 거부된다", async () => {
    await issueCommand(await user("u-cust-2"), { robotId: "PW-R-008", type: "PAUSE" });
    await expect(issueCommand(await user("u-hq"), { robotId: "PW-R-008", type: "STOP" })).rejects.toThrow(ConflictError);
  });

  it("상태 전이 규칙: 대기 중 로봇에 일시정지, 통신 끊김 로봇에 작업 실행은 불가", async () => {
    await expect(issueCommand(await user("u-hq"), { robotId: "PW-R-003", type: "PAUSE" })).rejects.toThrow(ValidationError);
    await expect(issueCommand(await user("u-hq"), { robotId: "PW-R-006", type: "START_TASK", params: { taskId: "task-PW-R-006-night" } })).rejects.toThrow(ValidationError);
  });

  it("접수 후 실행 확인이 없으면 타임아웃으로 결과 불명 처리", async () => {
    const cmd = await issueCommand(await user("u-hq"), { robotId: "PW-R-003", type: "GO_HOME" });
    await simulationTick(addMinutes(cmd.stateChangedAt, 1.5)); // 60초 규칙이 3초 규칙보다 먼저 평가
    expect((await cmdRow(cmd.id)).state).toBe("UNKNOWN");
  });
});

describe("지도 영역 명령 검증", () => {
  beforeEach(async () => {
    await resetAndSeed();
    await setRobotStatus("PW-R-019", { common: "IDLE", progressPct: null }); // 시험 대상 L4 를 명령 가능 상태로
  });
  const hq = () => user("u-hq");

  it("정상: 현재 지도 버전 + 구역 지정 → 접수", async () => {
    const cmd = await issueCommand(await hq(), { robotId: "PW-R-019", type: "AREA_CLEAN", params: { mapVersionId: "site-05-f1-map-v2", zoneIds: ["site-05-f1-z1"], mode: "SWEEP" } });
    expect(cmd.state).toBe("ACCEPTED");
  });

  it("지도 버전 불일치(요청 버전이 구버전)면 차단", async () => {
    await expect(issueCommand(await hq(), { robotId: "PW-R-019", type: "AREA_CLEAN", params: { mapVersionId: "site-05-f1-map-v1", zoneIds: ["site-05-f1-z1"] } })).rejects.toThrow(/지도 버전/);
  });

  it("로봇이 보고한 지도 버전이 현재 지도와 다르면 차단", async () => {
    await expect(issueCommand(await hq(), { robotId: "PW-R-012", type: "AREA_CLEAN", params: { mapVersionId: "site-03-f1-map-v2", zoneIds: ["site-03-f1-z1"] } })).rejects.toThrow(/지도 버전 불일치/);
  });

  it("모서리 좌표가 없는 지도(구형)는 차단", async () => {
    await setRobotStatus("PW-R-013", { common: "IDLE" });
    await db().update(schema.robots).set({ supportedCommands: ["START_TASK", "PAUSE", "RESUME", "STOP", "GO_HOME", "AREA_CLEAN"] }).where(eq(schema.robots.id, "PW-R-013"));
    await expect(issueCommand(await hq(), { robotId: "PW-R-013", type: "AREA_CLEAN", params: { mapVersionId: "site-03-f3-map-v2", zoneIds: ["site-03-f3-z1"] } })).rejects.toThrow(/모서리 좌표/);
  });

  it("범위 밖 다각형은 차단", async () => {
    await expect(issueCommand(await hq(), { robotId: "PW-R-019", type: "AREA_CLEAN", params: { mapVersionId: "site-05-f1-map-v2", zoneIds: [], polygon: [[-10, 0], [50, 50], [10, 99999]] } })).rejects.toThrow(/범위/);
  });

  it("L 시리즈는 SWEEP 외 모드 차단, 다른 층 구역 차단", async () => {
    await expect(issueCommand(await hq(), { robotId: "PW-R-019", type: "AREA_CLEAN", params: { mapVersionId: "site-05-f1-map-v2", zoneIds: ["site-05-f1-z1"], mode: "PATROL" } })).rejects.toThrow(/SWEEP/);
    await expect(issueCommand(await hq(), { robotId: "PW-R-019", type: "AREA_CLEAN", params: { mapVersionId: "site-05-f1-map-v2", zoneIds: ["site-01-f1-z1"] } })).rejects.toThrow(/다른 층/);
  });
});

describe("실적 중복 제거 (DB 유일 키)", () => {
  it("같은 제조사 작업 ID 는 두 번 저장되지 않는다", async () => {
    await resetAndSeed();
    const first = (await db().select().from(schema.actualRuns).limit(1))[0];
    const res = await db()
      .insert(schema.actualRuns)
      .values({ ...first, id: "dup" })
      .onConflictDoNothing({ target: [schema.actualRuns.vendor, schema.actualRuns.vendorRobotId, schema.actualRuns.vendorRunId] })
      .returning({ id: schema.actualRuns.id });
    expect(res.length).toBe(0);
  });
});
