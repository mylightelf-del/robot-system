import { signCenobots, type CenobotsConfig, type CenobotsTransport } from "./client";
import type { CzDeviceStatus, CzMission, CzSchedule, CzSystemError } from "./api";

/**
 * CENOBOTS mock 모드 전송 계층(키 없이 개발·시험). 실제 서버처럼 서명을 검사하고, 문서(V1.0.18) 응답 형식 그대로 픽스처를 돌려준다.
 * 화면·로그에 "모의" 임을 표시한다. 픽스처의 deviceOpenId 는 MOCK 로 시작해 실제 값과 섞이지 않는다.
 * 운영(APP_ENV=production)에서는 워커가 mock 응답을 DB 에 적재하지 않는다(dry-run) — src/worker/cenobots.ts.
 */
export const MOCK_HOST = "mock://cenobots";
export const MOCK_ACCESS_KEY = "mock-access-key";
export const MOCK_SECRET_KEY = "mock-secret-key";

export const MOCK_DEVICES = [
  { licensePlate: "L4-05408", deviceOpenId: "MOCK05408A", serialNumber: "E250918008A", remark: "포스코센터 2호기 (지하2층 전용)", mapName: "POSCO B2F" },
  { licensePlate: "L4-05590", deviceOpenId: "MOCK05590A", serialNumber: "E260227010A", remark: "포스코센터 1호기", mapName: "POSCO B3F" },
  // 허용 목록 밖 장비(같은 회사 다른 고객사 로봇이라고 가정) — 조회·적재되면 안 된다
  { licensePlate: "L4-09999", deviceOpenId: "MOCK09999X", serialNumber: "E000000000X", remark: "다른 고객사", mapName: "OTHER" },
];

/** 시험에서 바꿀 수 있는 상태 */
export const mockState = {
  requests: [] as { method: string; path: string }[],
  /** deviceOpenId → 현재 활성 오류 */
  errors: { MOCK05590A: [{ code: 703903, name: "Charging Failed", description: "Charging Failed: Outbound adjustment failed in precise recharge operation" }] } as Record<string, CzSystemError[]>,
  /** 서명 검사 실패를 흉내(시계 어긋남 시험) */
  failSignature: false,
  /** 첫 N번 요청을 503 으로(재시도 시험) */
  fail503: 0,
  /** 고정 현재 시각(ms). null 이면 실제 시각 */
  nowMs: null as number | null,
  /** 추가 작업 이력(시험용) */
  extraMissions: {} as Record<string, CzMission[]>,
};

export function mockConfig(allowed: string[]): CenobotsConfig {
  return { host: MOCK_HOST, accessKey: MOCK_ACCESS_KEY, secretKey: MOCK_SECRET_KEY, allowed: allowed.length ? allowed : MOCK_DEVICES.slice(0, 2).map((d) => d.licensePlate), timeoutMs: 1000, minIntervalMs: 0, maxRetries: 2 };
}

const KST = 9 * 3600_000;
const now = () => mockState.nowMs ?? Date.now();

/** 기기별 일일 작업(KST 기준): 05408 은 05:30·13:00, 05590 은 22:00. 7일에 한 번 STOP, 5일에 한 번 ABEND. */
export function mockMissions(openId: string, startMs: number, endMs: number): CzMission[] {
  const out: CzMission[] = [];
  const slots = openId === "MOCK05408A" ? [[5, 30, 70], [13, 0, 45]] : openId === "MOCK05590A" ? [[22, 0, 95]] : [[9, 0, 30]];
  const dayStart = (ms: number) => Math.floor((ms + KST) / 86400_000) * 86400_000 - KST;
  for (let d = dayStart(startMs) - 86400_000; d <= endMs; d += 86400_000) {
    const dayNo = Math.floor((d + KST) / 86400_000);
    slots.forEach(([h, m, minutes], k) => {
      const s = d + h * 3600_000 + m * 60_000;
      const e = s + minutes * 60_000;
      if (s < startMs || s > endMs || e > now()) return;
      const status = dayNo % 7 === 0 && k === 0 ? "STOP" : dayNo % 5 === 0 && k === slots.length - 1 ? "ABEND" : "DONE";
      out.push({
        missionId: `${openId}-${dayNo}-${k}`,
        startTimeStamp: s,
        endTimeStamp: e,
        status,
        totalTime: minutes,
        duration: minutes * 60,
        cleanedArea: status === "DONE" ? 820 + ((dayNo * 37 + k * 11) % 160) : 300,
        coverage: status === "DONE" ? "96%" : "41%",
        water: 18.5,
        cleaningSolution: 120,
        sceneName: MOCK_DEVICES.find((x) => x.deviceOpenId === openId)?.mapName ?? "",
        taskSourceTypeEnum: k === 0 ? "APP_TIMING" : "PAD_TEMP",
        taskEndReasonEnum: status === "DONE" ? "LAPS_REACHED" : status === "STOP" ? "PAD_MANUAL" : "SYSTEM_ABEND",
        abendSubReasonEnum: status === "ABEND" ? "HIGH_AIR_PRESSURE" : undefined,
        errDesc: status === "ABEND" ? "Air pressure too high" : undefined,
        startBattery: 96,
        endBattery: 61,
      });
    });
  }
  return [...out, ...(mockState.extraMissions[openId] ?? []).filter((m) => m.startTimeStamp >= startMs && m.startTimeStamp <= endMs)].sort((a, b) => b.startTimeStamp - a.startTimeStamp);
}

function deviceStatus(openId: string): CzDeviceStatus {
  const dev = MOCK_DEVICES.find((d) => d.deviceOpenId === openId)!;
  const kstHour = new Date(now() + KST).getUTCHours();
  const cleaning = openId === "MOCK05408A" ? (kstHour >= 5 && kstHour < 7) || (kstHour >= 13 && kstHour < 14) : kstHour >= 22 || kstHour < 1;
  return {
    online: true,
    soc: cleaning ? 64 : 98,
    running: cleaning,
    charging: !cleaning,
    chargingMode: "AUTO",
    currentMapName: dev.mapName,
    currentMapVersion: `map.mock.${dev.mapName.replace(/\s/g, "")}.v1`,
    currentMapId: 1000 + Number(openId.replace(/\D/g, "").slice(0, 4)),
    vehicleTime: new Date(now()).toISOString(),
    licensePlate: dev.licensePlate,
    remark: dev.remark,
    isEmergency: false,
    isManual: false,
    pose: { x: 12.5, y: -3.2, yaw: 1.57 },
    dirtyBox: [20],
    waterBox: [70],
    dockingStationDetail: { isDocked: !cleaning, type: "CWS_01", dirtyWaterStatus: "IDLE", cleanWaterStatus: "IDLE" },
    missionTaskDetail: cleaning ? { currentMissionId: `${openId}-live`, sweepMode: "Sweep", taskStatus: "ON_GOING", taskProgress: 0.42, cleanedAreaSize: 350, remainingAreaSize: 480, remainingTime: 1800 } : { sweepMode: "NoTask", taskStatus: "READY" },
  };
}

const SCHEDULES: Record<string, CzSchedule[]> = {
  MOCK05408A: [
    { id: 11, startTime: "05:30 am", endTime: "06:40 am", executionDays: ["Mon.", "Tue.", "Wed.", "Thur.", "Fri.", "Sat."], cleanEveryWhere: true, enable: true, sweepMode: "SWEEP", duration: 70 },
    { id: 12, startTime: "01:00 PM", endTime: "01:45 PM", executionDays: ["Mon.", "Wed.", "Fri."], cleanEveryWhere: false, areas: [{ id: "a1", name: "주차 통로" }], enable: true, sweepMode: "SWEEP", duration: 45 },
  ],
  MOCK05590A: [{ id: 21, startTime: "10:00 pm", endTime: "11:35 pm", executionDays: ["Mon.", "Tue.", "Wed.", "Thur.", "Fri."], cleanEveryWhere: true, enable: true, sweepMode: "SWEEP", duration: 95 }],
};

function ok(data: unknown) {
  return { status: 200, text: JSON.stringify({ data, success: true, code: 0, info: "", rid: `mock-${Math.random().toString(36).slice(2, 10)}` }) };
}
function fail(status: number, code: number, info: string) {
  return { status, text: JSON.stringify({ data: null, success: false, code, info, rid: "mock-fail" }) };
}

export const mockTransport: CenobotsTransport = {
  async send(req) {
    const [pathOnly, qs] = req.path.split("?");
    mockState.requests.push({ method: req.method, path: pathOnly });
    if (mockState.fail503 > 0) {
      mockState.fail503 -= 1;
      return { status: 503, text: "Service Unavailable" };
    }
    // 서명 검사(실서버와 같은 규칙: 쿼리 제외 경로)
    const ts = req.headers["X-Api-timestamp"];
    const expected = signCenobots(MOCK_SECRET_KEY, req.method, ts, pathOnly);
    if (req.headers["X-Api-Key"] !== MOCK_ACCESS_KEY || req.headers["X-Api-signature"] !== expected || mockState.failSignature) return fail(401, 401, "signature invalid or timestamp expired");
    if (Math.abs(Number(ts) - Date.now()) > 5 * 60_000) return fail(401, 401, "timestamp expired");
    // 쓰기 경로가 오면 시험이 잡을 수 있게 실패
    if (req.method !== "GET" && !/\/mission\/(list|summary)$/.test(pathOnly)) return fail(400, 400, "mock: write api not allowed in read-only integration");
    const q = new URLSearchParams(qs ?? "");
    const id = (re: RegExp) => pathOnly.match(re)?.[1] ?? "";
    const known = (openId: string) => MOCK_DEVICES.some((d) => d.deviceOpenId === openId);
    if (pathOnly === "/app/openapi/v1/device/deviceOpenIds") return ok(MOCK_DEVICES.map(({ licensePlate, deviceOpenId }) => ({ licensePlate, deviceOpenId })));
    let m: string;
    if ((m = id(/^\/app\/openapi\/v1\/device\/status\/([^/]+)$/))) return known(m) ? ok(deviceStatus(m)) : fail(200, 404, "device not found");
    if ((m = id(/^\/app\/openapi\/v1\/device\/info\/([^/]+)$/))) {
      const d = MOCK_DEVICES.find((x) => x.deviceOpenId === m);
      return d ? ok({ licensePlate: d.licensePlate, remark: d.remark, buildingName: "포스코센터", serialNumber: d.serialNumber, softwareVersion: "mock-1.0.0", activated: true, activateTimestamp: 1758153600000 }) : fail(200, 404, "device not found");
    }
    if ((m = id(/^\/app\/openapi\/v1\/device\/maintenance-detail\/([^/]+)$/)))
      return ok({ maintenanceItems: [{ name: "Squeegee Blade", life: 150, overDueHours: 2, remainPercent: "0%" }, { name: "Detergent", life: 480, remainHours: 300, remainPercent: "63%" }, { name: "Disc Brush", life: 600, remainHours: 540, remainPercent: "90%" }] });
    if ((m = id(/^\/app\/openapi\/v1\/device\/([^/]+)\/sys-error\/list$/))) return ok(mockState.errors[m] ?? []);
    if ((m = id(/^\/app\/openapi\/v1\/schedule\/list\/([^/]+)$/))) return ok(SCHEDULES[m] ?? []);
    if (pathOnly === "/app/openapi/v1/map") {
      const d = MOCK_DEVICES.find((x) => x.deviceOpenId === q.get("deviceOpenId"));
      return ok(d ? [{ mapName: d.mapName, mapId: 1, mapVersion: `map.mock.${d.mapName.replace(/\s/g, "")}.v1`, inUse: true, valid: true }] : []);
    }
    if (pathOnly === "/app/openapi/v1/mission/list") {
      const body = JSON.parse(req.body ?? "{}") as { pageIndex: number; pageLength: number; requestData: { deviceOpenId: string; startTimestamp: number; endTimestamp?: number } };
      const all = mockMissions(body.requestData.deviceOpenId, Number(body.requestData.startTimestamp), Number(body.requestData.endTimestamp ?? now()));
      const len = body.pageLength || 10;
      const idx = Math.max(0, (body.pageIndex ?? 1) - 1); // mock 은 1부터(Java 예제)
      return ok({ data: all.slice(idx * len, idx * len + len), pageIndex: body.pageIndex, pageLength: len, totalCnt: all.length });
    }
    return fail(404, 404, `mock: unknown path ${pathOnly}`);
  },
};
