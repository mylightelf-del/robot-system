/**
 * PostgreSQL 스키마 (Drizzle ORM). 컬럼명은 snake_case 로 자동 변환된다(casing 설정).
 *
 * 원칙
 * - 시각은 timestamptz 로 저장하고, 앱에서는 ISO 8601 UTC 문자열로 다룬다(isoTimestamp).
 * - 제조사 원시 데이터는 jsonb 에 그대로 보관한다(raw_payload).
 * - 정합성 규칙은 가능한 한 DB 제약으로 강제한다: 실적 중복 키, 명령 멱등 키, 보고서 버전, 이메일 유일.
 * - 마이그레이션 SQL 은 drizzle/ 폴더에 생성되어 git 으로 이력을 관리한다.
 */
import { boolean, customType, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";
import type { ReportKind } from "@/lib/reports/schedule";
import type {
  CleanMode,
  CommandOrigin,
  CommandState,
  CommandType,
  CommonStatus,
  IncidentStatus,
  MapCorners,
  PlannedRun,
  PlannedRunStatus,
  Pose,
  ReportAggregates,
  ReportAdjustments,
  ReportComments,
  ReportContent,
  ReportStatus,
  RobotModel,
  Role,
  RunOrigin,
  RunResult,
  ScheduleExecutor,
  Severity,
  NotifyChannel,
  NotifyKind,
  RunCoverage,
  MapPoint,
  SessionKind,
  Vendor,
} from "@/lib/domain/types";

/** timestamptz ↔ ISO 문자열. 드라이버가 Date 를 주든 문자열을 주든 ISO 로 정규화한다. */
const isoTimestamp = customType<{ data: string; driverData: string | Date }>({
  dataType() {
    return "timestamp with time zone";
  },
  fromDriver(value) {
    return (value instanceof Date ? value : new Date(value)).toISOString();
  },
  toDriver(value) {
    return value;
  },
});

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  fromDriver(value) {
    return Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
  },
  toDriver(value) {
    return value;
  },
});

export const sites = pgTable("sites", {
  id: text().primaryKey(),
  name: text().notNull(),
  timezone: text().notNull(),
  address: text().notNull().default(""),
  isSample: boolean().notNull().default(false),
  installedOn: text(),
  /** 원격 제어 허용(사업장별, 본사 관리자가 켜고 끈다). 꺼져 있으면 누구도 이 사업장 로봇에 명령을 보낼 수 없다. 기본 꺼짐. */
  remoteControlEnabled: boolean().notNull().default(false),
  /** 사용 중지 시각(ISO). 값이 있으면 운영 화면·동기화·알림·보고서 일정에서 빠지고, 이력(실적·장애·보고서)은 보존된다. 고급 설정에서 다시 사용 가능. */
  retiredAt: isoTimestamp(),
});

export const floors = pgTable("floors", {
  id: text().primaryKey(),
  siteId: text()
    .notNull()
    .references(() => sites.id),
  name: text().notNull(),
  currentMapVersionId: text().notNull(),
});

export const mapVersions = pgTable("map_versions", {
  id: text().primaryKey(),
  floorId: text()
    .notNull()
    .references(() => floors.id),
  version: integer().notNull(),
  widthPx: integer().notNull(),
  heightPx: integer().notNull(),
  corners: jsonb().$type<MapCorners | null>(),
  // 제조사 지도(실기: PUDU GetMapDetailV2) — 이미지 URL, 해상도(m/px), 원점(이미지 좌하단의 월드 좌표 m). 샘플 지도는 모두 null.
  vendor: text().$type<Vendor>(),
  vendorMapName: text(),
  imageUrl: text(),
  resolution: doublePrecision(),
  origin: jsonb().$type<[number, number] | null>(),
  /** 제조사 지도의 지점(충전소·워크스테이션·반환 지점·유지보수 지점) — 지도 px 좌표. 가져오기·요소 갱신 때 채운다. */
  points: jsonb().$type<MapPoint[] | null>(),
  /** 제조사 지도의 금지 구역 폴리곤(px). 화면에 옅게 표시만 한다. */
  forbidden: jsonb().$type<[number, number][][] | null>(),
});

/**
 * 제조사 지도 이미지 보관. 가져올 때 원본(PUDU S3)을 내려받아 DB 에 두고 /api/maps/<id> 로 서비스한다(원본 URL 이 바뀌거나 막혀도 지도가 비지 않도록).
 * pg_dump 백업에 함께 포함된다.
 */
export const mapImages = pgTable("map_images", {
  mapVersionId: text()
    .primaryKey()
    .references(() => mapVersions.id),
  contentType: text().notNull(),
  bytes: bytea().notNull(),
  size: integer().notNull(),
  sourceUrl: text().notNull(),
  fetchedAt: isoTimestamp().notNull(),
});

export const zones = pgTable("zones", {
  id: text().primaryKey(),
  floorId: text()
    .notNull()
    .references(() => floors.id),
  name: text().notNull(),
  polygon: jsonb().$type<[number, number][]>().notNull(),
  areaM2: doublePrecision().notNull(),
  /** 제조사 지도의 구역(area) ID. 실적의 구역별 수행(area_array.area_id)과 맞추는 키. 샘플·수기 구역은 null. */
  vendorZoneId: text(),
});

export const robots = pgTable("robots", {
  id: text().primaryKey(),
  vendor: text().$type<Vendor>().notNull(),
  model: text().$type<RobotModel>().notNull(),
  vendorRobotId: text().notNull(),
  siteId: text()
    .notNull()
    .references(() => sites.id),
  floorId: text()
    .notNull()
    .references(() => floors.id),
  name: text().notNull(),
  serial: text().notNull().default(""),
  firmware: text().notNull().default(""),
  active: boolean().notNull().default(true),
  supportedCommands: jsonb().$type<CommandType[]>().notNull(),
  internalNote: text().notNull().default(""),
  /** 제조사 측 부가 정보(PUDU: shop_id, product_code, mac, nickname 등). 화면에는 직원에게만 노출. */
  vendorMeta: jsonb().$type<Record<string, unknown>>(),
});

export const robotPlacements = pgTable(
  "robot_placements",
  {
    id: text().primaryKey(),
    robotId: text()
      .notNull()
      .references(() => robots.id),
    siteId: text()
      .notNull()
      .references(() => sites.id),
    from: isoTimestamp().notNull(),
    to: isoTimestamp(),
  },
  (t) => [index("robot_placements_robot_idx").on(t.robotId)],
);

export const robotStatus = pgTable("robot_status", {
  robotId: text()
    .primaryKey()
    .references(() => robots.id),
  common: text().$type<CommonStatus>().notNull(),
  raw: text().notNull().default(""),
  online: boolean().notNull().default(false),
  batteryPct: doublePrecision(),
  pose: jsonb().$type<Pose | null>(),
  poseIsLastKnown: boolean().notNull().default(false),
  mapVersionId: text(),
  currentMissionId: text(),
  progressPct: doublePrecision(),
  lastReceivedAt: isoTimestamp(),
  dataAt: isoTimestamp(),
  rawPayload: jsonb(),
});

export const registeredTasks = pgTable("registered_tasks", {
  id: text().primaryKey(),
  siteId: text()
    .notNull()
    .references(() => sites.id),
  robotId: text()
    .notNull()
    .references(() => robots.id),
  name: text().notNull(),
  zoneIds: jsonb().$type<string[]>().notNull(),
  mode: text().$type<CleanMode>().notNull(),
  vendorTaskRef: text(),
});

export const schedules = pgTable("schedules", {
  id: text().primaryKey(),
  taskId: text()
    .notNull()
    .references(() => registeredTasks.id),
  daysOfWeek: jsonb().$type<number[]>().notNull(),
  time: text().notNull(),
  enabled: boolean().notNull().default(true),
  executor: text().$type<ScheduleExecutor>().notNull(),
});

export const plannedRuns = pgTable(
  "planned_runs",
  {
    id: text().primaryKey(),
    scheduleId: text().notNull(),
    taskId: text().notNull(),
    robotId: text()
      .notNull()
      .references(() => robots.id),
    siteId: text()
      .notNull()
      .references(() => sites.id),
    plannedAt: isoTimestamp().notNull(),
    status: text().$type<PlannedRunStatus>().notNull(),
    reason: text(),
    actualRunId: text(),
    changeHistory: jsonb().$type<PlannedRun["changeHistory"]>().notNull().default([]),
  },
  (t) => [index("planned_runs_site_time_idx").on(t.siteId, t.plannedAt)],
);

export const actualRuns = pgTable(
  "actual_runs",
  {
    id: text().primaryKey(),
    vendor: text().$type<Vendor>().notNull(),
    vendorRobotId: text().notNull(),
    vendorRunId: text().notNull(),
    robotId: text()
      .notNull()
      .references(() => robots.id),
    siteId: text()
      .notNull()
      .references(() => sites.id),
    floorId: text().notNull(),
    taskId: text(),
    zoneIds: jsonb().$type<string[]>().notNull(),
    startedAt: isoTimestamp().notNull(),
    endedAt: isoTimestamp().notNull(),
    result: text().$type<RunResult>().notNull(),
    endReason: text(),
    areaM2: doublePrecision().notNull(),
    durationMin: doublePrecision().notNull(),
    waterL: doublePrecision(),
    detergentMl: doublePrecision(),
    origin: text().$type<RunOrigin>().notNull(),
    receivedAt: isoTimestamp().notNull(),
    rawPayload: jsonb(),
    /** 청소 범위 증빙(제조사 보고서에서 파싱): 수행률·구역별 청소 횟수·결과 지도 URL. 없으면 null. */
    coverage: jsonb().$type<RunCoverage | null>(),
  },
  (t) => [
    // 실적 중복 제거 키: 제조사 + 제조사 로봇 ID + 제조사 작업 ID
    uniqueIndex("actual_runs_dedupe_key").on(t.vendor, t.vendorRobotId, t.vendorRunId),
    index("actual_runs_site_started_idx").on(t.siteId, t.startedAt),
    index("actual_runs_robot_started_idx").on(t.robotId, t.startedAt),
  ],
);

/** 실적의 결과 지도 이미지(제조사 S3 에서 받아 보관 — 증빙은 제조사 보관 기간과 무관하게 남긴다). */
export const runImages = pgTable(
  "run_images",
  {
    id: text().primaryKey(),
    runId: text()
      .notNull()
      .references(() => actualRuns.id),
    kind: text().$type<"RESULT" | "HEATMAP">().notNull(),
    contentType: text().notNull(),
    data: bytea().notNull(),
    fetchedAt: isoTimestamp().notNull(),
  },
  (t) => [uniqueIndex("run_images_run_kind").on(t.runId, t.kind)],
);

export const commands = pgTable(
  "commands",
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    siteId: text()
      .notNull()
      .references(() => sites.id),
    robotId: text()
      .notNull()
      .references(() => robots.id),
    type: text().$type<CommandType>().notNull(),
    params: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    requestedAt: isoTimestamp().notNull(),
    expiresAt: isoTimestamp().notNull(),
    state: text().$type<CommandState>().notNull(),
    stateChangedAt: isoTimestamp().notNull(),
    message: text(),
    vendorTraceId: text(),
    simulation: text().$type<"NORMAL" | "LOST_RESPONSE" | "REJECTED" | null>(),
    idempotencyKey: text(),
    /** 어느 입구(웹/앱)·기기에서 낸 명령인지. */
    origin: jsonb().$type<CommandOrigin>(),
  },
  (t) => [uniqueIndex("commands_idempotency_key").on(t.idempotencyKey), index("commands_robot_idx").on(t.robotId, t.requestedAt), index("commands_robot_state_idx").on(t.robotId, t.state)],
);

export const incidents = pgTable(
  "incidents",
  {
    id: text().primaryKey(),
    siteId: text()
      .notNull()
      .references(() => sites.id),
    robotId: text()
      .notNull()
      .references(() => robots.id),
    code: text().notNull(),
    severity: text().$type<Severity>().notNull(),
    rawMessage: text().notNull().default(""),
    customerMessage: text().notNull(),
    occurredAt: isoTimestamp().notNull(),
    status: text().$type<IncidentStatus>().notNull(),
    acknowledgedAt: isoTimestamp(),
    assigneeId: text(),
    resolvedAt: isoTimestamp(),
    vendorEventId: text(),
    rawPayload: jsonb(),
    // 같은 로봇·같은 코드의 반복 발생은 새 장애를 만들지 않고 횟수만 늘린다(실기: 위치 상실 경고가 하루 수 건).
    occurrences: integer().notNull().default(1),
    lastOccurredAt: isoTimestamp(),
    /** 묶인 반복 발생의 제조사 이벤트 키(재동기화 시 중복 집계 방지). */
    groupedEventIds: jsonb().$type<string[]>().notNull().default([]),
    /** 불필요한 알림 삭제(숨김). 행은 남겨 같은 제조사 이벤트가 다시 적재되지 않게 하고, 본사 관리자가 복원할 수 있다. */
    dismissedAt: isoTimestamp(),
    dismissedBy: text(),
    dismissReason: text(),
  },
  (t) => [uniqueIndex("incidents_vendor_event_key").on(t.vendorEventId), index("incidents_site_idx").on(t.siteId, t.occurredAt), index("incidents_robot_code_status_idx").on(t.robotId, t.code, t.status)],
);

export const incidentActions = pgTable("incident_actions", {
  id: text().primaryKey(),
  incidentId: text()
    .notNull()
    .references(() => incidents.id),
  at: isoTimestamp().notNull(),
  userId: text().notNull(),
  note: text().notNull(),
  internal: boolean().notNull().default(true),
});

export const notificationLogs = pgTable("notification_logs", {
  id: text().primaryKey(),
  /** 장애 통보일 때만. 그 밖의 통보(미실행·무실적·보고서)는 null 이고 kind·refId 로 구분한다. */
  incidentId: text().references(() => incidents.id),
  at: isoTimestamp().notNull(),
  channel: text().$type<NotifyChannel>().notNull(),
  recipient: text().notNull(),
  status: text().$type<"SENT" | "MOCK_SENT" | "SUPPRESSED" | "FAILED">().notNull(),
  reason: text().notNull().default(""),
  kind: text().$type<NotifyKind>().notNull().default("INCIDENT"),
  /** 통보 대상 ID(계획 회차·로봇·보고서). 같은 대상에 한 번만 보내는 기준. */
  refId: text(),
});

/** 소모품 잔여 수명의 일별 이력(교체 예상일 계산용). 로봇·항목·날짜당 1행. */
export const maintenanceHistory = pgTable(
  "maintenance_history",
  {
    id: text().primaryKey(),
    robotId: text()
      .notNull()
      .references(() => robots.id),
    name: text().notNull(),
    remainingPct: doublePrecision().notNull(),
    at: isoTimestamp().notNull(),
  },
  (t) => [index("maintenance_history_robot_idx").on(t.robotId, t.at)],
);

/** 장애 조치 사진. 장애에 딸리며 내부(고객 비공개) 표시를 따른다. */
export const incidentPhotos = pgTable(
  "incident_photos",
  {
    id: text().primaryKey(),
    incidentId: text()
      .notNull()
      .references(() => incidents.id),
    caption: text().notNull().default(""),
    contentType: text().notNull(),
    data: bytea().notNull(),
    internal: boolean().notNull().default(true),
    createdAt: isoTimestamp().notNull(),
    createdBy: text().notNull(),
  },
  (t) => [index("incident_photos_incident_idx").on(t.incidentId)],
);

/** 외부 연동용 읽기 전용 API 토큰. 값은 해시로만 저장(발급 때 한 번 보여 줌). siteIds 가 비면 전체 사업장. */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    tokenHash: text().notNull(),
    siteIds: jsonb().$type<string[]>().notNull().default([]),
    createdBy: text().notNull(),
    createdAt: isoTimestamp().notNull(),
    lastUsedAt: isoTimestamp(),
    useCount: integer().notNull().default(0),
    revokedAt: isoTimestamp(),
  },
  (t) => [uniqueIndex("api_tokens_hash_key").on(t.tokenHash)],
);

export const inspections = pgTable("inspections", {
  id: text().primaryKey(),
  siteId: text()
    .notNull()
    .references(() => sites.id),
  robotId: text()
    .notNull()
    .references(() => robots.id),
  item: text().notNull(),
  dueAt: isoTimestamp().notNull(),
  doneAt: isoTimestamp(),
  doneBy: text(),
  note: text(),
});

export const maintenanceItems = pgTable("maintenance_items", {
  id: text().primaryKey(),
  robotId: text()
    .notNull()
    .references(() => robots.id),
  name: text().notNull(),
  remainingPct: doublePrecision(),
  source: text().$type<"API" | "MANUAL" | "UNSUPPORTED">().notNull(),
});

export const reportVersions = pgTable(
  "report_versions",
  {
    id: text().primaryKey(),
    siteId: text()
      .notNull()
      .references(() => sites.id),
    kind: text().$type<ReportKind>().notNull().default("MONTHLY"),
    seq: integer().notNull().default(0),
    periodStart: text().notNull(),
    periodEnd: text().notNull(),
    version: integer().notNull(),
    status: text().$type<ReportStatus>().notNull(),
    aggregates: jsonb().$type<ReportAggregates>().notNull(),
    comments: jsonb().$type<ReportComments>().notNull(),
    adjustments: jsonb().$type<ReportAdjustments>().notNull().default({}),
    content: jsonb().$type<ReportContent>().notNull().default({}),
    createdAt: isoTimestamp().notNull(),
    createdBy: text().notNull(),
    reviewedAt: isoTimestamp(),
    reviewedBy: text(),
    confirmedAt: isoTimestamp(),
    confirmedBy: text(),
    publishedAt: isoTimestamp(),
  },
  (t) => [uniqueIndex("report_versions_site_period_version").on(t.siteId, t.kind, t.periodStart, t.periodEnd, t.version)],
);

/**
 * 보고서 첨부 사진(현장·설치 사진). 보고서 버전에 딸리며 보존 기한 없이 보관한다(pg_dump 백업에 포함).
 * 화면에서 줄인 JPEG 로 올라온다(긴 변 1600px). 확정된 버전의 사진은 바꿀 수 없다.
 */
export const reportPhotos = pgTable(
  "report_photos",
  {
    id: text().primaryKey(),
    reportId: text()
      .notNull()
      .references(() => reportVersions.id),
    caption: text().notNull().default(""),
    contentType: text().notNull(),
    data: bytea().notNull(),
    sort: integer().notNull().default(0),
    createdAt: isoTimestamp().notNull(),
    createdBy: text().notNull(),
  },
  (t) => [index("report_photos_report_idx").on(t.reportId)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: text().primaryKey(),
    at: isoTimestamp().notNull(),
    userId: text().notNull(),
    userName: text().notNull(),
    siteId: text(),
    robotId: text(),
    action: text().notNull(),
    params: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    result: text().$type<"OK" | "DENIED" | "ERROR">().notNull(),
    detail: text(),
    vendorTraceId: text(),
  },
  (t) => [index("audit_logs_at_idx").on(t.at)],
);

export const users = pgTable(
  "users",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    email: text().notNull(),
    role: text().$type<Role>().notNull(),
    active: boolean().notNull().default(true),
    /** scrypt 해시. null 이면 아직 초대 링크로 비밀번호를 설정하지 않은 계정. */
    passwordHash: text(),
    inviteToken: text(),
    inviteExpiresAt: isoTimestamp(),
    failedLogins: integer().notNull().default(0),
    lockedUntil: isoTimestamp(),
    lastLoginAt: isoTimestamp(),
    createdAt: isoTimestamp().notNull(),
    /** 휴대폰 번호(숫자만, 카카오 알림톡 수신용). 직원 본인이 내 계정에서 입력. */
    phone: text(),
  },
  (t) => [uniqueIndex("users_email_key").on(t.email), uniqueIndex("users_invite_token_key").on(t.inviteToken)],
);

export const sitePermissions = pgTable(
  "site_permissions",
  {
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    siteId: text()
      .notNull()
      .references(() => sites.id),
    allowedCommands: jsonb().$type<CommandType[]>().notNull().default([]),
  },
  (t) => [primaryKey({ columns: [t.userId, t.siteId] })],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: isoTimestamp().notNull(),
    expiresAt: isoTimestamp().notNull(),
    lastSeenAt: isoTimestamp().notNull(),
    userAgent: text().notNull().default(""),
    /** web = 브라우저 쿠키, app = 모바일 앱 Bearer 토큰(만료가 더 길다). */
    kind: text().$type<SessionKind>().notNull().default("web"),
    /** 기기 이름(앱이 보낸 값 또는 User-Agent 요약). 내 계정의 '로그인된 기기' 에 표시. */
    deviceName: text().notNull().default(""),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

/**
 * 앱 푸시 기기(FCM 등록 토큰). 앱 세션에 묶여 있어 로그아웃·기기 끊기·사용자 비활성화 시 함께 지워진다.
 * FCM 이 "등록 해제됨" 을 돌려주면 disabledAt 을 찍고 더 보내지 않는다(앱 삭제 뒤 정리).
 */
export const pushDevices = pgTable(
  "push_devices",
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: text()
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    token: text().notNull(),
    platform: text().$type<"android" | "ios">().notNull(),
    appVersion: text().notNull().default(""),
    deviceName: text().notNull().default(""),
    createdAt: isoTimestamp().notNull(),
    lastSeenAt: isoTimestamp().notNull(),
    disabledAt: isoTimestamp(),
    lastError: text(),
  },
  (t) => [uniqueIndex("push_devices_token_key").on(t.token), index("push_devices_user_idx").on(t.userId)],
);

/**
 * 카카오톡 알림 연결(사용자별 "나에게 보내기"). 사용자가 카카오 로그인으로 직접 연결하고, 서버는 그 사용자 자신의 카카오톡으로만 보낸다.
 * 토큰은 TOKEN_ENCRYPTION_KEY 로 암호화해 둔다. 리프레시 토큰은 남은 기간이 1개월 미만일 때 갱신 응답에 새로 온다(공식 문서).
 */
export const kakaoLinks = pgTable("kakao_links", {
  userId: text()
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  kakaoUserId: text().notNull(),
  accessToken: text().notNull(),
  accessExpiresAt: isoTimestamp().notNull(),
  refreshToken: text().notNull(),
  refreshExpiresAt: isoTimestamp(),
  linkedAt: isoTimestamp().notNull(),
  lastSentAt: isoTimestamp(),
  lastError: text(),
});

export const notificationSettings = pgTable("notification_settings", {
  siteId: text()
    .primaryKey()
    .references(() => sites.id),
  dedupeMinutes: integer().notNull().default(30),
  escalateAfterMinutes: integer().notNull().default(60),
  /** 이 시간(시간 단위) 동안 실적이 없는 로봇을 통보. 0 = 끔. */
  noActivityHours: integer().notNull().default(0),
});

export const notificationRecipients = pgTable("notification_recipients", {
  id: text().primaryKey(),
  siteId: text()
    .notNull()
    .references(() => sites.id),
  channel: text().$type<NotifyChannel>().notNull(),
  address: text().notNull(),
  minSeverity: text().$type<Severity>().notNull(),
  hoursFrom: text().notNull().default("00:00"),
  hoursTo: text().notNull().default("23:59"),
  /** 받을 통보 종류. 기본은 전부. */
  kinds: jsonb().$type<NotifyKind[]>().notNull().default(["INCIDENT", "ESCALATION", "MISSED_RUN", "NO_ACTIVITY", "REPORT"]),
});

export const vendorConnections = pgTable("vendor_connections", {
  id: text().primaryKey(),
  vendor: text().$type<Vendor>().notNull(),
  label: text().notNull(),
  status: text().$type<"SAMPLE" | "NOT_CONFIGURED">().notNull(),
  region: text(),
  notes: text().notNull().default(""),
});

/** 장애 등급 커스텀: 장애 코드별로 제조사 등급 매핑 대신 쓸 등급(본사 관리자 설정). 없으면 제조사 등급(Fatal→긴급, Error→높음, Warning→보통, Event→낮음). */
export const severityOverrides = pgTable("severity_overrides", {
  code: text().primaryKey(),
  severity: text().$type<Severity>().notNull(),
  note: text().notNull().default(""),
  updatedBy: text().notNull(),
  updatedAt: isoTimestamp().notNull(),
});

/** 운영 설정(단일 행, id = 'default'). 확정값처럼 하드코딩하지 않는다. */
export const appSettings = pgTable("app_settings", {
  id: text().primaryKey(),
  siteManagerCanConfirmReports: boolean().notNull().default(false),
  commandExpiryMinutes: integer().notNull().default(5),
  commandAcceptedTimeoutSeconds: integer().notNull().default(60),
  staleThresholdMinutes: integer().notNull().default(15),
});

/** 제조사 콜백(Webhook) 원문 보관 + 비동기 처리 상태. 중복 키로 재시도 중복을 막는다. */
export const vendorEvents = pgTable(
  "vendor_events",
  {
    id: text().primaryKey(),
    vendor: text().$type<Vendor>().notNull(),
    eventType: text().notNull(),
    vendorRobotId: text(),
    /** 중복 제거 키(제조사+유형+SN+발생 시각 등). */
    eventKey: text().notNull(),
    receivedAt: isoTimestamp().notNull(),
    occurredAt: isoTimestamp(),
    traceId: text(),
    payload: jsonb().notNull(),
    processedAt: isoTimestamp(),
    processError: text(),
  },
  (t) => [uniqueIndex("vendor_events_key").on(t.vendor, t.eventKey), index("vendor_events_pending_idx").on(t.processedAt, t.receivedAt)],
);

/** 제조사 동기화 작업 상태(마지막 실행·성공·오류·커서). 운영 감시 화면용. */
export const vendorSyncState = pgTable(
  "vendor_sync_state",
  {
    id: text().primaryKey(), // `${vendor}:${job}`
    vendor: text().$type<Vendor>().notNull(),
    job: text().notNull(),
    lastRunAt: isoTimestamp(),
    lastOkAt: isoTimestamp(),
    lastError: text(),
    cursor: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    stats: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  },
);

// ---- 배송로봇(PUDU FlashBot, 에이전트 연동) — 청소 테이블과 분리(docs/23) ----

/** 배송로봇. 에이전트(PUDU SDK 마이크로서비스)의 로봇 목록에서 발견해 등록한다. 청소 로봇 테이블·집계와 섞지 않는다. */
export const deliveryRobots = pgTable("delivery_robots", {
  id: text().primaryKey(), // `DR-<agentRobotId>`
  agentRobotId: text().notNull().unique(),
  groupId: text().notNull().default(""),
  deviceId: text().notNull().default(""),
  /** 배치 사업장. 처음 발견했을 때는 null(관리자가 배송 화면에서 지정). */
  siteId: text().references(() => sites.id),
  name: text().notNull(),
  shopName: text().notNull().default(""),
  active: boolean().notNull().default(true),
  /** 마지막 상태(robotState FREE/BUSY, moveState, chargeStage, robotPower, robotPose). */
  lastState: jsonb().$type<Record<string, unknown> | null>(),
  lastSeenAt: isoTimestamp(),
  /** 지도 목적지 목록(수신자 설정 화면용 캐시). */
  destinations: jsonb().$type<{ name: string; type: string }[]>().notNull().default([]),
  createdAt: isoTimestamp().notNull(),
});

/** 목적지 → 수신자(직원). 같은 사업장·목적지는 한 행. destination '*' 은 그 사업장의 기본 수신자(목적지 행이 없을 때). */
export const deliveryRecipients = pgTable(
  "delivery_recipients",
  {
    id: text().primaryKey(),
    siteId: text()
      .notNull()
      .references(() => sites.id),
    destination: text().notNull(),
    userIds: jsonb().$type<string[]>().notNull().default([]),
    /** 보낼 채널(PUSH·EMAIL·KAKAO). 사용자별로 가능한 채널만 실제로 보낸다. */
    channels: jsonb().$type<("PUSH" | "EMAIL" | "KAKAO")[]>().notNull().default(["PUSH", "EMAIL"]),
    enabled: boolean().notNull().default(true),
    note: text().notNull().default(""),
    updatedBy: text().notNull(),
    updatedAt: isoTimestamp().notNull(),
  },
  (t) => [uniqueIndex("delivery_recipients_site_dest").on(t.siteId, t.destination)],
);

/** 배송 한 구간(트레이 하나의 목적지 하나). 에이전트의 배송 임무 알림으로 만들고 갱신한다. */
export const deliveryLegs = pgTable(
  "delivery_legs",
  {
    id: text().primaryKey(),
    robotId: text()
      .notNull()
      .references(() => deliveryRobots.id),
    siteId: text().references(() => sites.id),
    destination: text().notNull(),
    trayIndex: integer().notNull().default(0),
    /** 우리 시스템이 보낸 임무의 ID(로봇 화면에서 시작한 배송은 없음). */
    taskRef: text(),
    mode: text().notNull().default(""), // General/Direct/Birthday/Special
    source: text().notNull().default(""), // remote/manual
    status: text().$type<"Await" | "OnTheWay" | "Arrived" | "Complete" | "Cancel">().notNull(),
    firstSeenAt: isoTimestamp().notNull(),
    onTheWayAt: isoTimestamp(),
    arrivedAt: isoTimestamp(),
    completedAt: isoTimestamp(),
    cancelledAt: isoTimestamp(),
    completeType: text(),
    estimatedMs: integer(),
    spendMs: integer(),
    lastEventAt: isoTimestamp().notNull(),
    notifiedAt: isoTimestamp(),
    remindedAt: isoTimestamp(),
    /** 알림 결과 요약(수신자 수·채널별 상태). */
    notifyResult: text(),
  },
  (t) => [index("delivery_legs_robot_dest_idx").on(t.robotId, t.destination), index("delivery_legs_arrived_idx").on(t.arrivedAt)],
);

/** 에이전트 알림 원문(notifyDeliveryTask·notifyRobotMoveState 등). msgId 로 중복 제거하고 워커가 비동기로 처리한다. */
export const deliveryEvents = pgTable(
  "delivery_events",
  {
    id: text().primaryKey(),
    msgId: text().notNull().unique(),
    msgType: text().notNull(),
    agentRobotId: text(),
    receivedAt: isoTimestamp().notNull(),
    occurredAt: isoTimestamp(),
    payload: jsonb().notNull(),
    processedAt: isoTimestamp(),
    processError: text(),
  },
  (t) => [index("delivery_events_pending_idx").on(t.processedAt, t.receivedAt)],
);

/** Wide Bot 에서 보낸 배송 지시·호출(docs/23). 트레이별 목적지와 그 배송의 수신자(지정하면 목적지 수신자 대신 이 사람에게 알림). */
export const deliveryOrders = pgTable(
  "delivery_orders",
  {
    id: text().primaryKey(),
    robotId: text()
      .notNull()
      .references(() => deliveryRobots.id),
    siteId: text().references(() => sites.id),
    kind: text().$type<"DELIVERY" | "CALL" | "CANCEL_CALL">().notNull(),
    trays: jsonb().$type<{ destination: string; type?: string; taskRef: string; recipientUserIds: string[] }[]>().notNull().default([]),
    sort: text().notNull().default("fixed"),
    executeTask: boolean().notNull().default(true),
    status: text().$type<"ACCEPTED" | "FAILED">().notNull(),
    message: text().notNull().default(""),
    requestedBy: text().notNull(),
    requestedAt: isoTimestamp().notNull(),
  },
  (t) => [index("delivery_orders_robot_idx").on(t.robotId, t.requestedAt)],
);
