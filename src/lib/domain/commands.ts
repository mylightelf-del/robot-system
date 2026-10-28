import type { CommandType, Vendor, RobotModel } from "./types";

/**
 * 명령별 제조사 의미 구분.
 *
 * CenoBots 는 공개 문서(2026-10-27 확인)의 Go home / Stop / Pause / Continue current mission 명칭을 그대로 적는다.
 * PUDU 는 MT1·CC1·BG1 모델별 API 규격을 아직 검증하지 않았으므로 "미확인"으로 표시한다.
 * 이 표는 UI 안내용이며, 실제 지원 여부는 각 제조사 어댑터 구현·실기 시험에서 확정한다.
 */
export interface CommandSemantics {
  vendorName: string; // 제조사 쪽 명령 이름
  meaning: string; // 운영자가 알아야 할 의미
  verified: boolean; // 공개 문서에서 endpoint 존재를 확인했는지
}

export const COMMAND_SEMANTICS: Record<Vendor, Record<CommandType, CommandSemantics>> = {
  CENOBOTS: {
    START_TASK: {
      vendorName: "Favorite 실행 (Favorite 장)",
      meaning: "등록(즐겨찾기) 작업을 즉시 실행한다. 임시 청소는 POST /app/openapi/v1/mission 과 다른 경로.",
      verified: true,
    },
    PAUSE: { vendorName: "Pause current mission", meaning: "현재 작업을 일시정지. 위치를 유지한다.", verified: true },
    RESUME: { vendorName: "Continue current mission", meaning: "일시정지한 현재 작업을 이어서 수행.", verified: true },
    STOP: { vendorName: "Stop", meaning: "현재 작업을 종료. 재개 불가. 복귀는 별도 명령.", verified: true },
    GO_HOME: { vendorName: "Go home", meaning: "충전소/홈 위치로 복귀. 진행 중 작업은 종료된다.", verified: true },
    AREA_CLEAN: {
      vendorName: "POST /app/openapi/v1/mission (areaIds 또는 userDefinedArea)",
      meaning: "지도 버전과 구역/사용자 정의 영역을 지정해 임시 청소. L 시리즈는 SWEEP 모드만 가능.",
      verified: true,
    },
  },
  PUDU: {
    START_TASK: { vendorName: "미확인", meaning: "Cloud API 작업 실행 규격을 모델별로 검증 전.", verified: false },
    PAUSE: { vendorName: "미확인", meaning: "모델별 지원 여부 검증 전.", verified: false },
    RESUME: { vendorName: "미확인", meaning: "모델별 지원 여부 검증 전.", verified: false },
    STOP: { vendorName: "미확인", meaning: "모델별 지원 여부 검증 전.", verified: false },
    GO_HOME: { vendorName: "미확인", meaning: "모델별 지원 여부 검증 전.", verified: false },
    AREA_CLEAN: { vendorName: "미확인", meaning: "지도 영역 지정 API 제공 여부 검증 전.", verified: false },
  },
  BIB: {
    START_TASK: { vendorName: "후속 검토", meaning: "BIB J40 은 연동 검토 보류.", verified: false },
    PAUSE: { vendorName: "후속 검토", meaning: "BIB J40 은 연동 검토 보류.", verified: false },
    RESUME: { vendorName: "후속 검토", meaning: "BIB J40 은 연동 검토 보류.", verified: false },
    STOP: { vendorName: "후속 검토", meaning: "BIB J40 은 연동 검토 보류.", verified: false },
    GO_HOME: { vendorName: "후속 검토", meaning: "BIB J40 은 연동 검토 보류.", verified: false },
    AREA_CLEAN: { vendorName: "후속 검토", meaning: "BIB J40 은 연동 검토 보류.", verified: false },
  },
};

export const VENDOR_LABEL: Record<Vendor, string> = {
  PUDU: "PUDU",
  CENOBOTS: "CenoBots",
  BIB: "BIB",
};

export const MODEL_VENDOR: Record<RobotModel, Vendor> = {
  MT1: "PUDU",
  CC1: "PUDU",
  BG1: "PUDU",
  L4: "CENOBOTS",
  J40: "BIB",
};

/** 상태 전이 규칙: 현재 공통 상태에서 허용되는 명령. 충돌 방지용(샘플 기준). */
export const ALLOWED_BY_STATUS: Record<string, CommandType[]> = {
  IDLE: ["START_TASK", "AREA_CLEAN", "GO_HOME"],
  CHARGING: ["START_TASK", "AREA_CLEAN"],
  CLEANING: ["PAUSE", "STOP", "GO_HOME"],
  PAUSED: ["RESUME", "STOP", "GO_HOME"],
  RETURNING: ["STOP"],
  ERROR: ["GO_HOME", "STOP"],
  OFFLINE: [],
  UNKNOWN: [],
};
