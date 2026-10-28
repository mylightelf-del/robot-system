import type { ActualRun, MaintenanceItem, RobotStatus } from "@/lib/domain/types";
import type { SendResult, VendorAdapter } from "@/lib/vendors/adapter";
import { AppError } from "@/lib/util/errors";

/**
 * CenoBots Open API 어댑터 — 미구현 스텁 (3단계에서 구현).
 *
 * 1단계에서는 요청·응답 형식을 추측해서 구현하지 않는다.
 * 구현 전에 공식 문서(README.md 참고)의 현행 버전을 다시 확인하고, 인증 서명 규칙·지역 HOST·호출 제한을 실제 계정으로 시험한다.
 * API 키는 서버 비밀 설정(환경변수)에서만 읽는다. 아래 환경변수 이름은 .env.example 에 정의한다.
 *   CENOBOTS_API_HOST, CENOBOTS_ACCESS_KEY, CENOBOTS_SECRET_KEY
 */
export class CenobotsAdapter implements VendorAdapter {
  readonly vendor = "CENOBOTS" as const;
  readonly isSimulation = false;

  private notImplemented(): never {
    throw new AppError("CenoBots 실제 연동은 3단계에서 구현됩니다. 현재는 샘플 어댑터만 동작합니다.", "UNSUPPORTED");
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
