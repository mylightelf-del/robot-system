import type {
  ActualRun,
  AuditLog,
  Command,
  Floor,
  Incident,
  Inspection,
  MaintenanceItem,
  MapVersion,
  NotificationSetting,
  PlannedRun,
  RegisteredTask,
  ReportVersion,
  Robot,
  RobotPlacement,
  RobotStatus,
  Schedule,
  Site,
  User,
  VendorConnection,
  Zone,
} from "@/lib/domain/types";

/**
 * 메모리 저장소 데이터 형태. 1단계 시제품 전용.
 * 2단계에서 PostgreSQL 등 영속 저장소로 교체한다(서비스 계층은 이 형태만 의존).
 */
export interface StoreData {
  seededAt: string;
  sites: Site[];
  floors: Floor[];
  mapVersions: MapVersion[];
  zones: Zone[];
  robots: Robot[];
  placements: RobotPlacement[];
  statuses: Record<string, RobotStatus>;
  tasks: RegisteredTask[];
  schedules: Schedule[];
  plannedRuns: PlannedRun[];
  actualRuns: ActualRun[];
  commands: Command[];
  incidents: Incident[];
  inspections: Inspection[];
  maintenance: Record<string, MaintenanceItem[]>;
  reports: ReportVersion[];
  audit: AuditLog[];
  users: User[];
  notificationSettings: NotificationSetting[];
  vendorConnections: VendorConnection[];
  /** 운영 설정(확정값처럼 하드코딩하지 않고 설정으로 둔다). */
  settings: {
    siteManagerCanConfirmReports: boolean;
    commandExpiryMinutes: number;
    commandAcceptedTimeoutSeconds: number;
  };
}

export function emptyStore(now: string): StoreData {
  return {
    seededAt: now,
    sites: [],
    floors: [],
    mapVersions: [],
    zones: [],
    robots: [],
    placements: [],
    statuses: {},
    tasks: [],
    schedules: [],
    plannedRuns: [],
    actualRuns: [],
    commands: [],
    incidents: [],
    inspections: [],
    maintenance: {},
    reports: [],
    audit: [],
    users: [],
    notificationSettings: [],
    vendorConnections: [],
    settings: {
      siteManagerCanConfirmReports: false,
      commandExpiryMinutes: 5,
      commandAcceptedTimeoutSeconds: 60,
    },
  };
}

/** 실적 중복 제거 키: 제조사 + 제조사 로봇 ID + 제조사 작업 ID */
export function runDedupeKey(run: Pick<ActualRun, "vendorRunId">, robot: Pick<Robot, "vendor" | "vendorRobotId">): string {
  return `${robot.vendor}:${robot.vendorRobotId}:${run.vendorRunId}`;
}

/** 중복이면 false 를 돌려주고 추가하지 않는다. */
export function upsertActualRun(data: StoreData, run: ActualRun): boolean {
  const robot = data.robots.find((r) => r.id === run.robotId);
  if (!robot) return false;
  const key = runDedupeKey(run, robot);
  const exists = data.actualRuns.some((r) => {
    const rb = data.robots.find((x) => x.id === r.robotId);
    return rb ? runDedupeKey(r, rb) === key : false;
  });
  if (exists) return false;
  data.actualRuns.push(run);
  return true;
}
