import { createHmac } from "node:crypto";

/**
 * CZ Robots(CenoBots) Open API HTTP 클라이언트 — 조회 전용.
 * 문서: docs/vendors/cenobots/openapi_v1.0.18.txt
 * - 인증 헤더: X-Api-Key, X-Api-timestamp(ms), X-Api-signature = hex(HMAC-SHA256(SecretKey, METHOD + timestamp + path)).
 *   path 는 "/app/openapi/v1/..." (HOST 뒤 전체 경로). 문서 예제는 쿼리 없이 서명한다 → 기본은 쿼리 제외, CENOBOTS_SIGN_WITH_QUERY=true 면 포함.
 * - 응답 봉투: { success, code, data, info, rid }. success=false 면 rid 를 붙여 오류(키·시크릿은 어디에도 남기지 않는다).
 * - 보수적 호출: 요청을 직렬화하고 최소 간격(기본 150ms ≈ 초당 6건, 웹훅 관리 API 제한 10건/초보다 낮게), 429·5xx·네트워크 오류는 지수 백오프 재시도.
 * - 쓰기 계열 호출 금지: GET 과 조회용 POST(mission/list, mission/summary)만 허용한다. 그 밖의 경로는 요청 전에 막는다.
 */

export const CENOBOTS_HOSTS: Record<string, string> = {
  apac: "https://app-server-apac.cz-robots.com",
  eu: "https://app-server-eu.cz-robots.com",
  us: "https://app-server-us.cz-robots.com",
  other: "https://app-server.cz-robots.com",
};

/** 조회용 POST 허용 목록(본문으로 조회 조건을 넘기는 API). 이 밖의 POST/PUT/DELETE 는 보내지 않는다. */
export const READ_ONLY_POST_PATHS = new Set(["/app/openapi/v1/mission/list", "/app/openapi/v1/mission/summary"]);

export interface CenobotsConfig {
  host: string;
  accessKey: string;
  secretKey: string;
  /** 허용 장비(deviceOpenId 또는 번호판). 목록 밖 장비는 조회·적재하지 않는다(PUDU 허용 매장과 같은 개념). */
  allowed: string[];
  timeoutMs?: number;
  minIntervalMs?: number;
  maxRetries?: number;
  signWithQuery?: boolean;
}

export interface CenobotsEnvelope<T> {
  success: boolean;
  code: number | null;
  data: T | null;
  info: string | null;
  rid: string | null;
}

export class CenobotsApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: number | null,
    public readonly rid: string | null,
  ) {
    super(message);
    this.name = "CenobotsApiError";
  }
}

export type QueryValue = string | number | boolean | undefined | null;

/** 전송 계층(실제 HTTP 또는 mock 픽스처). 서명 헤더까지 붙은 요청을 받는다. */
export interface CenobotsTransport {
  send(req: { method: "GET" | "POST"; url: string; path: string; headers: Record<string, string>; body?: string; timeoutMs: number }): Promise<{ status: number; text: string }>;
}

export const fetchTransport: CenobotsTransport = {
  async send(req) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);
    try {
      const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: controller.signal, redirect: "error" });
      return { status: res.status, text: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  },
};

/** 서명 문자열과 값. 문서 예제와 같은 규칙(METHOD + timestamp + path). */
export function signCenobots(secretKey: string, method: string, timestamp: string, path: string): string {
  return createHmac("sha256", secretKey).update(`${method.toUpperCase()}${timestamp}${path}`, "utf8").digest("hex");
}

/** "a, b  c" → ["a","b","c"] */
export function parseList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function hostFromEnv(): string | null {
  const raw = (process.env.CENOBOTS_HOST || process.env.CENOBOTS_API_HOST || "").trim();
  if (!raw) return null;
  if (CENOBOTS_HOSTS[raw.toLowerCase()]) return CENOBOTS_HOSTS[raw.toLowerCase()];
  return raw.replace(/\/+$/, "");
}

/** 환경변수 → 설정. 키·호스트·허용 장비가 모두 있어야 한다(없으면 null → 모드 unconfigured). */
export function configFromEnv(): CenobotsConfig | null {
  const host = hostFromEnv();
  const accessKey = process.env.CENOBOTS_ACCESS_KEY;
  const secretKey = process.env.CENOBOTS_SECRET_KEY;
  const allowed = parseList(process.env.CENOBOTS_ALLOWED_DEVICE_OPEN_IDS);
  if (!host || !accessKey || !secretKey || allowed.length === 0) return null;
  return {
    host,
    accessKey,
    secretKey,
    allowed,
    timeoutMs: Number(process.env.CENOBOTS_TIMEOUT_MS ?? 15000),
    minIntervalMs: Number(process.env.CENOBOTS_MIN_INTERVAL_MS ?? 150),
    maxRetries: Number(process.env.CENOBOTS_MAX_RETRIES ?? 3),
    signWithQuery: process.env.CENOBOTS_SIGN_WITH_QUERY === "true",
  };
}

/** 시각 관련 실패로 보이는 문구면 서버 시계 확인 힌트를 붙인다(인증이 시각 기반). */
function clockHint(info: string | null, status: number): string {
  const s = `${info ?? ""}`.toLowerCase();
  return /time|timestamp|expire|clock|signature/.test(s) || status === 401 ? " — 서명·시각 오류일 수 있습니다(서버 시계 동기화·키 확인)" : "";
}

export class CenobotsClient {
  private queue: Promise<unknown> = Promise.resolve();
  private lastAt = 0;

  constructor(
    private readonly cfg: CenobotsConfig,
    private readonly transport: CenobotsTransport = fetchTransport,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  get host(): string {
    return this.cfg.host;
  }

  /** 직렬 실행 + 최소 간격 */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = (this.cfg.minIntervalMs ?? 150) - (Date.now() - this.lastAt);
      if (wait > 0) await this.sleep(wait);
      try {
        return await fn();
      } finally {
        this.lastAt = Date.now();
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async get<T>(path: string, query: Record<string, QueryValue> = {}): Promise<T> {
    return this.request<T>("GET", path, query, undefined);
  }

  /** 조회용 POST 만(mission/list, mission/summary). */
  async postQuery<T>(path: string, body: unknown): Promise<T> {
    if (!READ_ONLY_POST_PATHS.has(path)) throw new CenobotsApiError(`조회 전용 연동: 허용되지 않은 POST 경로(${path})는 보내지 않습니다.`, 0, null, null);
    return this.request<T>("POST", path, {}, body);
  }

  private async request<T>(method: "GET" | "POST", path: string, query: Record<string, QueryValue>, body: unknown): Promise<T> {
    if (!path.startsWith("/app/openapi/v1/")) throw new CenobotsApiError(`잘못된 경로: ${path}`, 0, null, null);
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    const fullPath = qs ? `${path}?${qs}` : path;
    const bodyText = body === undefined ? undefined : JSON.stringify(body);
    const maxRetries = this.cfg.maxRetries ?? 3;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const res = await this.serialize(async () => {
        const timestamp = String(Date.now());
        const signature = signCenobots(this.cfg.secretKey, method, timestamp, this.cfg.signWithQuery ? fullPath : path);
        const headers: Record<string, string> = { "X-Api-Key": this.cfg.accessKey, "X-Api-timestamp": timestamp, "X-Api-signature": signature, Accept: "application/json" };
        if (bodyText !== undefined) headers["Content-Type"] = "application/json";
        try {
          return await this.transport.send({ method, url: `${this.cfg.host}${fullPath}`, path: fullPath, headers, body: bodyText, timeoutMs: this.cfg.timeoutMs ?? 15000 });
        } catch (e) {
          return { status: 0, text: `network: ${(e as Error).message}` };
        }
      });
      const retryable = res.status === 0 || res.status === 429 || res.status >= 500;
      if (retryable && attempt <= maxRetries) {
        await this.sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
        continue;
      }
      return this.unwrap<T>(method, path, res);
    }
  }

  private unwrap<T>(method: string, path: string, res: { status: number; text: string }): T {
    let json: Record<string, unknown> | null = null;
    try {
      json = res.text ? (JSON.parse(res.text) as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
    const env: CenobotsEnvelope<T> = {
      success: json?.success === true,
      code: typeof json?.code === "number" ? (json.code as number) : null,
      data: (json?.data as T) ?? null,
      info: typeof json?.info === "string" ? (json.info as string) : null,
      rid: typeof json?.rid === "string" ? (json.rid as string) : null,
    };
    if (res.status === 200 && env.success) return env.data as T;
    // 실패: 키·서명 값은 넣지 않는다. 응답 본문도 원문 대신 info·code·rid 만 남긴다.
    const what = `${method} ${path.replace(/\/[A-Za-z0-9_-]{6,}$/, "/{id}")}`;
    const detail = res.status === 0 ? res.text.slice(0, 120) : `HTTP ${res.status}${env.code !== null ? ` code ${env.code}` : ""}${env.info ? ` ${env.info}` : ""}`;
    throw new CenobotsApiError(`CENOBOTS ${what} 실패: ${detail}${env.rid ? ` (rid ${env.rid})` : ""}${clockHint(env.info, res.status)}`, res.status, env.code, env.rid);
  }
}
