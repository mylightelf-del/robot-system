/**
 * 청소로봇 통합관제 — 도메인 타입 (1단계 시제품)
 *
 * 인수인계 문서 4장 "핵심 엔터티"를 기준으로 정의했다.
 * 모든 시각은 ISO 8601 UTC 문자열로 저장하고, 화면에서는 사업장 시간대로 표시한다.
 */

export type Vendor = "PUDU" | "CENOBOTS" | "BIB";
export type RobotModel = "MT1" | "MT1_VAC" | "MT1_MAX" | "CC1" | "CC1_PRO" | "BG1" | "L4" | "J40";

export type Role =
  | "HQ_ADMIN" // 본사 관리자
  | "SITE_MANAGER" // 현장 담당자
  | "CUSTOMER_BASIC" // 고객 기본
  | "CUSTOMER_CONTROL"; // 고객 제어

/** 제조사별 원시 상태를 공통으로 정규화한 상태. 우선순위는 status.ts 참고. */
export type CommonStatus =
  | "ERROR"
  | "OFFLINE"
  | "CLEANING"
  | "PAUSED"
  | "RETURNING"
  | "CHARGING"
  | "IDLE"
  | "UNKNOWN"; // 상태 불명(데이터 미수신·미지원)과 구분

/** 공통 명령. 제조사별 의미 차이는 commands.ts에 기술한다. */
export type CommandType =
  | "START_TASK" // 등록 작업 실행
  | "PAUSE"
  | "RESUME"
  | "STOP"
  | "GO_HOME" // 복귀(충전소/대기 위치)
  | "AREA_CLEAN"; // 지도 영역 지정 청소(API 지원 시)

export type CommandState =
  | "REQUESTED" // 사용자가 요청
  | "ACCEPTED" // 제조사 API 가 접수(HTTP 성공) — 아직 실행 아님
  | "EXECUTING" // 로봇 상태/작업 이력으로 실행 확인
  | "COMPLETED"
  | "FAILED"
  | "UNKNOWN"; // 응답 유실 등으로 결과 불명

export interface Site {
  id: string;
  name: string;
  timezone: string; // IANA, 예: Asia/Seoul
  address: string;
  /** 샘플 데이터 표식. 실제 운영 데이터에는 false. */
  isSample: boolean;
}

export interface Floor {
  id: string;
  siteId: string;
  name: string;
  currentMapVersionId: string;
}

/** 지도 네 모서리 좌표: 좌하·좌상·우상·우하 순서(CenoBots 문서 기준). */
export type MapCorners = {
  bl: [number, number];
  tl: [number, number];
  tr: [number, number];
  br: [number, number];
};

export interface MapVersion {
  id: string;
  floorId: string;
  version: number;
  widthPx: number;
  heightPx: number;
  /** 오래된 지도는 null 일 수 있다. null 이면 영역 명령을 차단한다. */
  corners: MapCorners | null;
}

export interface Zone {
  id: string;
  floorId: string;
  name: string;
  polygon: [number, number][]; // 지도 좌표계(px)
  areaM2: number;
}

export interface Robot {
  id: string; // 내부 관리번호 (예: PW-R-001)
  vendor: Vendor;
  model: RobotModel;
  vendorRobotId: string; // 제조사 ID (CenoBots: deviceOpenId, PUDU: 미확인)
  siteId: string;
  floorId: string;
  name: string;
  serial: string;
  firmware: string;
  active: boolean;
  /** 샘플 표시용. 실제 지원 여부는 제조사 문서/시험으로 확인해야 한다. */
  supportedCommands: CommandType[];
  /** 내부 정비 메모 — 고객 화면에 노출하지 않는다. */
  internalNote: string;
  /**
   * 제조사 API 에서 받은 부가 정보(매장 ID, product_code, MAC 등). 고객 화면에 노출하지 않는다.
   * source="api" 이면 제조사 API 에서 등록한 실제 로봇, 없으면 샘플 적재 로봇이다.
   */
  vendorMeta?: Record<string, unknown> | null;
}

export interface RobotPlacement {
  robotId: string;
  siteId: string;
  from: string;
  to: string | null;
}

export interface Pose {
  x: number;
  y: number;
  headingDeg: number;
}

export interface RobotStatus {
  robotId: string;
  common: CommonStatus;
  /** 제조사 원시 상태 문자열(샘플). */
  raw: string;
  online: boolean;
  batteryPct: number | null; // null = 미수신
  pose: Pose | null;
  /** 오프라인 시 마지막 보고 위치인지 여부. */
  poseIsLastKnown: boolean;
  mapVersionId: string | null;
  currentMissionId: string | null;
  progressPct: number | null;
  lastReceivedAt: string | null; // 서버가 마지막으로 수신한 시각
  dataAt: string | null; // 데이터 자체의 발생 시각
}

export type CleanMode = "SWEEP" | "SCRUB" | "SWEEP_SCRUB" | "PATROL";

export interface RegisteredTask {
  id: string;
  siteId: string;
  robotId: string;
  name: string;
  zoneIds: string[];
  mode: CleanMode;
  /** 제조사 쪽 등록 작업 참조(CenoBots Favorite 등). 샘플에서는 가상값. */
  vendorTaskRef: string | null;
}

export type ScheduleExecutor = "VENDOR" | "SELF";

export interface Schedule {
  id: string;
  taskId: string;
  daysOfWeek: number[]; // 0=일 … 6=토
  time: string; // "HH:mm" 사업장 시간대
  enabled: boolean;
  /** 단일 실행 주체. CenoBots 는 제조사 예약 우선 제안. */
  executor: ScheduleExecutor;
}

export type PlannedRunStatus =
  | "PLANNED"
  | "DONE"
  | "MISSED"
  | "CANCELLED"
  | "EXCLUDED"; // 휴일·제외일

export interface PlannedRun {
  id: string;
  scheduleId: string;
  taskId: string;
  robotId: string;
  siteId: string;
  plannedAt: string;
  status: PlannedRunStatus;
  reason: string | null;
  actualRunId: string | null;
  changeHistory: { at: string; by: string; from: PlannedRunStatus; to: PlannedRunStatus; reason: string }[];
}

export type RunResult = "COMPLETED" | "INCOMPLETE" | "ABORTED";
export type RunOrigin = "PLANNED" | "ADHOC" | "REMOTE";

export interface ActualRun {
  id: string;
  /** 제조사 작업 ID. 중복 제거 키는 vendor + vendorRobotId + vendorRunId. */
  vendorRunId: string;
  robotId: string;
  /** 실행 당시 사업장. 로봇이 이동해도 과거 실적은 여기 남는다. */
  siteId: string;
  floorId: string;
  taskId: string | null;
  zoneIds: string[];
  startedAt: string;
  endedAt: string;
  result: RunResult;
  endReason: string | null;
  areaM2: number;
  durationMin: number;
  waterL: number | null; // null = 미제공
  detergentMl: number | null;
  origin: RunOrigin;
  /** 서버 수신 시각. 늦게 수신한 실적을 구분한다. */
  receivedAt: string;
}

export interface Command {
  id: string;
  userId: string;
  siteId: string;
  robotId: string;
  type: CommandType;
  params: Record<string, unknown>;
  requestedAt: string;
  expiresAt: string;
  state: CommandState;
  stateChangedAt: string;
  message: string | null;
  vendorTraceId: string | null;
  /** 샘플 어댑터 시나리오(시뮬레이션 전용). */
  simulation: "NORMAL" | "LOST_RESPONSE" | "REJECTED" | null;
}

export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type IncidentStatus = "OPEN" | "ACKED" | "ASSIGNED" | "IN_PROGRESS" | "RESOLVED";

export interface IncidentAction {
  id: string;
  at: string;
  userId: string;
  note: string;
  /** 내부 메모는 고객에게 노출하지 않는다. */
  internal: boolean;
}

export interface NotificationLog {
  id: string;
  at: string;
  channel: "EMAIL" | "KAKAO";
  recipient: string;
  status: "MOCK_SENT" | "SUPPRESSED" | "FAILED";
  reason: string;
}

export interface Incident {
  id: string;
  siteId: string;
  robotId: string;
  code: string;
  severity: Severity;
  /** 제조사 오류 원문 — 고객에게 노출하지 않는다. */
  rawMessage: string;
  /** 고객 표시용 요약. */
  customerMessage: string;
  occurredAt: string;
  status: IncidentStatus;
  acknowledgedAt: string | null;
  assigneeId: string | null;
  resolvedAt: string | null;
  /** 제조사 이벤트 ID(중복 제거용). */
  vendorEventId: string | null;
  actions: IncidentAction[];
  notifications: NotificationLog[];
}

export interface Inspection {
  id: string;
  siteId: string;
  robotId: string;
  item: string; // 물 보충, 오수 처리, 브러시 청소 등
  dueAt: string;
  doneAt: string | null;
  doneBy: string | null;
  note: string | null;
}

export interface MaintenanceItem {
  name: string;
  remainingPct: number | null;
  source: "API" | "MANUAL" | "UNSUPPORTED";
}

export type ReportStatus = "DRAFT" | "REVIEW" | "CONFIRMED" | "PUBLISHED";

export interface ReportComments {
  overallOpinion: string;
  incompleteReasons: string;
  improvements: string;
  focusZones: string;
  nextMonthPlan: string;
}

export interface ReportAggregates {
  generatedAt: string;
  siteName: string;
  month: string;
  robotCount: number;
  validPlanned: number;
  plannedCompleted: number;
  completionRatePct: number | null; // 분모 0 = null(해당 없음)
  cancelled: number;
  excluded: number;
  missed: number;
  adhocRuns: number;
  totalRuns: number;
  cumulativeAreaM2: number; // 누적(중복 포함)
  totalDurationMin: number;
  waterL: number | null;
  detergentMl: number | null;
  byFloor: { floorId: string; floorName: string; runs: number; areaM2: number; durationMin: number }[];
  byZone: { zoneId: string; zoneName: string; floorName: string; runs: number; areaM2: number }[];
  byRobot: { robotId: string; name: string; model: string; runs: number; completed: number; areaM2: number }[];
  incidents: { id: string; code: string; severity: Severity; occurredAt: string; resolvedAt: string | null; customerMessage: string; actionSummary: string }[];
  inspections: { item: string; done: number; total: number }[];
  dataGapDays: string[]; // 데이터 미수신 일자
  unsupportedMetrics: string[];
  /** 이 집계에 포함된 실적 중 가장 늦은 수신 시각. 이후 수신분은 "늦은 실적"으로 별도 계산한다. */
  includesRunsReceivedUntil: string;
}

export interface ReportVersion {
  id: string;
  siteId: string;
  month: string; // YYYY-MM
  version: number;
  status: ReportStatus;
  aggregates: ReportAggregates; // 초안은 재집계 가능, 확정 후 스냅샷
  comments: ReportComments;
  createdAt: string;
  createdBy: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  publishedAt: string | null;
}

export interface AuditLog {
  id: string;
  at: string;
  userId: string;
  userName: string;
  siteId: string | null;
  robotId: string | null;
  action: string;
  params: Record<string, unknown>;
  result: "OK" | "DENIED" | "ERROR";
  detail: string | null;
  vendorTraceId: string | null;
}

export interface SitePermission {
  siteId: string;
  /** 고객 제어 역할에서 명령별로 부여. 다른 역할은 역할 규칙을 따른다. */
  allowedCommands: CommandType[];
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  /** 본사 관리자는 비어 있으면 전체 사업장. */
  sitePermissions: SitePermission[];
}

export interface NotificationRecipient {
  id: string;
  channel: "EMAIL" | "KAKAO";
  address: string;
  minSeverity: Severity;
  hoursFrom: string; // "HH:mm"
  hoursTo: string;
}

export interface NotificationSetting {
  siteId: string;
  recipients: NotificationRecipient[];
  dedupeMinutes: number;
  escalateAfterMinutes: number;
}

export interface VendorConnection {
  id: string;
  vendor: Vendor;
  label: string;
  /** SAMPLE: 샘플 어댑터, NOT_CONFIGURED: 실제 키 미입력 */
  status: "SAMPLE" | "NOT_CONFIGURED";
  region: string | null;
  notes: string;
}
