import type { CommandState, CommonStatus, IncidentStatus, ReportStatus, Role, Severity, CommandType, RunResult, PlannedRunStatus } from "./types";

/**
 * 공통 상태 우선순위. 여러 신호가 동시에 참일 때 화면에 표시할 대표 상태를 고른다.
 * 숫자가 작을수록 우선. (오류 > 통신 끊김 > 청소 > 일시정지 > 복귀 > 충전 > 대기 > 불명)
 */
export const STATUS_PRIORITY: Record<CommonStatus, number> = {
  ERROR: 0,
  OFFLINE: 1,
  CLEANING: 2,
  PAUSED: 3,
  RETURNING: 4,
  CHARGING: 5,
  IDLE: 6,
  UNKNOWN: 7,
};

export const STATUS_LABEL: Record<CommonStatus, string> = {
  ERROR: "오류",
  OFFLINE: "통신 끊김",
  CLEANING: "청소 중",
  PAUSED: "일시정지",
  RETURNING: "복귀 중",
  CHARGING: "충전 중",
  IDLE: "대기",
  UNKNOWN: "상태 불명",
};

/** 상태색 + 아이콘 텍스트 병용(색만으로 구분하지 않음). */
export const STATUS_STYLE: Record<CommonStatus, { cls: string; icon: string }> = {
  ERROR: { cls: "bg-red-100 text-red-800 border-red-300", icon: "✖" },
  OFFLINE: { cls: "bg-slate-200 text-slate-800 border-slate-400", icon: "⊘" },
  CLEANING: { cls: "bg-blue-100 text-blue-800 border-blue-300", icon: "▶" },
  PAUSED: { cls: "bg-amber-100 text-amber-800 border-amber-300", icon: "⏸" },
  RETURNING: { cls: "bg-indigo-100 text-indigo-800 border-indigo-300", icon: "↩" },
  CHARGING: { cls: "bg-emerald-100 text-emerald-800 border-emerald-300", icon: "⚡" },
  IDLE: { cls: "bg-gray-100 text-gray-700 border-gray-300", icon: "■" },
  UNKNOWN: { cls: "bg-purple-100 text-purple-800 border-purple-300", icon: "?" },
};

export const COMMAND_STATE_LABEL: Record<CommandState, string> = {
  REQUESTED: "요청",
  ACCEPTED: "접수",
  EXECUTING: "실행 확인",
  COMPLETED: "완료",
  FAILED: "실패",
  UNKNOWN: "결과 불명",
};

export const COMMAND_STATE_STYLE: Record<CommandState, string> = {
  REQUESTED: "bg-gray-100 text-gray-700",
  ACCEPTED: "bg-sky-100 text-sky-800",
  EXECUTING: "bg-blue-100 text-blue-800",
  COMPLETED: "bg-emerald-100 text-emerald-800",
  FAILED: "bg-red-100 text-red-800",
  UNKNOWN: "bg-purple-100 text-purple-800",
};

export const COMMAND_LABEL: Record<CommandType, string> = {
  START_TASK: "작업 실행",
  PAUSE: "일시정지",
  RESUME: "재개",
  STOP: "중단",
  GO_HOME: "복귀",
  AREA_CLEAN: "영역 청소",
};

export const ROLE_LABEL: Record<Role, string> = {
  HQ_ADMIN: "본사 관리자",
  SITE_MANAGER: "현장 담당자",
  CUSTOMER_BASIC: "고객 기본",
  CUSTOMER_CONTROL: "고객 제어",
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  LOW: "낮음",
  MEDIUM: "보통",
  HIGH: "높음",
  CRITICAL: "긴급",
};

export const SEVERITY_ORDER: Record<Severity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

export const SEVERITY_STYLE: Record<Severity, string> = {
  LOW: "bg-gray-100 text-gray-700",
  MEDIUM: "bg-amber-100 text-amber-800",
  HIGH: "bg-orange-100 text-orange-800",
  CRITICAL: "bg-red-100 text-red-800",
};

export const INCIDENT_STATUS_LABEL: Record<IncidentStatus, string> = {
  OPEN: "발생",
  ACKED: "확인",
  ASSIGNED: "담당자 지정",
  IN_PROGRESS: "조치 중",
  RESOLVED: "복구",
};

export const REPORT_STATUS_LABEL: Record<ReportStatus, string> = {
  DRAFT: "초안",
  REVIEW: "검토 중",
  CONFIRMED: "확정",
  PUBLISHED: "고객 공개",
};

export const RUN_RESULT_LABEL: Record<RunResult, string> = {
  COMPLETED: "정상 완료",
  INCOMPLETE: "미완료",
  ABORTED: "중단",
};

export const PLANNED_STATUS_LABEL: Record<PlannedRunStatus, string> = {
  PLANNED: "예정",
  DONE: "수행",
  MISSED: "미실행",
  CANCELLED: "취소",
  EXCLUDED: "제외일",
};
