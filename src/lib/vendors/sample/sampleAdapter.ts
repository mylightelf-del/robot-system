import type { ActualRun, Command, MaintenanceItem, Robot, RobotStatus } from "@/lib/domain/types";
import type { SendResult, VendorAdapter } from "@/lib/vendors/adapter";
import { getStore } from "@/lib/store/store";

/**
 * 샘플 어댑터 — 실제 통신 없이 명령 접수를 시뮬레이션한다.
 * 시나리오(command.simulation):
 *  - NORMAL        : 접수 성공 → 이후 simulation.ts 가 상태 변화를 만든다.
 *  - REJECTED      : 제조사가 거부(HTTP 성공이지만 body.success=false 와 같은 경우).
 *  - LOST_RESPONSE : 응답 유실(타임아웃). 결과 불명으로 기록하고 허위 성공 표시를 하지 않는다.
 */
export class SampleAdapter implements VendorAdapter {
  readonly isSimulation = true;
  constructor(readonly vendor: Robot["vendor"]) {}

  async sendCommand(_robot: Robot, command: Command): Promise<SendResult> {
    switch (command.simulation) {
      case "REJECTED":
        return { outcome: "REJECTED", vendorTraceId: `sim-${command.id}`, message: "제조사 응답: 요청 거부(시뮬레이션)" };
      case "LOST_RESPONSE":
        return { outcome: "TIMEOUT", vendorTraceId: null, message: "응답 유실(타임아웃, 시뮬레이션)" };
      default:
        return { outcome: "ACCEPTED", vendorTraceId: `sim-${command.id}`, message: "접수(시뮬레이션)" };
    }
  }

  async fetchStatus(robot: Robot): Promise<RobotStatus | null> {
    return getStore().statuses[robot.id] ?? null;
  }

  async fetchRuns(robot: Robot, fromIso: string, toIso: string): Promise<ActualRun[]> {
    return getStore().actualRuns.filter((r) => r.robotId === robot.id && r.startedAt >= fromIso && r.startedAt <= toIso);
  }

  async fetchMaintenance(robot: Robot): Promise<MaintenanceItem[]> {
    return getStore().maintenance[robot.id] ?? [];
  }
}
