import type { ReportKind } from "@/lib/reports/schedule";
/**
 * 청소로봇 통합관제 — 도메인 타입 (1단계 시제품)
 *
 * 인수인계 문서 4장 "핵심 엔터티"를 기준으로 정의했다.
 * 모든 시각은 ISO 8601 UTC 문자열로 저장하고, 화면에서는 사업장 시간대로 표시한다.
 */

export type Vendor = "PUDU" | "CENOBOTS" | "BIB";
export type RobotModel = "MT1" | "MT1_VAC" | "MT1_MAX" | "CC1" | "CC1_PRO" | "BG1" | "BG1_PRO" | "L4" | "J40";

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
  /** 설치일(YYYY-MM-DD, 사업장 시간대). 보고서 일정의 기준(D0). 미등록이면 null. */
  installedOn: string | null;
  /** 원격 제어 허용(사업장별). 기본 꺼짐. */
  remoteControlEnabled: boolean;
  /** 사용 중지 시각. null 이면 운영 중. 중지된 사업장은 운영 화면·동기화·알림에서 빠지고 이력만 보존된다. */
  retiredAt: string | null;
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

/** 제조사 지도의 지점. 실기(PUDU 2026-11-08): source(mode return_point)=반환 지점, charging_pile=충전 더미, chargeWorkStation=워크스테이션, maintenance=유지보수 지점. 좌표는 지도 px, yaw 는 도(°). */
export interface MapPoint {
  type: "CHARGING" | "WORKSTATION" | "RETURN" | "MAINTENANCE" | "OTHER";
  name: string;
  x: number;
  y: number;
  yawDeg: number | null;
  vendorType: string;
}

export interface MapVersion {
  id: string;
  floorId: string;
  version: number;
  widthPx: number;
  heightPx: number;
  /** 오래된 지도는 null 일 수 있다. null 이면 영역 명령을 차단한다. */
  corners: MapCorners | null;
  /** 제조사 지도에서 가져온 경우. 샘플 지도는 모두 없음. */
  vendor?: Vendor | null;
  vendorMapName?: string | null; // 예: PUDU "1#2#포스코센터1층_"
  imageUrl?: string | null;
  resolution?: number | null; // m/px
  origin?: [number, number] | null; // 이미지 좌하단 픽셀의 월드 좌표(m) — ROS 지도 관례
  /** 제조사 지도의 지점(충전소 등)과 금지 구역. 없으면 표시하지 않는다. */
  points?: MapPoint[] | null;
  forbidden?: [number, number][][] | null;
}

/** 월드 좌표(m) → 이미지 픽셀. ROS/PUDU 관례: u=(x-ox)/res, v=height-(y-oy)/res */
export function worldToPixel(map: Pick<MapVersion, "heightPx" | "resolution" | "origin">, x: number, y: number): { x: number; y: number } | null {
  if (!map.resolution || !map.origin) return null;
  return { x: (x - map.origin[0]) / map.resolution, y: map.heightPx - (y - map.origin[1]) / map.resolution };
}

export interface Zone {
  id: string;
  floorId: string;
  name: string;
  polygon: [number, number][]; // 지도 좌표계(px)
  areaM2: number;
  /** 제조사 지도의 구역 ID(실적의 구역별 수행과 맞추는 키). */
  vendorZoneId?: string | null;
}

/** 청소 범위 증빙(제조사 보고서 파싱). 구역별 청소 횟수와 결과 지도 이미지 URL. */
export interface RunCoverage {
  /** 작업 수행률(%). 제조사가 주지 않으면 null. */
  percentage: number | null;
  mapName: string | null;
  mapVersion: number | null;
  /** 제조사가 만든 결과 지도(청소 궤적·면적) 이미지 URL. 서버가 받아 보관한다. */
  resultImageUrl: string | null;
  heatmapUrl: string | null;
  /** 작업에 포함된 구역과 청소 횟수(0 = 이번 작업에서 안 함). */
  areas: { vendorId: string; name: string; cleanCount: number; areaM2: number }[];
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
  /** 청소 범위 증빙. 제조사 보고서에 없으면 null/undefined. */
  coverage?: RunCoverage | null;
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
  /** 어느 입구(웹/앱)·어느 기기에서 낸 명령인지. 감사 기록에도 같은 값이 남는다. 이전 기록은 null. */
  origin?: CommandOrigin | null;
}

/** 명령·로그인 입구. web = 브라우저(쿠키 세션), app = 모바일 앱(Bearer 토큰). */
export type SessionKind = "web" | "app";
export interface CommandOrigin {
  channel: SessionKind;
  /** 기기 이름(앱이 보낸 값 또는 User-Agent 요약). */
  device: string;
  /** 세션 ID(토큰 해시). 기기 목록과 대조용. */
  sessionId: string | null;
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

/** 알림 채널. PUSH 는 앱에 로그인한 기기로 보내는 푸시(주소는 카카오와 같은 "user:<사용자 ID>"). */
export type NotifyChannel = "EMAIL" | "KAKAO" | "PUSH";
export const NOTIFY_CHANNEL_LABEL: Record<NotifyChannel, string> = { EMAIL: "이메일", KAKAO: "카카오톡", PUSH: "앱 푸시" };

export interface NotificationLog {
  id: string;
  at: string;
  channel: NotifyChannel;
  recipient: string;
  /** SENT: 실제 발송(공급사 접수), MOCK_SENT: 모의(설정 전), SUPPRESSED: 설정으로 억제, FAILED: 발송 실패 */
  status: "SENT" | "MOCK_SENT" | "SUPPRESSED" | "FAILED";
  reason: string;
  kind?: NotifyKind;
  refId?: string | null;
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
  /** 같은 코드의 반복 발생 횟수(묶음). */
  occurrences?: number;
  lastOccurredAt?: string | null;
  /** 불필요한 알림으로 삭제(숨김)된 시각·사용자·사유. 목록·보고서에서 빠진다. */
  dismissedAt?: string | null;
  dismissedBy?: string | null;
  dismissReason?: string | null;
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
  /** 예측(최근 이력의 감소 속도, 직선 가정). 이력이 모자라면 null. */
  ratePctPerDay?: number | null;
  daysLeft?: number | null;
  expectedDate?: string | null;
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
  /** 집계 기간(사업장 시간대 날짜, 끝 포함). 2026-10-30 이전 데이터에는 없고 month 만 있다. */
  periodStart?: string;
  periodEnd?: string;
  /** (구) 달력 월 보고서의 월. */
  month?: string;
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
  /** 일자별 실적(주간·월간). */
  byDay?: { date: string; runs: number; completed: number; areaM2: number; durationMin: number }[];
  /** 작업 목록(일간·설치 보고서, 최대 200건). 고객 공개 필드만. */
  runList?: { runId?: string; startedAt: string; robotName: string; floorName: string; origin: "PLANNED" | "ADHOC" | "REMOTE"; result: string; areaM2: number; durationMin: number; completionPct?: number | null; hasResultImage?: boolean }[];
  /** 설치 현황(설치 완료보고서). 집계 시점의 구성 스냅샷. */
  installation?: {
    installedOn: string;
    robots: { name: string; model: string; floorName: string }[];
    floors: { name: string; mapVersion: number | null; mapSource: string; zones: number }[];
    tasks: { name: string; robotName: string; zones: number }[];
    schedules: { taskName: string; days: string; time: string; enabled: boolean }[];
    /** 층별 지도와 청소 구역(지도 좌표 px). 이미지가 없는 층은 구역만 그린다. */
    maps?: { floorId: string; floorName: string; mapVersionId: string; hasImage: boolean; widthPx: number; heightPx: number; zones: { name: string; polygon: [number, number][]; areaM2: number }[] }[];
    /** 주간 예약 타임라인(사용 중인 예약만). durationMin 은 최근 실적 평균(없으면 null = 미정). */
    weekly?: { robotName: string; taskName: string; floorName: string; daysOfWeek: number[]; time: string; durationMin: number | null }[];
  };
  dataGapDays: string[]; // 데이터 미수신 일자
  unsupportedMetrics: string[];
  /** 생산성 = 누적 청소 면적 ÷ 총 작업 시간(㎡/시간). 작업 시간 0 이면 null. 2026-11-07 이후 집계에만 있다. */
  productivityM2PerHour?: number | null;
  /** 기간 안에 발생해 복구된 장애의 평균 조치 시간(분). 없으면 null. */
  incidentMttrMin?: number | null;
  /** 제조사 보고서의 작업 수행률 평균(%). 증빙이 있는 실적만. 없으면 null. */
  avgCompletionPct?: number | null;
  /** 직전 같은 길이 기간의 요약(추이 비교용). 설치 보고서에는 없다. */
  prev?: { periodStart: string; periodEnd: string; totalRuns: number; cumulativeAreaM2: number; totalDurationMin: number; completionRatePct: number | null; incidents: number; productivityM2PerHour: number | null };
  /** 이 집계에 포함된 실적 중 가장 늦은 수신 시각. 이후 수신분은 "늦은 실적"으로 별도 계산한다. */
  includesRunsReceivedUntil: string;
}

/** 웹에서 고친 수치. 키 예: "summary.totalRuns", "byFloor.<floorId>.areaM2", "byDay.2026-10-16.runs". 원래 집계값은 aggregates 에 그대로 둔다. */
export type ReportAdjustments = Record<string, { value: number; original: number | null; by: string; at: string }>;

/** 보고서에 사람이 적는 구조화 내용(설치 보고서의 단계 일정·작업 일지 등). */
export interface ReportContent {
  phases?: { label: string; from: string; to: string }[];
  workLog?: { part: string; staff: string; content: string }[];
}

export interface ReportPhoto {
  id: string;
  reportId: string;
  caption: string;
  contentType: string;
  sort: number;
  createdAt: string;
  createdBy: string;
}

export interface ReportVersion {
  id: string;
  siteId: string;
  kind: ReportKind;
  seq: number;
  periodStart: string; // YYYY-MM-DD (사업장 시간대)
  periodEnd: string; // 포함
  version: number;
  status: ReportStatus;
  aggregates: ReportAggregates; // 초안은 재집계 가능, 확정 후 스냅샷
  comments: ReportComments;
  adjustments: ReportAdjustments;
  content: ReportContent;
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

/** 통보 종류: 장애 발생·복구 / 미조치 확대 / 예정 작업 미실행 / 장기간 무실적 / 보고서 발행 */
/** DELIVERY(배송 도착)는 목적지별 수신자에게만 가며 사업장 수신자 구독 목록(NOTIFY_KINDS)에는 넣지 않는다. */
export type NotifyKind = "INCIDENT" | "ESCALATION" | "MISSED_RUN" | "NO_ACTIVITY" | "REPORT" | "CONSUMABLE" | "DELIVERY";
export const NOTIFY_KINDS: NotifyKind[] = ["INCIDENT", "ESCALATION", "MISSED_RUN", "NO_ACTIVITY", "REPORT", "CONSUMABLE"];
export const NOTIFY_KIND_LABEL: Record<NotifyKind, string> = { INCIDENT: "장애 발생·복구", ESCALATION: "미조치 확대 통보", MISSED_RUN: "예정 작업 미실행", NO_ACTIVITY: "장기간 무실적", REPORT: "보고서 발행", CONSUMABLE: "소모품·점검", DELIVERY: "배송 도착" };

export interface NotificationRecipient {
  id: string;
  channel: NotifyChannel;
  address: string;
  minSeverity: Severity;
  hoursFrom: string; // "HH:mm"
  hoursTo: string;
  /** 받을 통보 종류(없으면 전부). */
  kinds: NotifyKind[];
}

export interface NotificationSetting {
  siteId: string;
  recipients: NotificationRecipient[];
  dedupeMinutes: number;
  escalateAfterMinutes: number;
  /** 이 시간 동안 실적이 없는 로봇을 통보(시간). 0 = 끔. */
  noActivityHours: number;
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
