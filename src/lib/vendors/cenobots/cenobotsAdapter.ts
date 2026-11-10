import type { ActualRun, MaintenanceItem, Robot, RobotStatus } from "@/lib/domain/types";
import type { SendResult, VendorAdapter } from "@/lib/vendors/adapter";
import { AppError } from "@/lib/util/errors";
import { nowIso } from "@/lib/util/time";
import { CenobotsApi, allMissions } from "./api";
import { CenobotsClient, configFromEnv, parseList, type CenobotsConfig } from "./client";
import { mapDeviceStatus, mapMissionToRun, maintenanceRemainingPct, MAINTENANCE_NAME_KO } from "./mapping";
import { mockConfig, mockTransport } from "./mock";

/**
 * CZ Robots(CenoBots) Open API 어댑터 — **조회 전용**(요청 범위, docs/22).
 * - sendCommand: 외부 호출 없이 항상 거부. 명령 서비스도 단계 0 에서 막는다(이중 차단).
 * - fetchStatus / fetchRuns / fetchMaintenance: 조회 API 만 사용.
 * 키·호스트는 환경변수에서만 읽는다. CENOBOTS_MODE=mock 이면 내부 픽스처(키 불필요).
 */
export function cenobotsSettings(): { mode: "mock" | "live"; cfg: CenobotsConfig } | null {
  if (process.env.CENOBOTS_MODE === "unconfigured") return null;
  if (process.env.CENOBOTS_MODE === "mock") return { mode: "mock", cfg: mockConfig(parseList(process.env.CENOBOTS_ALLOWED_DEVICE_OPEN_IDS)) };
  const cfg = configFromEnv();
  return cfg ? { mode: "live", cfg } : null;
}

export function createCenobotsApi(): CenobotsApi {
  const s = cenobotsSettings();
  if (!s) throw new AppError("CENOBOTS 연결이 설정되지 않았습니다(CENOBOTS_MODE·CENOBOTS_HOST·CENOBOTS_ACCESS_KEY·CENOBOTS_SECRET_KEY·CENOBOTS_ALLOWED_DEVICE_OPEN_IDS).", "UNSUPPORTED");
  return new CenobotsApi(new CenobotsClient(s.cfg, s.mode === "mock" ? mockTransport : undefined));
}

/** 허용 목록(deviceOpenId 또는 번호판). */
export function isAllowedDevice(d: { deviceOpenId: string; licensePlate?: string }, allowed: string[]): boolean {
  return allowed.includes(d.deviceOpenId) || (!!d.licensePlate && allowed.includes(d.licensePlate));
}

export function openIdOf(robot: Pick<Robot, "vendorMeta">): string | null {
  const v = robot.vendorMeta?.deviceOpenId;
  return typeof v === "string" && v ? v : null;
}

export class CenobotsAdapter implements VendorAdapter {
  readonly vendor = "CENOBOTS" as const;
  readonly isSimulation = false;
  private readonly api: CenobotsApi;

  constructor(api?: CenobotsApi) {
    this.api = api ?? createCenobotsApi();
  }

  async sendCommand(): Promise<SendResult> {
    return { outcome: "REJECTED", vendorTraceId: null, message: "CENOBOTS 연동은 조회 전용입니다. 로봇에 명령을 보내지 않습니다." };
  }

  async fetchStatus(robot: Robot): Promise<RobotStatus | null> {
    const openId = openIdOf(robot);
    if (!openId) return null;
    const receivedAt = nowIso();
    const s = await this.api.status(openId);
    const m = mapDeviceStatus(s);
    const pos = s.pose ? ` pos=(${s.pose.x.toFixed(1)}, ${s.pose.y.toFixed(1)})m map=${s.currentMapName ?? "-"}` : "";
    return {
      robotId: robot.id,
      common: m.common,
      raw: `${m.raw}${pos}`,
      online: !!s.online,
      batteryPct: typeof s.soc === "number" ? s.soc : null,
      // 층 지도(제조사 지도·모서리 좌표) 가져오기 전에는 위치를 그리지 않는다(미터를 px 로 오인하지 않도록). 원시값에 좌표만 남긴다.
      pose: null,
      poseIsLastKnown: true,
      mapVersionId: null,
      currentMissionId: m.missionId,
      progressPct: m.progressPct,
      lastReceivedAt: receivedAt,
      dataAt: receivedAt,
    };
  }

  async fetchRuns(robot: Robot, fromIso: string, toIso: string): Promise<ActualRun[]> {
    const openId = openIdOf(robot);
    if (!openId) return [];
    const list = await allMissions(this.api, openId, new Date(fromIso).getTime(), new Date(toIso).getTime());
    const at = nowIso();
    return list.map((x) => mapMissionToRun(x, { id: robot.id, siteId: robot.siteId, floorId: robot.floorId, openId }, at)?.run).filter((r): r is ActualRun => !!r);
  }

  async fetchMaintenance(robot: Robot): Promise<MaintenanceItem[]> {
    const openId = openIdOf(robot);
    if (!openId) return [];
    const d = await this.api.maintenance(openId);
    return (d.maintenanceItems ?? []).map((i) => ({ name: `${MAINTENANCE_NAME_KO[i.name] ?? i.name} 잔여 수명`, remainingPct: maintenanceRemainingPct(i), source: "API" as const }));
  }
}
