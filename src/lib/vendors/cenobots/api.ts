import type { CenobotsClient } from "./client";

/** 문서(V1.0.18) 기준 응답 형식. 문서에 없는 필드는 무시한다(전방 호환). */
export interface CzDeviceOpenId {
  licensePlate: string;
  deviceOpenId: string;
}

export interface CzPose {
  x: number;
  y: number;
  yaw: number;
}

export interface CzDeviceStatus {
  online: boolean;
  soc: number | null;
  running: boolean;
  charging: boolean;
  chargingMode?: string;
  currentMapVersion?: string;
  currentMapId?: number;
  currentMapName?: string;
  vehicleTime?: string;
  licensePlate?: string;
  remark?: string;
  isEmergency?: boolean;
  isManual?: boolean;
  pose?: CzPose | null;
  dirtyBox?: number[];
  waterBox?: number[];
  dockingStationDetail?: { isDocked?: boolean; type?: string; dirtyWaterStatus?: string; cleanWaterStatus?: string } | null;
  missionTaskDetail?: {
    currentMissionId?: string;
    sweepMode?: string;
    taskStatus?: string;
    taskProgress?: number;
    cleanedAreaSize?: number;
    remainingAreaSize?: number;
    remainingTime?: number;
    currentLap?: number;
    currentAreaIds?: string[];
  } | null;
}

export interface CzDeviceInfo {
  licensePlate?: string;
  remark?: string;
  buildingName?: string;
  serialNumber?: string;
  softwareVersion?: string;
  activated?: boolean;
  activateTimestamp?: number;
}

export interface CzMaintenanceItem {
  name: string;
  remainPercent?: string;
  remainHours?: number;
  overDueHours?: number;
  life?: number;
  history?: { resetTimestamp?: number; resetTime?: string; user?: string; source?: string }[];
}

export interface CzSystemError {
  code: number;
  name: string;
  description: string;
}

export interface CzMission {
  id?: number;
  missionId: string;
  startTime?: string;
  startTimeStamp: number;
  endTime?: string;
  endTimeStamp?: number;
  duration?: number;
  status: string;
  errDesc?: string;
  taskSummaryPictureUrl?: string;
  totalTime?: number;
  cleanedArea?: number;
  coverage?: string | number;
  cleaningTime?: number;
  chargingTime?: number;
  pauseTime?: number;
  sceneName?: string;
  mapVersion?: string;
  mapId?: number;
  areaList?: { id: string; name: string; type?: string }[];
  sweepType?: string;
  fixedLaps?: number;
  deviceType?: string;
  water?: number;
  cleaningSolution?: number;
  startBattery?: number;
  endBattery?: number;
  taskSourceTypeEnum?: string;
  taskEndReasonEnum?: string;
  abendSubReasonEnum?: string;
  cumulativeDistance?: number;
  meanVel?: number;
}

export interface CzMissionPage {
  data: CzMission[];
  pageIndex: number;
  pageLength: number;
  totalCnt: number;
}

export interface CzSchedule {
  id: number;
  duration?: number;
  executionDays?: string[];
  startTime: string; // "10:40 am"
  endTime?: string;
  mapId?: number;
  areas?: { id: string; name: string; type?: string }[];
  sweepMode?: string;
  subSweepMode?: string;
  cleanEveryWhere?: boolean;
  enable: boolean;
  fixedLaps?: number;
}

export interface CzMapInfo {
  mapName: string;
  mapId: number;
  mapVersion: string;
  inUse: boolean;
  valid: boolean;
}

const P = "/app/openapi/v1";

/** 조회 전용 API 묶음. 명령·예약 변경·설정 변경 엔드포인트는 일부러 만들지 않는다. */
export class CenobotsApi {
  constructor(private readonly client: CenobotsClient) {}

  get host(): string {
    return this.client.host;
  }

  /** 장비 목록(번호판 ↔ deviceOpenId). 연결 확인 겸 로봇 조회. */
  listDevices(): Promise<CzDeviceOpenId[]> {
    return this.client.get<CzDeviceOpenId[]>(`${P}/device/deviceOpenIds`).then((d) => d ?? []);
  }
  status(openId: string): Promise<CzDeviceStatus> {
    return this.client.get<CzDeviceStatus>(`${P}/device/status/${encodeURIComponent(openId)}`);
  }
  info(openId: string): Promise<CzDeviceInfo> {
    return this.client.get<CzDeviceInfo>(`${P}/device/info/${encodeURIComponent(openId)}`);
  }
  maintenance(openId: string): Promise<{ maintenanceItems?: CzMaintenanceItem[] }> {
    return this.client.get<{ maintenanceItems?: CzMaintenanceItem[] }>(`${P}/device/maintenance-detail/${encodeURIComponent(openId)}`).then((d) => d ?? {});
  }
  systemErrors(openId: string): Promise<CzSystemError[]> {
    return this.client.get<CzSystemError[]>(`${P}/device/${encodeURIComponent(openId)}/sys-error/list`).then((d) => d ?? []);
  }
  schedules(openId: string): Promise<CzSchedule[]> {
    return this.client.get<CzSchedule[]>(`${P}/schedule/list/${encodeURIComponent(openId)}`).then((d) => d ?? []);
  }
  maps(openId: string): Promise<CzMapInfo[]> {
    return this.client.get<CzMapInfo[]>(`${P}/map`, { deviceOpenId: openId }).then((d) => d ?? []);
  }
  /** 작업 이력 한 페이지(조회용 POST). startTimestamp·endTimestamp 는 ms. */
  missions(req: { deviceOpenId: string; startTimestamp: number; endTimestamp: number; pageIndex: number; pageLength: number }): Promise<CzMissionPage> {
    return this.client
      .postQuery<CzMissionPage>(`${P}/mission/list`, {
        pageIndex: req.pageIndex,
        pageLength: req.pageLength,
        requestData: { deviceOpenId: req.deviceOpenId, startTimestamp: req.startTimestamp, endTimestamp: req.endTimestamp, isShowNavigationMission: false },
      })
      .then((d) => d ?? { data: [], pageIndex: req.pageIndex, pageLength: req.pageLength, totalCnt: 0 });
  }
}

/** 페이지 시작 번호. 문서 예제가 0(본문)·1(Java)로 엇갈려 설정으로 둔다(실호출로 확정). */
export function pageIndexBase(): number {
  return process.env.CENOBOTS_PAGE_INDEX_BASE === "0" ? 0 : 1;
}

/** 기간 안의 작업 이력 전체(missionId 중복 제거, 최대 maxPages). */
export async function allMissions(api: CenobotsApi, openId: string, startMs: number, endMs: number, pageLength = 50, maxPages = 40): Promise<CzMission[]> {
  const seen = new Map<string, CzMission>();
  const base = pageIndexBase();
  for (let i = 0; i < maxPages; i++) {
    const page = await api.missions({ deviceOpenId: openId, startTimestamp: startMs, endTimestamp: endMs, pageIndex: base + i, pageLength });
    const list = page.data ?? [];
    let fresh = 0;
    for (const m of list) {
      if (!m?.missionId || seen.has(m.missionId)) continue;
      seen.set(m.missionId, m);
      fresh += 1;
    }
    if (list.length < pageLength || fresh === 0 || (page.totalCnt && seen.size >= page.totalCnt)) break;
  }
  return Array.from(seen.values());
}
