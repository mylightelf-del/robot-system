import type { ActualRun, Command, CommonStatus, RobotStatus } from "@/lib/domain/types";
import type { StoreData } from "@/lib/store/data";
import { upsertActualRun } from "@/lib/store/data";
import { addMinutes } from "@/lib/util/time";

/**
 * 샘플 시뮬레이션 틱.
 * 페이지를 읽을 때마다 호출되어 "경과 시간"에 따라 명령 상태와 로봇 상태를 바꾼다.
 * 오래 기다렸다 읽어도 중간 단계를 건너뛰지 않도록, 각 단계의 전이 시각을 가상으로 계산해 순서대로 적용한다.
 * 실제 운영에서는 Webhook 수신 + 주기 조회가 이 역할을 한다.
 */
const lastTick = new WeakMap<StoreData, string>();

const ACCEPT_TO_EXECUTING_SEC = 3;
const SHORT_COMMAND_DONE_SEC = 6;
const GO_HOME_DONE_SEC = 30;
const TASK_DURATION_SEC = 90;

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

export function runSimulationTick(data: StoreData, now: string): void {
  const prev = lastTick.get(data) ?? data.seededAt;
  const elapsedMin = Math.max(0, secondsSince(prev, now) / 60);
  lastTick.set(data, now);

  // 1) 명령 상태 전이(요청 순서대로)
  const cmds = [...data.commands].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  for (const cmd of cmds) {
    const st = data.statuses[cmd.robotId];
    if (!st) continue;
    if (cmd.simulation === null) continue; // 시드 명령은 고정
    advanceCommand(data, cmd, st, now);
  }

  // 2) 로봇 상태 자연 변화(하트비트·배터리·시드 작업 진행)
  for (const st of Object.values(data.statuses)) {
    if (!st.online) continue;
    const hasSimMission = data.commands.some((c) => c.robotId === st.robotId && c.simulation !== null && c.state === "EXECUTING" && (c.type === "START_TASK" || c.type === "AREA_CLEAN"));
    st.lastReceivedAt = now;
    st.dataAt = addMinutes(now, -0.5);
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
  }
}

function advanceCommand(data: StoreData, cmd: Command, st: RobotStatus, now: string) {
  // 한 틱 안에서 여러 단계를 가상 시각으로 순서대로 진행한다.
  for (let guard = 0; guard < 4; guard += 1) {
    if (cmd.state === "ACCEPTED") {
      const sec = secondsSince(cmd.stateChangedAt, now);
      if (sec >= data.settings.commandAcceptedTimeoutSeconds) {
        transition(cmd, "UNKNOWN", plusSec(cmd.stateChangedAt, data.settings.commandAcceptedTimeoutSeconds), "접수 후 실행 확인 없음(타임아웃) — 상태/작업 이력 확인 필요");
        return;
      }
      if (sec < ACCEPT_TO_EXECUTING_SEC) return;
      applyExecuting(cmd, st, plusSec(cmd.stateChangedAt, ACCEPT_TO_EXECUTING_SEC));
      continue;
    }
    if (cmd.state !== "EXECUTING") return;

    const sec = secondsSince(cmd.stateChangedAt, now);
    switch (cmd.type) {
      case "PAUSE":
      case "RESUME":
      case "STOP":
        if (sec >= SHORT_COMMAND_DONE_SEC) transition(cmd, "COMPLETED", plusSec(cmd.stateChangedAt, SHORT_COMMAND_DONE_SEC), `로봇 상태 ${st.common} 확인`);
        return;
      case "GO_HOME":
        if (sec >= GO_HOME_DONE_SEC) {
          const at = plusSec(cmd.stateChangedAt, GO_HOME_DONE_SEC);
          setStatus(st, "CHARGING", "CHARGING", at);
          st.progressPct = null;
          st.currentMissionId = null;
          transition(cmd, "COMPLETED", at, "충전소 도착 확인");
        }
        return;
      case "START_TASK":
      case "AREA_CLEAN": {
        if (st.common === "PAUSED") return; // 일시정지 중에는 진행하지 않음
        if (st.common !== "CLEANING") {
          transition(cmd, "COMPLETED", now, "다른 명령으로 작업 종료됨");
          return;
        }
        const pct = Math.min(100, Math.round((sec / TASK_DURATION_SEC) * 100));
        st.progressPct = pct;
        if (pct >= 100) finishTask(data, cmd, st, plusSec(cmd.stateChangedAt, TASK_DURATION_SEC));
        return;
      }
    }
  }
}

function transition(cmd: Command, state: Command["state"], at: string, message: string) {
  cmd.state = state;
  cmd.stateChangedAt = at;
  cmd.message = message;
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

function finishTask(data: StoreData, cmd: Command, st: RobotStatus, at: string) {
  const robot = data.robots.find((r) => r.id === cmd.robotId);
  if (!robot) return;
  const task = cmd.type === "START_TASK" ? data.tasks.find((t) => t.id === cmd.params.taskId) : null;
  const zoneIds = task ? task.zoneIds : ((cmd.params.zoneIds as string[] | undefined) ?? []);
  const area = zoneIds.reduce((s, z) => s + (data.zones.find((x) => x.id === z)?.areaM2 ?? 0), 0) || 120;
  const startedAt = cmd.stateChangedAt;
  const run: ActualRun = {
    id: `run-sim-${cmd.id}`,
    vendorRunId: `sim-vrun-${cmd.id}`,
    robotId: robot.id,
    siteId: robot.siteId,
    floorId: robot.floorId,
    taskId: task?.id ?? null,
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
  upsertActualRun(data, run);
  setStatus(st, "IDLE", "FREE", at);
  st.progressPct = null;
  st.currentMissionId = null;
  transition(cmd, "COMPLETED", at, "작업 이력 수신으로 완료 확인");
}
