import { beforeEach, describe, expect, it } from "vitest";
import { resetStore, getStore } from "@/lib/store/store";
import { issueCommand, canRetry } from "@/lib/services/commands";
import { runSimulationTick } from "@/lib/vendors/sample/simulation";
import { upsertActualRun } from "@/lib/store/data";
import { ConflictError, ValidationError } from "@/lib/util/errors";
import { addMinutes } from "@/lib/util/time";
import type { User } from "@/lib/domain/types";

const user = (id: string): User => getStore().users.find((u) => u.id === id)!;

describe("명령 상태 · 충돌 · 응답 유실", () => {
  beforeEach(() => {
    resetStore();
  });

  it("HTTP 접수만으로 완료 처리하지 않는다(ACCEPTED → 실행 확인 → COMPLETED)", async () => {
    const data = getStore();
    const cmd = await issueCommand(user("u-hq"), { robotId: "PW-R-003", type: "START_TASK", params: { taskId: "task-PW-R-003-night" } }); // IDLE
    expect(cmd.state).toBe("ACCEPTED");
    expect(cmd.vendorTraceId).toBeTruthy();
    runSimulationTick(data, addMinutes(cmd.stateChangedAt, 0.1)); // 6초 후
    expect(cmd.state).toBe("EXECUTING");
    expect(data.statuses["PW-R-003"].common).toBe("CLEANING");
    runSimulationTick(data, addMinutes(cmd.stateChangedAt, 2)); // 작업 90초 후
    expect(cmd.state).toBe("COMPLETED");
    expect(data.statuses["PW-R-003"].common).toBe("IDLE");
    expect(data.actualRuns.some((r) => r.id === `run-sim-${cmd.id}` && r.origin === "REMOTE")).toBe(true);
  });

  it("응답 유실 시 결과 불명(UNKNOWN)으로 기록하고 허위 성공 표시를 하지 않는다", async () => {
    const cmd = await issueCommand(user("u-hq"), { robotId: "PW-R-001", type: "PAUSE", simulation: "LOST_RESPONSE" });
    expect(cmd.state).toBe("UNKNOWN");
    expect(cmd.message).toContain("응답 유실");
    expect(getStore().statuses["PW-R-001"].common).toBe("CLEANING"); // 상태 변경 없음
    expect(canRetry(cmd, cmd.requestedAt).ok).toBe(true);
    expect(canRetry(cmd, addMinutes(cmd.requestedAt, 10)).ok).toBe(false); // 만료 후 재전송 금지
  });

  it("제조사 거부는 FAILED", async () => {
    const cmd = await issueCommand(user("u-hq"), { robotId: "PW-R-001", type: "PAUSE", simulation: "REJECTED" });
    expect(cmd.state).toBe("FAILED");
  });

  it("같은 버튼 중복 클릭(동일 키)은 거부된다", async () => {
    await issueCommand(user("u-hq"), { robotId: "PW-R-001", type: "PAUSE", idempotencyKey: "k1" });
    await expect(issueCommand(user("u-hq"), { robotId: "PW-R-001", type: "PAUSE", idempotencyKey: "k1" })).rejects.toThrow(ConflictError);
  });

  it("본사/고객 동시 명령 충돌: 처리 중 명령이 있으면 두 번째는 거부된다", async () => {
    await issueCommand(user("u-site-a"), { robotId: "PW-R-008", type: "PAUSE" });
    await expect(issueCommand(user("u-cust-2"), { robotId: "PW-R-008", type: "STOP" })).rejects.toThrow(ConflictError);
  });

  it("상태 전이 규칙: 대기 중 로봇에 일시정지, 통신 끊김 로봇에 작업 실행은 불가", async () => {
    await expect(issueCommand(user("u-hq"), { robotId: "PW-R-003", type: "PAUSE" })).rejects.toThrow(ValidationError);
    await expect(issueCommand(user("u-hq"), { robotId: "PW-R-006", type: "START_TASK", params: { taskId: "task-PW-R-006-night" } })).rejects.toThrow(ValidationError);
  });

  it("접수 후 실행 확인이 없으면 타임아웃으로 결과 불명 처리", async () => {
    const data = getStore();
    const cmd = await issueCommand(user("u-hq"), { robotId: "PW-R-003", type: "GO_HOME" });
    cmd.simulation = null; // 시뮬레이터가 상태를 바꾸지 않게 고정한 뒤
    cmd.simulation = "NORMAL";
    // 실행 확인 전이는 3초 후에 일어나므로, 전이 전에 바로 60초 경과시킨다
    runSimulationTick(data, addMinutes(cmd.stateChangedAt, 1.5));
    // 3초 규칙보다 60초 규칙이 먼저 평가되어 UNKNOWN
    expect(cmd.state).toBe("UNKNOWN");
  });
});

describe("지도 영역 명령 검증", () => {
  beforeEach(() => {
    const data = resetStore();
    // 시험 대상 L4(PW-R-019)를 명령 가능 상태(대기)로 둔다
    data.statuses["PW-R-019"].common = "IDLE";
    data.statuses["PW-R-019"].progressPct = null;
  });
  const hq = () => user("u-hq");

  it("정상: 현재 지도 버전 + 구역 지정 → 접수", async () => {
    const cmd = await issueCommand(hq(), { robotId: "PW-R-019", type: "AREA_CLEAN", params: { mapVersionId: "site-05-f1-map-v2", zoneIds: ["site-05-f1-z1"], mode: "SWEEP" } });
    expect(cmd.state).toBe("ACCEPTED");
  });

  it("지도 버전 불일치(요청 버전이 구버전)면 차단", async () => {
    await expect(issueCommand(hq(), { robotId: "PW-R-019", type: "AREA_CLEAN", params: { mapVersionId: "site-05-f1-map-v1", zoneIds: ["site-05-f1-z1"] } })).rejects.toThrow(/지도 버전/);
  });

  it("로봇이 보고한 지도 버전이 현재 지도와 다르면 차단", async () => {
    await expect(issueCommand(hq(), { robotId: "PW-R-012", type: "AREA_CLEAN", params: { mapVersionId: "site-03-f1-map-v2", zoneIds: ["site-03-f1-z1"] } })).rejects.toThrow(/지도 버전 불일치/);
  });

  it("모서리 좌표가 없는 지도(구형)는 차단", async () => {
    const data = getStore();
    data.statuses["PW-R-013"].common = "IDLE"; // 명령 가능 상태로
    data.robots.find((r) => r.id === "PW-R-013")!.supportedCommands.push("AREA_CLEAN"); // 영역 명령 지원 가정(시험용)
    await expect(issueCommand(hq(), { robotId: "PW-R-013", type: "AREA_CLEAN", params: { mapVersionId: "site-03-f3-map-v2", zoneIds: ["site-03-f3-z1"] } })).rejects.toThrow(/모서리 좌표/);
  });

  it("범위 밖 다각형은 차단", async () => {
    await expect(issueCommand(hq(), { robotId: "PW-R-019", type: "AREA_CLEAN", params: { mapVersionId: "site-05-f1-map-v2", zoneIds: [], polygon: [[-10, 0], [50, 50], [10, 99999]] } })).rejects.toThrow(/범위/);
  });

  it("L 시리즈는 SWEEP 외 모드 차단, 다른 층 구역 차단", async () => {
    await expect(issueCommand(hq(), { robotId: "PW-R-019", type: "AREA_CLEAN", params: { mapVersionId: "site-05-f1-map-v2", zoneIds: ["site-05-f1-z1"], mode: "PATROL" } })).rejects.toThrow(/SWEEP/);
    await expect(issueCommand(hq(), { robotId: "PW-R-019", type: "AREA_CLEAN", params: { mapVersionId: "site-05-f1-map-v2", zoneIds: ["site-01-f1-z1"] } })).rejects.toThrow(/다른 층/);
  });
});

describe("실적 중복 제거", () => {
  it("같은 제조사 작업 ID 는 두 번 저장되지 않는다", () => {
    const data = resetStore();
    const first = data.actualRuns[0];
    const before = data.actualRuns.length;
    expect(upsertActualRun(data, { ...first, id: "dup" })).toBe(false);
    expect(data.actualRuns.length).toBe(before);
  });
});
