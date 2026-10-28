import type { ActualRun, Command, CommonStatus, Robot, RobotStatus, Zone } from "@/lib/domain/types";

/**
 * 샘플 시뮬레이션 — 순수 함수.
 * 워커(src/worker/simulation.ts)가 DB 에서 명령·상태를 읽어 이 함수들로 다음 상태를 계산한 뒤 저장한다.
 * 오래 기다렸다 틱이 돌아도 중간 단계를 건너뛰지 않도록, 각 단계의 전이 시각을 가상으로 계산해 순서대로 적용한다.
 * 실제 운영에서는 Webhook 수신 + 주기 조회가 이 역할을 한다.
 */
export const ACCEPT_TO_EXECUTING_SEC = 3;
export const SHORT_COMMAND_DONE_SEC = 6;
export const GO_HOME_DONE_SEC = 30;
export const TASK_DURATION_SEC = 90;

function secondsSince(iso: string, now: string): number {
  return (new Date(now).getTime() - new Date(iso).getTime()) / 1000;
}

function plusSec(iso: string, sec: number): string {
  return new Date(new Date(iso).getTime() + sec * 1000).toISOString();
}

function setStatus(st: RobotStatus, common: CommonStatus, raw: string, at: string) {
  st.common = common;
  st.raw = raw;
  st.online = common !== "OFFLINE" && common !== "UNKNOWN";
  st.poseIsLastKnown = !st.online;
  st.lastReceivedAt = at;
  st.dataAt = at;
}

function transition(cmd: Command, state: Command["state"], at: string, message: string) {
  cmd.state = state;
  cmd.stateChangedAt = at;
  cmd.message = message;
}

export interface AdvanceContext {
  robot: Robot;
  taskZoneIds: string[] | null; // START_TASK 일 때 등록 작업의 구역
  zones: Zone[]; // 로봇 층의 구역(면적 계산)
  acceptedTimeoutSeconds: number;
}

export interface AdvanceResult {
  commandChanged: boolean;
  statusChanged: boolean;
  newRun: ActualRun | null;
}

/** 명령 하나를 현재 시각까지 진행시킨다. cmd/st 는 제자리에서 수정된다. */
export function advanceCommand(cmd: Command, st: RobotStatus, ctx: AdvanceContext, now: string): AdvanceResult {
  const before = { state: cmd.state, at: cmd.stateChangedAt, status: JSON.stringify(st) };
  let newRun: ActualRun | null = null;

  for (let guard = 0; guard < 4; guard += 1) {
    if (cmd.state === "ACCEPTED") {
      const sec = secondsSince(cmd.stateChangedAt, now);
      if (sec >= ctx.acceptedTimeoutSeconds) {
        transition(cmd, "UNKNOWN", plusSec(cmd.stateChangedAt, ctx.acceptedTimeoutSeconds), "접수 후 실행 확인 없음(타임아웃) — 상태/작업 이력 확인 필요");
        break;
      }
      if (sec < ACCEPT_TO_EXECUTING_SEC) break;
      applyExecuting(cmd, st, plusSec(cmd.stateChangedAt, ACCEPT_TO_EXECUTING_SEC));
      continue;
    }
    if (cmd.state !== "EXECUTING") break;

    const sec = secondsSince(cmd.stateChangedAt, now);
    if (cmd.type === "PAUSE" || cmd.type === "RESUME" || cmd.type === "STOP") {
      if (sec >= SHORT_COMMAND_DONE_SEC) transition(cmd, "COMPLETED", plusSec(cmd.stateChangedAt, SHORT_COMMAND_DONE_SEC), `로봇 상태 ${st.common} 확인`);
      break;
    }
    if (cmd.type === "GO_HOME") {
      if (sec >= GO_HOME_DONE_SEC) {
        const at = plusSec(cmd.stateChangedAt, GO_HOME_DONE_SEC);
        setStatus(st, "CHARGING", "CHARGING", at);
        st.progressPct = null;
        st.currentMissionId = null;
        transition(cmd, "COMPLETED", at, "충전소 도착 확인");
      }
      break;
    }
    // START_TASK / AREA_CLEAN
    if (st.common === "PAUSED") break;
    if (st.common !== "CLEANING") {
      transition(cmd, "COMPLETED", now, "다른 명령으로 작업 종료됨");
      break;
    }
    const pct = Math.min(100, Math.round((sec / TASK_DURATION_SEC) * 100));
    st.progressPct = pct;
    st.lastReceivedAt = now;
    st.dataAt = now;
    if (pct >= 100) newRun = finishTask(cmd, st, ctx, plusSec(cmd.stateChangedAt, TASK_DURATION_SEC));
    break;
  }

  return { commandChanged: cmd.state !== before.state || cmd.stateChangedAt !== before.at, statusChanged: JSON.stringify(st) !== before.status, newRun };
}

function applyExecuting(cmd: Command, st: RobotStatus, at: string) {
  switch (cmd.type) {
    case "START_TASK":
    case "AREA_CLEAN":
      setStatus(st, "CLEANING", "running=true", at);
      st.progressPct = 0;
      st.currentMissionId = cmd.id;
      transition(cmd, "EXECUTING", at, "로봇 상태 CLEANING 으로 실행 확인");
      break;
    case "PAUSE":
      setStatus(st, "PAUSED", "PAUSED", at);
      transition(cmd, "EXECUTING", at, "로봇 상태 PAUSED 확인");
      break;
    case "RESUME":
      setStatus(st, "CLEANING", "running=true", at);
      transition(cmd, "EXECUTING", at, "로봇 상태 CLEANING 확인");
      break;
    case "STOP":
      setStatus(st, "IDLE", "FREE", at);
      st.progressPct = null;
      st.currentMissionId = null;
      transition(cmd, "EXECUTING", at, "로봇 상태 IDLE 확인");
      break;
    case "GO_HOME":
      setStatus(st, "RETURNING", "GO_HOME", at);
      st.progressPct = null;
      st.currentMissionId = null;
      transition(cmd, "EXECUTING", at, "로봇 상태 RETURNING 확인");
      break;
  }
}

function finishTask(cmd: Command, st: RobotStatus, ctx: AdvanceContext, at: string): ActualRun {
  const robot = ctx.robot;
  const zoneIds = cmd.type === "START_TASK" ? (ctx.taskZoneIds ?? []) : ((cmd.params.zoneIds as string[] | undefined) ?? []);
  const area = zoneIds.reduce((s, z) => s + (ctx.zones.find((x) => x.id === z)?.areaM2 ?? 0), 0) || 120;
  const startedAt = cmd.stateChangedAt;
  const run: ActualRun = {
    id: `run-sim-${cmd.id}`,
    vendorRunId: `sim-vrun-${cmd.id}`,
    robotId: robot.id,
    siteId: robot.siteId,
    floorId: robot.floorId,
    taskId: cmd.type === "START_TASK" ? String(cmd.params.taskId) : null,
    zoneIds,
    startedAt,
    endedAt: at,
    result: "COMPLETED",
    endReason: "작업 완료(시뮬레이션)",
    areaM2: Math.round(area),
    durationMin: Math.max(1, Math.round(secondsSince(startedAt, at) / 60)),
    waterL: robot.vendor === "CENOBOTS" ? 2.5 : null,
    detergentMl: robot.vendor === "CENOBOTS" ? 25 : null,
    origin: "REMOTE",
    receivedAt: at,
  };
  setStatus(st, "IDLE", "FREE", at);
  st.progressPct = null;
  st.currentMissionId = null;
  transition(cmd, "COMPLETED", at, "작업 이력 수신으로 완료 확인");
  return run;
}

/** 하트비트·배터리·시드 작업 진행(온라인 로봇만). 변경 여부를 돌려준다. */
export function applyHeartbeat(st: RobotStatus, elapsedMin: number, hasSimMission: boolean, now: string): boolean {
  if (!st.online) return false;
  st.lastReceivedAt = now;
  st.dataAt = new Date(new Date(now).getTime() - 30_000).toISOString();
  if (st.common === "CLEANING" && !hasSimMission && st.progressPct !== null) {
    st.progressPct = Math.min(100, st.progressPct + elapsedMin * 1.5);
    if (st.batteryPct !== null) st.batteryPct = Math.max(5, Math.round((st.batteryPct - elapsedMin * 0.3) * 10) / 10);
    if (st.progressPct >= 100) {
      setStatus(st, "IDLE", "FREE", now);
      st.progressPct = null;
      st.currentMissionId = null;
    }
  } else if (st.common === "CHARGING" && st.batteryPct !== null) {
    st.batteryPct = Math.min(100, Math.round((st.batteryPct + elapsedMin * 0.8) * 10) / 10);
  }
  return true;
}
