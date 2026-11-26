import { createPrivateKey, randomBytes, sign, type KeyObject } from "node:crypto";

/**
 * BIB(라이노스 Rhiverse) 파트너 로봇 API 클라이언트 — 「파트너 로봇 API 연동 가이드 v0.1」(2026-11-18) 기준.
 * - 로그인: POST /partner/v1/auth/service { serviceKey, timestamp(초, ±180s), nonceB64, signatureB64 }
 *   서명 원문 = serviceKey + timestamp(십진) + nonceB64 (UTF-8, 구분자 없음), Ed25519(PKCS#8 PEM). 응답 201 { accessToken, expiresIn, expiresAt, tokenType }
 * - 로봇 API: Authorization: Bearer <accessToken>. 토큰은 메모리에만(로그·URL·코드에 넣지 않음), 만료 30초 전 재로그인.
 * - 조회 401 → 토큰 폐기·재로그인 후 1회만 재요청(가이드 「오류별 처리」). 로그인 실패·제어 요청은 자동 재전송하지 않는다.
 * - Wide Bot 은 조회 전용: GET 만 허용(제어 경로는 요청 전에 막는다).
 * 비밀값(BIB_PRIVATE_KEY_B64)은 서버 .env 에만.
 */
export interface BibConfig {
  baseUrl: string;
  serviceKey: string;
  privateKey: KeyObject;
  timeoutMs: number;
}

export function bibConfigFromEnv(): BibConfig | null {
  const baseUrl = (process.env.BIB_API_BASE_URL || "").replace(/\/+$/, "");
  const serviceKey = process.env.BIB_LOGIN_ID || "";
  const b64 = process.env.BIB_PRIVATE_KEY_B64 || "";
  if (!baseUrl || !serviceKey || !b64) return null;
  try {
    return { baseUrl, serviceKey, privateKey: createPrivateKey(Buffer.from(b64, "base64")), timeoutMs: Number(process.env.BIB_TIMEOUT_MS ?? 20000) };
  } catch {
    return null;
  }
}

export class BibError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode: string | null,
  ) {
    super(message);
  }
}

type Res = { status: number; json(): Promise<unknown>; text(): Promise<string> };
export type BibFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: "error" }) => Promise<Res>;

/** 조회 전용으로 허용하는 경로(정규식). 제어(task/{id}/start·action/*, command 등)는 보내지 않는다. */
const READ_PATHS = [/^\/partner\/v1\/robot\/list$/, /^\/partner\/v1\/robot\/[^/]+\/(status|position|localmap\/list|localmap|task\/list|task\/current)$/, /^\/partner\/v1\/robot\/[^/]+\/localmap\/[^/]+$/];

export class BibClient {
  private token: { value: string; expiresAt: number } | null = null;
  constructor(
    private readonly cfg: BibConfig,
    private readonly fetchImpl: BibFetch = (u, i) => fetch(u, i) as unknown as Promise<Res>,
  ) {}

  private async login(): Promise<string> {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonceB64 = randomBytes(24).toString("base64");
    const signatureB64 = sign(null, Buffer.from(this.cfg.serviceKey + timestamp + nonceB64, "utf8"), this.cfg.privateKey).toString("base64");
    const res = await this.fetchImpl(`${this.cfg.baseUrl}/partner/v1/auth/service`, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serviceKey: this.cfg.serviceKey, timestamp, nonceB64, signatureB64 }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
    const j = (await res.json().catch(() => ({}))) as { accessToken?: string; expiresAt?: string; errorCode?: string; message?: string };
    if (res.status !== 201 && res.status !== 200) throw new BibError(`BIB 로그인 실패(HTTP ${res.status} ${j.errorCode ?? ""})${res.status === 400 ? " — 서버 시계(±180초)·키 확인" : ""}`.trim(), res.status, j.errorCode ?? null);
    const exp = Date.parse(j.expiresAt ?? "");
    if (!j.accessToken || !Number.isFinite(exp)) throw new BibError("BIB 로그인 응답 형식 오류", res.status, null);
    this.token = { value: j.accessToken, expiresAt: exp };
    return j.accessToken;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - Date.now() > 30_000) return this.token.value;
    return this.login();
  }

  /** 조회(GET). 401 이면 토큰을 버리고 한 번만 다시 로그인해 재요청. */
  async get<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
    if (!READ_PATHS.some((re) => re.test(path))) throw new BibError(`조회 전용 연동: 허용되지 않은 경로(${path})`, 0, null);
    const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
    const url = `${this.cfg.baseUrl}${path}${qs ? `?${qs}` : ""}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.fetchImpl(url, { method: "GET", redirect: "error", headers: { Authorization: `Bearer ${await this.accessToken()}` }, signal: AbortSignal.timeout(this.cfg.timeoutMs) });
      if (res.status === 200) return (await res.json()) as T;
      const j = (await res.json().catch(() => ({}))) as { errorCode?: string; message?: string };
      if (res.status === 401 && attempt === 0) {
        this.token = null;
        continue;
      }
      throw new BibError(`BIB ${path.replace(/[0-9a-f-]{36}/g, "{robot}")} 실패(HTTP ${res.status} ${j.errorCode ?? ""})`.trim(), res.status, j.errorCode ?? null);
    }
    throw new BibError("BIB 인증 실패(재로그인 뒤에도 401) — 계정 상태 확인", 401, "UNAUTHORIZED");
  }
}
