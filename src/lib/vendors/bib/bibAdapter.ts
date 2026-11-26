import type { ActualRun, MaintenanceItem, Robot, RobotStatus } from "@/lib/domain/types";
import type { SendResult, VendorAdapter } from "../adapter";

/** BIB 어댑터 — 조회 전용. 상태는 워커(src/worker/bib.ts)가 받아 저장하므로 여기서는 명령을 거부만 한다. */
export class BibAdapter implements VendorAdapter {
  readonly vendor = "BIB" as const;
  readonly isSimulation = false;
  async sendCommand(): Promise<SendResult> {
    return { outcome: "REJECTED", vendorTraceId: null, message: "BIB 연동은 조회 전용입니다. 로봇에 명령을 보내지 않습니다." };
  }
  async fetchStatus(_robot: Robot): Promise<RobotStatus | null> {
    return null;
  }
  async fetchRuns(): Promise<ActualRun[]> {
    return [];
  }
  async fetchMaintenance(): Promise<MaintenanceItem[]> {
    return [];
  }
}
