import { BibClient, bibConfigFromEnv } from "./client";

/** 가이드 v0.1 의 조회 응답 형식(실기 확인 2026-11-26: 계정에 J40 2대). */
export interface BibRobot {
  robotId: string;
  handle1: string; // 실기: 로봇 일련번호(J40-…)
  name: string;
  availableActionList: string[];
}
export interface BibStatus {
  robotId: string;
  online: boolean | null;
  batteryPercent: number | null;
  movingStatus: "MOVING" | "STOPPED" | "UNKNOWN" | string;
  activityState: "IDLE" | "WORKING" | "PAUSED" | "BUSY" | "UNKNOWN" | string;
  actionReadinessList?: { action: string; state: string; reason: string | null }[];
  timeObserved: string | null;
  timeReceived: string;
  freshness: "FRESH" | "STALE" | "UNKNOWN" | string;
}
export interface BibCurrentTask {
  supported: boolean;
  task: { taskId: string; state: string } | null;
}
export interface BibTask {
  taskId: string;
  name: string | null;
}
export interface BibMapList {
  robotId: string;
  activeMapHandle: string | null;
  localMapList: { mapHandle: string; name: string | null }[];
}
export interface BibPosition {
  robotId: string;
  mapHandle: string;
  localMapPosition: { x: number; y: number; frame: string; unit: string; originX: number; originY: number };
}

export class BibApi {
  constructor(readonly client: BibClient) {}
  async listRobots(): Promise<BibRobot[]> {
    const out: BibRobot[] = [];
    for (let offset = 0; offset < 10_000; offset += 100) {
      const r = await this.client.get<{ robotListCountTotal: number; robotList: BibRobot[] }>("/partner/v1/robot/list", { offset, limit: 100 });
      out.push(...(r.robotList ?? []));
      if (!r.robotList?.length || offset + r.robotList.length >= (r.robotListCountTotal ?? 0)) break;
    }
    return out;
  }
  status(robotId: string) {
    return this.client.get<BibStatus>(`/partner/v1/robot/${encodeURIComponent(robotId)}/status`);
  }
  currentTask(robotId: string) {
    return this.client.get<BibCurrentTask>(`/partner/v1/robot/${encodeURIComponent(robotId)}/task/current`);
  }
  async tasks(robotId: string): Promise<BibTask[]> {
    return (await this.client.get<{ taskList: BibTask[] }>(`/partner/v1/robot/${encodeURIComponent(robotId)}/task/list`)).taskList ?? [];
  }
  maps(robotId: string) {
    return this.client.get<BibMapList>(`/partner/v1/robot/${encodeURIComponent(robotId)}/localmap/list`);
  }
  position(robotId: string) {
    return this.client.get<BibPosition>(`/partner/v1/robot/${encodeURIComponent(robotId)}/position`);
  }
}

let shared: BibApi | null = null;
/** 프로세스 안에서 토큰을 재사용하도록 한 개만 만든다(가이드: 매 요청 로그인 금지). */
export function createBibApi(): BibApi {
  if (shared) return shared;
  const cfg = bibConfigFromEnv();
  if (!cfg) throw new Error("BIB 연결이 설정되지 않았습니다(BIB_API_BASE_URL·BIB_LOGIN_ID·BIB_PRIVATE_KEY_B64).");
  shared = new BibApi(new BibClient(cfg));
  return shared;
}
export function resetBibApiForTest(): void {
  shared = null;
}
