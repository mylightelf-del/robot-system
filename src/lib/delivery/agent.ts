/**
 * PUDU 배송로봇 에이전트(SDK 마이크로서비스) 클라이언트. 이 AgentClient 는 조회 전용이고, 배송 지시는 아래 AgentCommander 가 따로 맡는다.
 * 문서: Google Drive PUDU/FLASHBOT/정의서(PUDU_Interface.pdf, PUDU_API정의서.pdf) 요약은 docs/23.
 * - 에이전트는 우리 서버 내부(docker 네트워크)에서 9050 포트로 돈다. 에이전트 API 에는 인증이 없으므로 외부에 절대 노출하지 않는다.
 * - 에이전트가 장치 ID·비밀키로 PUDU 클라우드에 접속한다. 비밀키는 에이전트 등록 스크립트만 쓰고(서버 .env), 여기서는 장치 ID 만 쓴다.
 * - 호출·배송 지시·조작 명령(/api/robot/call, cancel/call, delivery/task, custom/call, action)은 보내지 않는다(허용 목록 밖은 요청 전에 거부).
 * 응답 봉투: { code: "0"|0, msg, data }.
 */

export type AgentMode = "unconfigured" | "mock" | "live";

export function agentMode(): AgentMode {
  const m = process.env.PUDU_AGENT_MODE;
  if (m === "mock") return "mock";
  if (m === "live" && process.env.PUDU_AGENT_URL && process.env.PUDU_AGENT_DEVICE_ID) return "live";
  return "unconfigured";
}

/** 조회·설정용으로 허용한 경로. 설정용 POST 2개(장치 추가·알림 주소 등록)는 에이전트 자체 설정이며 로봇에는 아무것도 보내지 않는다. */
const ALLOWED: Record<string, "GET" | "POST"> = {
  "/api/devices": "GET",
  "/api/robot/groups": "GET",
  "/api/robots": "GET",
  "/api/robot/state": "GET",
  "/api/robot/status": "GET",
  "/api/destinations": "GET",
  "/api/robot/map": "GET",
  "/api/add/device": "POST",
  "/api/notify/url": "POST",
};

export class AgentError extends Error {
  constructor(
    message: string,
    public readonly code: string | null,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

/** PUDU 클라우드 상태 코드(문서) */
export const AGENT_CODES: Record<string, string> = {
  "10001": "외부 인터넷 요청 실패",
  "10002": "외부 인터넷 요청 오류",
  "10003": "설비(장치) 부족",
  "10004": "로봇이 PUDU 클라우드에 연결되어 있지 않음",
  "10005": "파라미터 오류",
};

export interface AgentTransport {
  send(req: { method: "GET" | "POST"; path: string; query: Record<string, string>; body?: unknown }): Promise<{ status: number; json: unknown }>;
}

export function httpTransport(baseUrl: string, timeoutMs = 15000): AgentTransport {
  return {
    async send(req) {
      const qs = new URLSearchParams(req.query).toString();
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}${req.path}${qs ? `?${qs}` : ""}`, {
        method: req.method,
        headers: req.body ? { "Content-Type": "application/json" } : undefined,
        body: req.body ? JSON.stringify(req.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, json };
    },
  };
}

export interface AgentRobot {
  id: string;
  name: string;
  shop_name?: string;
}
export interface AgentRobotState {
  robotId: string;
  robotState?: string; // FREE | BUSY
  moveState?: string;
  chargeStage?: string;
  robotPower?: number;
  robotPose?: { x: number; y: number; angle: number };
}

export class AgentClient {
  constructor(
    private readonly transport: AgentTransport,
    readonly deviceId: string,
  ) {}

  private async call<T>(method: "GET" | "POST", path: string, query: Record<string, string> = {}, body?: unknown): Promise<T> {
    if (ALLOWED[path] !== method) throw new AgentError(`조회 전용 연동: 허용되지 않은 에이전트 경로(${method} ${path})는 보내지 않습니다.`, null);
    let res: { status: number; json: unknown };
    try {
      res = await this.transport.send({ method, path, query, body });
    } catch (e) {
      throw new AgentError(`에이전트 연결 실패(${path}): ${(e as Error).message}`, null);
    }
    const env = (res.json ?? {}) as { code?: unknown; msg?: unknown; mag?: unknown; data?: unknown };
    const code = env.code === undefined || env.code === null ? null : String(env.code);
    if (res.status !== 200 || (code !== null && code !== "0")) {
      const msg = String(env.msg ?? env.mag ?? "");
      throw new AgentError(`에이전트 ${path} 실패: HTTP ${res.status}${code ? ` code ${code}${AGENT_CODES[code] ? `(${AGENT_CODES[code]})` : ""}` : ""}${msg ? ` ${msg}` : ""}`, code);
    }
    return env.data as T;
  }

  devices() {
    return this.call<{ devices?: { name: string; deviceId: string; region: string }[] }>("GET", "/api/devices").then((d) => d?.devices ?? []);
  }
  /** 장치에 묶인 로봇 그룹(매장당 기본 1개). 응답 형식이 문서에 없어 배열·객체 둘 다 받는다. */
  async groups(): Promise<{ id: string; name: string; shop_name?: string }[]> {
    const d = await this.call<unknown>("GET", "/api/robot/groups", { device: this.deviceId });
    const arr = Array.isArray(d) ? d : ((d as { groups?: unknown[]; robotGroups?: unknown[] })?.groups ?? (d as { robotGroups?: unknown[] })?.robotGroups ?? []);
    return (arr as Record<string, unknown>[]).map((g) => ({ id: String(g.id ?? g.group_id ?? g.groupId ?? ""), name: String(g.name ?? g.group_name ?? ""), shop_name: g.shop_name ? String(g.shop_name) : undefined })).filter((g) => g.id);
  }
  robots(groupId: string) {
    return this.call<{ robots?: AgentRobot[] }>("GET", "/api/robots", { device: this.deviceId, group_id: groupId }).then((d) => d?.robots ?? []);
  }
  /** 그룹 로봇 상태(에이전트가 timeout 초 동안 응답을 모아 돌려준다). 오프라인 로봇은 빠진다. */
  groupState(groupId: string, timeoutSec = 3, count = 10) {
    return this.call<{ state?: AgentRobotState[] }>("GET", "/api/robot/state", { device_id: this.deviceId, group_id: groupId, timeout: String(timeoutSec), count: String(count) }).then((d) => d?.state ?? []);
  }
  async destinations(robotId: string): Promise<{ name: string; type: string }[]> {
    const out: { name: string; type: string }[] = [];
    for (let page = 1; page <= 5; page++) {
      const d = await this.call<{ total?: number; destinations?: { name?: string; id?: string; type?: string }[] }>("GET", "/api/destinations", { device: this.deviceId, robot_id: robotId, page_size: "200", page_index: String(page) });
      const list = d?.destinations ?? [];
      for (const x of list) out.push({ name: String(x.name ?? x.id ?? ""), type: String(x.type ?? "") });
      if (list.length < 200 || (d?.total ?? 0) <= out.length) break;
    }
    return out.filter((x) => x.name);
  }
  addDevice(input: { deviceId: string; deviceSecret: string; region: string; deviceName?: string }) {
    return this.call<{ success?: boolean }>("POST", "/api/add/device", {}, input);
  }
  setNotifyUrl(url: string) {
    return this.call<{ success?: boolean }>("POST", "/api/notify/url", {}, { url });
  }
}

/** 에이전트가 우리에게 보내는 알림(문서 「Interface PuduCloud → 등록서버」). */
export interface AgentNotify {
  msgId: string;
  msgType: string; // notifyDeliveryTask | notifyRobotMoveState | notifyRobotPower | notifyRobotPose | notifyRobotStatus | …
  robotId?: string;
  groupId?: string;
  deviceId?: string;
  timestamp?: number;
  data?: Record<string, unknown>;
}

export interface DeliveryTrayDestination {
  destination: string;
  type?: string; // remote | manual
  id?: string;
  estimatedTime?: number;
  spendTime?: number;
  status?: string; // Await | OnTheWay | Arrived | Cancel | Complete
  completeType?: string;
}

export function isAgentNotify(x: unknown): x is AgentNotify {
  return !!x && typeof x === "object" && typeof (x as AgentNotify).msgType === "string";
}

/**
 * 배송 지시 전용 클라이언트(사용자 결정 2026-11-13: Wide Bot 에서 배송 지시). 조회 클라이언트와 분리해,
 * 이 클래스는 services/delivery.ts 의 지시 함수(권한·사업장 원격 제어 스위치·감사 기록 확인 후)에서만 만든다.
 * 허용: 배송 임무 전송·호출·호출 취소. 그 밖의 조작(커스텀콜·기계 조작 지령 등)은 보내지 않는다.
 */
const COMMANDS = new Set(["/api/robot/delivery/task", "/api/robot/call", "/api/robot/cancel/call"]);

export class AgentCommander {
  constructor(
    private readonly transport: AgentTransport,
    readonly deviceId: string,
  ) {}

  private async post(path: string, body: Record<string, unknown>): Promise<{ success: boolean; taskId?: string }> {
    if (!COMMANDS.has(path)) throw new AgentError(`허용되지 않은 에이전트 명령(${path})`, null);
    let res: { status: number; json: unknown };
    try {
      res = await this.transport.send({ method: "POST", path, query: {}, body: { deviceId: this.deviceId, ...body } });
    } catch (e) {
      throw new AgentError(`에이전트 연결 실패: ${(e as Error).message}`, null);
    }
    const env = (res.json ?? {}) as { code?: unknown; msg?: unknown; mag?: unknown; data?: { success?: boolean; taskId?: string } };
    const code = env.code === undefined || env.code === null ? null : String(env.code);
    if (res.status !== 200 || (code !== null && code !== "0") || env.data?.success === false) {
      const msg = String(env.msg ?? env.mag ?? "");
      throw new AgentError(`${AGENT_COMMAND_FAIL[code ?? ""] ?? "에이전트 거부"}${code ? `(code ${code})` : ""}${msg ? ` ${msg}` : ""}`, code);
    }
    return { success: true, taskId: env.data?.taskId };
  }

  /** 배송 임무 전송. executeTask=false 면 로봇 화면에 임무만 넣고 출발은 사람이 누른다. */
  delivery(robotId: string, trays: { destination: string; id: string }[][], opts: { sort: "fixed" | "auto"; executeTask: boolean }) {
    return this.post("/api/robot/delivery/task", { robotId, type: "new", deliverySort: opts.sort, executeTask: opts.executeTask, trays: trays.map((ds) => ({ destinations: ds })) });
  }
  call(robotId: string, destination: { name: string; type: string }) {
    return this.post("/api/robot/call", { robotId, destination });
  }
  cancelCall(robotId: string, destination: { name: string; type: string }) {
    return this.post("/api/robot/cancel/call", { robotId, destination });
  }
}

/** 문서의 오류 코드(호출 계열) */
export const AGENT_COMMAND_FAIL: Record<string, string> = {
  ...AGENT_CODES,
  "20004": "호출기 오류",
  "20006": "호출 취소 실패",
  "20007": "호출 실패",
  "20008": "호출 실패 — 목적지가 지도에 없음",
  "20009": "호출 실패 — 로봇의 호출 기능이 꺼져 있음",
  "20010": "호출 실패 — 다른 호출기가 이미 다른 지점으로 호출함",
};
