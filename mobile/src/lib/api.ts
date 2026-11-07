import { apiBase } from "./config";
import type { Command, CommandType, Floor, MapVersion, NotifyChannel, NotifyKind, RobotStatus, Site, Zone, Role, SitePermission, Severity, IncidentStatus, IncidentAction, ActualRun, Inspection, MaintenanceItem, ReportVersion, ReportAggregates, ReportContent, CommonStatus } from "../../../src/lib/domain/types";

/**
 * 서버 `/api/v1` 호출. 토큰은 `Authorization: Bearer` 로 보낸다(쿠키 없음).
 * 오류는 서버의 `{ error: { code, message } }` 를 ApiError 로 바꾼다. 401 이면 호출자(AuthProvider)가 로그아웃 처리한다.
 * 응답 타입은 서버 서비스 계층의 타입을 그대로 가져와(타입 전용 import) 웹과 어긋나지 않게 한다.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let authToken: string | null = null;
let onUnauthorized: (() => void) | null = null;
export function setAuthToken(token: string | null) {
  authToken = token;
}
export function getAuthToken() {
  return authToken;
}
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

export async function api<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown, opts: { auth?: boolean; timeoutMs?: number } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", "X-App": "widebot-android" };
  if (opts.auth !== false && authToken) headers.Authorization = `Bearer ${authToken}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/api/v1${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    throw new ApiError(0, "NETWORK", `서버에 연결할 수 없습니다(${(e as Error).name === "AbortError" ? "시간 초과" : "네트워크 오류"}).`);
  }
  clearTimeout(timer);
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  if (!res.ok) {
    const err = (json.error ?? {}) as { code?: string; message?: string };
    if (res.status === 401 && opts.auth !== false && authToken) onUnauthorized?.();
    throw new ApiError(res.status, err.code ?? "HTTP", err.message ?? `요청이 실패했습니다(HTTP ${res.status}).`);
  }
  return json as T;
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return "처리 중 오류가 발생했습니다.";
  return "알 수 없는 오류";
}

/** 지도 이미지 등 /api/v1 밖의 서버 파일 주소(Bearer 헤더는 호출 측에서 붙인다). */
export function serverUrl(path: string): string {
  return `${apiBase()}${path.startsWith("/") ? path : `/${path}`}`;
}

// ---- 응답 타입(서버 src/lib/services/* 의 반환 타입과 같은 모양) ----
export type { CommandType, CommonStatus, Severity, IncidentStatus, NotifyKind, NotifyChannel, Site, Floor, Zone, MapVersion, RobotStatus, Command, ReportAggregates, ReportContent };

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  sitePermissions: SitePermission[];
}
export interface MeResponse {
  user: PublicUser;
  session: { id: string; kind: "web" | "app"; deviceName: string; createdAt: string; expiresAt: string };
  sites: { id: string; name: string; timezone: string; remoteControlEnabled: boolean; isSample: boolean }[];
  notify: { modes: Record<NotifyChannel, "live" | "mock"> };
}
export interface LoginResponse {
  token: string;
  sessionId: string;
  expiresAt: string;
  user: PublicUser;
}

export interface SiteSummary {
  siteId: string;
  siteName: string;
  robotCount: number;
  byStatus: Record<CommonStatus, number>;
  todayRuns: number;
  todayAreaM2: number;
  todayCompleted: number;
  openIncidents: number;
  unacknowledgedIncidents: number;
  staleRobots: number;
}
export interface WeekKpi {
  runs: number;
  areaM2: number;
  durationMin: number;
  completionRatePct: number | null;
  productivityM2PerHour: number | null;
  incidents: number;
}
export interface DashboardData {
  sites: (SiteSummary & { week: WeekKpi; prevWeek: WeekKpi })[];
  totals: Omit<SiteSummary, "siteId" | "siteName">;
  week: WeekKpi;
  prevWeek: WeekKpi;
  mttrMin30d: number | null;
  staleThresholdMinutes: number;
  now: string;
}
export interface TodoData {
  missedRuns: { id: string; siteId: string; siteName: string; robotId: string; robotName: string; taskName: string; plannedAt: string }[];
  unacknowledgedIncidents: number;
  lowConsumables: { robotId: string; robotName: string; siteName: string; name: string; remainingPct: number }[];
  staleRobots: { robotId: string; robotName: string; siteName: string; lastReceivedAt: string | null }[];
  plannedToday: { total: number; remaining: number };
}

export interface RobotView {
  id: string;
  vendor: string;
  model: string;
  siteId: string;
  floorId: string;
  name: string;
  serial: string;
  firmware: string;
  active: boolean;
  supportedCommands: CommandType[];
  internalNote?: string;
  vendorRobotId?: string;
}
export interface RobotRow {
  robot: RobotView;
  status: RobotStatus;
  site: Site;
  floor: Floor;
}
export interface SiteView {
  site: Site;
  floors: Floor[];
  selectedFloor: Floor;
  map: MapVersion;
  mapVersions: MapVersion[];
  zones: Zone[];
  robots: RobotRow[];
  now: string;
}
export interface IncidentView {
  id: string;
  siteId: string;
  siteName: string;
  robotId: string;
  robotName: string;
  code: string;
  severity: Severity;
  message: string;
  rawMessage: string | null;
  customerMessage: string;
  occurredAt: string;
  occurrences: number;
  lastOccurredAt: string | null;
  status: IncidentStatus;
  acknowledgedAt: string | null;
  assigneeName: string | null;
  resolvedAt: string | null;
  actions: IncidentAction[];
  notifications: { id: string; at: string; channel: NotifyChannel; recipient: string; status: string; reason: string }[];
  minutesOpen: number;
  dismissedAt: string | null;
  dismissReason: string | null;
  revertLabel: string | null;
}
export interface RobotDetail {
  robot: RobotView;
  status: RobotStatus;
  site: Site;
  floor: Floor;
  map: MapVersion | null;
  mapMismatch: boolean;
  zones: Zone[];
  tasks: { id: string; name: string }[];
  runs: ActualRun[];
  incidents: IncidentView[];
  commands: Command[];
  inspections: Inspection[];
  maintenance: MaintenanceItem[];
  allowedCommands: CommandType[];
  isSimulation: boolean;
  now: string;
}
export interface ReportRow extends ReportVersion {
  title: string;
  siteName: string;
  siteIsSample: boolean;
  lateRuns: number;
  isLatestVersion: boolean;
}
export interface Subscription {
  id: string;
  siteId: string;
  siteName: string;
  channel: NotifyChannel;
  minSeverity: Severity;
  hoursFrom: string;
  hoursTo: string;
  kinds: NotifyKind[];
}
export interface SessionRow {
  id: string;
  kind: "web" | "app";
  deviceName: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
  pushDevices: number;
}
export interface InboxItem {
  id: string;
  at: string;
  channel: NotifyChannel;
  status: string;
  kind: NotifyKind;
  refId: string | null;
  incidentId: string | null;
  summary: string;
}
export interface CommandResponse {
  command: Pick<Command, "id" | "type" | "state" | "requestedAt" | "expiresAt" | "stateChangedAt">;
  message: string;
}
