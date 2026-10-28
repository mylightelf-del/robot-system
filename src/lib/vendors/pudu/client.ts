import { signRequest, type QueryValue } from "./signing";

/**
 * PUDU 개방 플랫폼 HTTP 클라이언트.
 * - 클러스터는 환경변수 PUDU_API_CLUSTER(cn/sea/de/us) 로 지정하며 기본값을 두지 않는다(공식 지침).
 * - 모든 요청은 HMAC-SHA1 서명. 성공 판정은 HTTP 200 + message 에 success 포함(실기: "SUCCESS"/"success"/"GetHealthCheck Success！…") 또는 "ok".
 * - 통계/로그 API 는 동일 카테고리 동시 1건 제한이 있어 호출을 직렬화한다.
 */
export const PUDU_CLUSTERS: Record<string, { hostname: string; label: string }> = {
  cn: { hostname: "open-platform.pudutech.com", label: "중국" },
  sea: { hostname: "css-open-platform.pudutech.com", label: "해외(일본·한국·싱가포르)" },
  de: { hostname: "csg-open-platform.pudutech.com", label: "독일" },
  us: { hostname: "csu-open-platform.pudutech.com", label: "미국" },
};

export const PUDU_ENTRY = "/pudu-entry";

export interface PuduConfig {
  apiAppKey: string;
  apiAppSecret: string;
  /** cn | sea | de | us, 또는 baseUrl 직접 지정(테스트·모의 서버) */
  cluster?: string;
  baseUrl?: string;
  timeoutMs?: number;
  language?: string; // Language 헤더(통계 API 상세 문구 언어), 예: ko-KR
  /**
   * 허용 매장(shop_id) 목록. 실기 확인 결과 대리점 키는 다른 고객사의 매장·로봇까지 모두 보이고(수천 대),
   * 통계 API(보고서·장애 로그)는 sn 으로 걸러지지 않고 shop_id 로만 걸러진다. 그래서 우리 매장만 명시한다.
   */
  shopIds: string[];
}

export interface PuduResponse<T> {
  ok: boolean;
  status: number;
  message: string;
  traceId: string | null;
  data: T | null;
  raw: unknown;
}

export class PuduApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly traceId: string | null,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "PuduApiError";
  }
}

/** "602550006, 641450007" → ["602550006","641450007"]. 실기에서 shop_id 는 문자열로 온다(목록 API)거나 숫자(상세 API)라 문자열로 통일한다. */
export function parseShopIds(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
}

export function configFromEnv(): PuduConfig | null {
  const apiAppKey = process.env.PUDU_API_APP_KEY;
  const apiAppSecret = process.env.PUDU_API_APP_SECRET;
  const cluster = process.env.PUDU_API_CLUSTER;
  const baseUrl = process.env.PUDU_API_BASE_URL;
  if (!apiAppKey || !apiAppSecret) return null;
  if (!baseUrl && !(cluster && PUDU_CLUSTERS[cluster])) return null;
  return { apiAppKey, apiAppSecret, cluster, baseUrl, timeoutMs: Number(process.env.PUDU_API_TIMEOUT_MS ?? 15000), language: process.env.PUDU_API_LANGUAGE ?? "ko-KR", shopIds: parseShopIds(process.env.PUDU_SHOP_IDS) };
}

export class PuduClient {
  private readonly base: URL;
  private dataBoardQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly cfg: PuduConfig) {
    const base = cfg.baseUrl ?? `https://${PUDU_CLUSTERS[cfg.cluster ?? ""]?.hostname}${PUDU_ENTRY}`;
    if (!cfg.baseUrl && !PUDU_CLUSTERS[cfg.cluster ?? ""]) throw new Error("PUDU 클러스터(PUDU_API_CLUSTER)가 올바르지 않습니다: cn | sea | de | us");
    this.base = new URL(base.endsWith("/") ? base.slice(0, -1) : base);
  }

  get describe(): string {
    return `${this.base.origin}${this.base.pathname} (key ${this.cfg.apiAppKey.slice(0, 3)}***)`;
  }

  /** 통계/로그(data-board) API 는 동시 1건 제한 → 직렬 실행. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.dataBoardQueue.then(fn, fn);
    this.dataBoardQueue = run.catch(() => undefined);
    return run;
  }

  async get<T = unknown>(path: string, query: Record<string, QueryValue> = {}): Promise<PuduResponse<T>> {
    const exec = () => this.request<T>("GET", path, query, undefined);
    return path.startsWith("/data-board/") ? this.serialize(exec) : exec();
  }

  async post<T = unknown>(path: string, body: unknown): Promise<PuduResponse<T>> {
    return this.request<T>("POST", path, {}, body);
  }

  private async request<T>(method: "GET" | "POST", path: string, query: Record<string, QueryValue>, body: unknown): Promise<PuduResponse<T>> {
    const fullPath = `${this.base.pathname}${path}`;
    const signed = signRequest({ apiAppKey: this.cfg.apiAppKey, apiAppSecret: this.cfg.apiAppSecret, method, path: fullPath, query, body });
    const url = `${this.base.origin}${signed.path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 15000);
    try {
      const res = await fetch(url, {
        method,
        headers: { ...signed.headers, ...(this.cfg.language ? { Language: this.cfg.language } : {}) },
        body: method === "POST" ? signed.body : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let json: Record<string, unknown> | null = null;
      try {
        json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      } catch {
        json = null;
      }
      const message = String(json?.message ?? (res.ok ? "" : res.statusText));
      // 실기: 대부분 "SUCCESS", 기초 API 는 "success", healthCheck 는 "GetHealthCheck Success！request={}"
      const ok = res.status === 200 && (/success/i.test(message) || message.toLowerCase() === "ok");
      // 실기: trace_id 가 "<ApiAppKey>_<uuid>" 꼴이라 키가 그대로 들어 있다 → 저장·표시 전에 키 접두사를 떼어낸다.
      return { ok, status: res.status, message, traceId: this.maskTrace(json?.trace_id as string | undefined), data: ok ? ((json?.data as T) ?? null) : null, raw: this.maskRaw(json ?? text) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 실패를 예외로 바꿔 주는 헬퍼. */
  private maskTrace(trace: string | undefined): string | null {
    if (!trace) return null;
    const prefix = `${this.cfg.apiAppKey}_`;
    return trace.startsWith(prefix) ? trace.slice(prefix.length) : trace;
  }
  private maskRaw(raw: unknown): unknown {
    if (typeof raw === "string") return raw.split(`${this.cfg.apiAppKey}_`).join("");
    if (raw && typeof raw === "object" && typeof (raw as { trace_id?: unknown }).trace_id === "string") return { ...(raw as object), trace_id: this.maskTrace((raw as { trace_id: string }).trace_id) };
    return raw;
  }

  static unwrap<T>(res: PuduResponse<T>, what: string): T {
    if (!res.ok) throw new PuduApiError(`PUDU ${what} 실패: HTTP ${res.status} ${res.message || "(응답 없음)"}`, res.status, res.traceId, res.raw);
    return res.data as T;
  }
}
