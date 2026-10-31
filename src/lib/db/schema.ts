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
  },
  (t) => [
    // 실적 중복 제거 키: 제조사 + 제조사 로봇 ID + 제조사 작업 ID
    uniqueIndex("actual_runs_dedupe_key").on(t.vendor, t.vendorRobotId, t.vendorRunId),
    index("actual_runs_site_started_idx").on(t.siteId, t.startedAt),
    index("actual_runs_robot_started_idx").on(t.robotId, t.startedAt),
  ],
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
  incidentId: text()
    .notNull()
    .references(() => incidents.id),
  at: isoTimestamp().notNull(),
  channel: text().$type<"EMAIL" | "KAKAO">().notNull(),
  recipient: text().notNull(),
  status: text().$type<"SENT" | "MOCK_SENT" | "SUPPRESSED" | "FAILED">().notNull(),
  reason: text().notNull().default(""),
});

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
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
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
});

export const notificationRecipients = pgTable("notification_recipients", {
  id: text().primaryKey(),
  siteId: text()
    .notNull()
    .references(() => sites.id),
  channel: text().$type<"EMAIL" | "KAKAO">().notNull(),
  address: text().notNull(),
  minSeverity: text().$type<Severity>().notNull(),
  hoursFrom: text().notNull().default("00:00"),
  hoursTo: text().notNull().default("23:59"),
});

export const vendorConnections = pgTable("vendor_connections", {
  id: text().primaryKey(),
  vendor: text().$type<Vendor>().notNull(),
  label: text().notNull(),
  status: text().$type<"SAMPLE" | "NOT_CONFIGURED">().notNull(),
  region: text(),
  notes: text().notNull().default(""),
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
