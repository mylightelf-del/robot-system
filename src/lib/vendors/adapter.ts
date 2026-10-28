import type { ActualRun, Command, MaintenanceItem, Robot, RobotStatus, Vendor } from "@/lib/domain/types";

/**
 * 제조사 연동 어댑터 인터페이스.
 *
 * 서비스 계층은 이 인터페이스만 사용한다. 구현체:
 * - sample/   : 시제품용 시뮬레이션(실제 통신 없음)
 * - cenobots/ : 3단계에서 공식 문서 재확인 후 구현(현재는 미구현 스텁)
 * - pudu/     : 6단계에서 모델별 규격 검증 후 구현(현재는 미구현 스텁)
 *
 * 원칙: HTTP 성공(접수)과 실제 실행 확인을 구분한다. 어댑터는 "접수 결과"만 돌려주고,
 * 실행 확인은 이후 상태/작업 이력 조회로 서비스 계층이 판단한다.
 */
export type SendOutcome = "ACCEPTED" | "REJECTED" | "TIMEOUT";

export interface SendResult {
  outcome: SendOutcome;
  vendorTraceId: string | null;
  message: string | null;
}

export interface VendorAdapter {
  readonly vendor: Vendor;
  /** 시뮬레이션 어댑터인지. UI 에 "시뮬레이션" 표시 근거. */
  readonly isSimulation: boolean;
  sendCommand(robot: Robot, command: Command): Promise<SendResult>;
  fetchStatus(robot: Robot): Promise<RobotStatus | null>;
  fetchRuns(robot: Robot, fromIso: string, toIso: string): Promise<ActualRun[]>;
  fetchMaintenance(robot: Robot): Promise<MaintenanceItem[]>;
}
