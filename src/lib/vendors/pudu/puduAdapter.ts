import type { ActualRun, MaintenanceItem, RobotStatus } from "@/lib/domain/types";
import type { SendResult, VendorAdapter } from "@/lib/vendors/adapter";
import { AppError } from "@/lib/util/errors";

/**
 * PUDU Cloud API 어댑터 — 미구현 스텁 (6단계에서 구현).
 *
 * 공식 진입점: https://open.pudutech.com/en , https://open.pudutech.com/en/cloud-api
 * MT1·CC1·BG1 모델별 API 지원표·인증·필드·명령 규격은 아직 확보/검증하지 않았다.
 * 본체 매뉴얼 기능을 외부 API 지원으로 판단하지 않는다. 형식을 추측해 구현하지 않는다.
 */
export class PuduAdapter implements VendorAdapter {
  readonly vendor = "PUDU" as const;
  readonly isSimulation = false;

  private notImplemented(): never {
    throw new AppError("PUDU 실제 연동은 모델별 API 규격 검증 후(6단계) 구현됩니다.", "UNSUPPORTED");
  }

  async sendCommand(): Promise<SendResult> {
    return this.notImplemented();
  }
  async fetchStatus(): Promise<RobotStatus | null> {
    return this.notImplemented();
  }
  async fetchRuns(): Promise<ActualRun[]> {
    return this.notImplemented();
  }
  async fetchMaintenance(): Promise<MaintenanceItem[]> {
    return this.notImplemented();
  }
}
