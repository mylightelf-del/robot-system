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
  ReportComments,
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

export const sites = pgTable("sites", {
  id: text().primaryKey(),
  name: text().notNull(),
  timezone: text().notNull(),
  address: text().notNull().default(""),
  isSample: boolean().notNull().default(false),
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
  (t) => [uniqueIndex("commands_idempotency_key").on(t.idempotencyKey), index("commands_robot_idx").on(t.robotId, t.requestedAt)],
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
  },
  (t) => [uniqueIndex("incidents_vendor_event_key").on(t.vendorEventId), index("incidents_site_idx").on(t.siteId, t.occurredAt)],
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
  status: text().$type<"MOCK_SENT" | "SUPPRESSED" | "FAILED">().notNull(),
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
    month: text().notNull(),
    version: integer().notNull(),
    status: text().$type<ReportStatus>().notNull(),
    aggregates: jsonb().$type<ReportAggregates>().notNull(),
    comments: jsonb().$type<ReportComments>().notNull(),
    createdAt: isoTimestamp().notNull(),
    createdBy: text().notNull(),
    reviewedAt: isoTimestamp(),
    reviewedBy: text(),
    confirmedAt: isoTimestamp(),
    confirmedBy: text(),
    publishedAt: isoTimestamp(),
  },
  (t) => [uniqueIndex("report_versions_site_month_version").on(t.siteId, t.month, t.version)],
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
