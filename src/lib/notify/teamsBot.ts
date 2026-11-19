import { createPublicKey, verify as cryptoVerify, type JsonWebKey } from "node:crypto";
import { eq, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import { nowIso } from "@/lib/util/time";

/**
 * Teams 봇 직접 발송(docs/24 §2) — Bot Framework REST(Connector) API.
 *
 * - 받기: Teams → POST /api/teams/messages (Bot Framework JWT 서명 검증). 설치(installationUpdate·conversationUpdate)·메시지에서
 *   개인 채팅 주소(serviceUrl·conversationId)를 teams_conversations 에 저장하고, 직원 이메일은 Connector 의 구성원 조회로 얻는다.
 * - 보내기: 저장한 개인 채팅에 POST {serviceUrl}/v3/conversations/{id}/activities (Adaptive Card). 대기열 없이 보통 1~2초.
 * - 자격: Azure Bot(단일 테넌트)의 앱 ID·클라이언트 비밀·테넌트 ID. 서버 .env(TEAMS_BOT_*)에만 둔다.
 */

export interface TeamsBotConfig {
  appId: string;
  appSecret: string;
  tenantId: string;
}

export function teamsBotConfig(): TeamsBotConfig | null {
  const appId = process.env.TEAMS_BOT_APP_ID?.trim();
  const appSecret = process.env.TEAMS_BOT_APP_SECRET?.trim();
  const tenantId = process.env.TEAMS_BOT_TENANT_ID?.trim();
  return appId && appSecret && tenantId ? { appId, appSecret, tenantId } : null;
}

type Res = { status: number; ok?: boolean; json(): Promise<unknown>; text(): Promise<string> };
type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Res>;
let fetchImpl: FetchLike | null = null;
/** 시험용: Microsoft 쪽 호출(토큰·OpenID·Connector)을 가로챈다. */
export function setTeamsBotFetchForTest(f: FetchLike | null): void {
  fetchImpl = f;
  tokenCache = null;
  jwksCache = null;
}
const doFetch: FetchLike = (u, i) => (fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init) as unknown as Promise<Res>))(u, i);

const LOGIN_HOST = "https://login.microsoftonline.com";
const BF_SCOPE = "https://api.botframework.com/.default";
const BF_OPENID = "https://login.botframework.com/v1/.well-known/openidconfiguration";
const BF_ISSUER = "https://api.botframework.com";
/** 대화 주소 서버(serviceUrl)는 Microsoft 소유 호스트만 믿는다(위조된 활동으로 토큰을 다른 곳에 보내지 않게). */
const SERVICE_URL_OK = /^https:\/\/([a-z0-9-]+\.)*(trafficmanager\.net|botframework\.com|teams\.microsoft\.com|botframework\.azure\.us)\//i;

// ---------------------------------------------------------------- 보내는 쪽 토큰(앱 → Bot Connector)

let tokenCache: { token: string; exp: number } | null = null;

export async function botToken(cfg: TeamsBotConfig): Promise<string> {
  if (tokenCache && tokenCache.exp - 60_000 > Date.now()) return tokenCache.token;
  const res = await doFetch(`${LOGIN_HOST}/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: cfg.appId, client_secret: cfg.appSecret, scope: BF_SCOPE }).toString(),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (res.status !== 200 || !j.access_token) throw new Error(`봇 토큰 발급 실패(HTTP ${res.status} ${j.error ?? ""})`.trim());
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return j.access_token;
}

// ---------------------------------------------------------------- 받는 쪽 검증(Teams → 우리)

let jwksCache: { keys: (JsonWebKey & { kid?: string; endorsements?: string[] })[]; at: number } | null = null;

async function jwks(): Promise<NonNullable<typeof jwksCache>["keys"]> {
  if (jwksCache && Date.now() - jwksCache.at < 12 * 3600_000) return jwksCache.keys;
  const meta = (await (await doFetch(BF_OPENID)).json()) as { jwks_uri: string };
  const set = (await (await doFetch(meta.jwks_uri)).json()) as { keys: NonNullable<typeof jwksCache>["keys"] };
  jwksCache = { keys: set.keys ?? [], at: Date.now() };
  return jwksCache.keys;
}

function b64urlJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

/** Bot Framework 가 보낸 요청인지: RS256 서명·발급자·대상(우리 앱 ID)·만료·serviceUrl 일치. 맞으면 null, 아니면 사유. */
export async function verifyBotRequest(authHeader: string | null, cfg: TeamsBotConfig, serviceUrl: string | undefined): Promise<string | null> {
  const m = /^Bearer\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authHeader ?? "");
  if (!m) return "토큰 없음";
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = b64urlJson(m[1]);
    claims = b64urlJson(m[2]);
  } catch {
    return "토큰 형식 오류";
  }
  if (header.alg !== "RS256") return "서명 방식 오류";
  const key = (await jwks()).find((k) => k.kid === header.kid);
  if (!key) return "서명 키 없음";
  if (key.endorsements && !key.endorsements.includes("msteams")) return "Teams 채널 키 아님";
  const ok = cryptoVerify("RSA-SHA256", Buffer.from(`${m[1]}.${m[2]}`), createPublicKey({ key, format: "jwk" }), Buffer.from(m[3], "base64url"));
  if (!ok) return "서명 불일치";
  if (claims.iss !== BF_ISSUER) return "발급자 불일치";
  if (claims.aud !== cfg.appId) return "대상 앱 불일치";
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + 300 < now) return "토큰 만료";
  if (typeof claims.nbf === "number" && claims.nbf - 300 > now) return "토큰 사용 전";
  if (serviceUrl && claims.serviceurl && String(claims.serviceurl).replace(/\/$/, "") !== serviceUrl.replace(/\/$/, "")) return "serviceUrl 불일치";
  return null;
}

// ---------------------------------------------------------------- 활동 처리(설치·메시지)

export interface BotActivity {
  type: string;
  action?: string; // installationUpdate: add | remove
  serviceUrl?: string;
  from?: { id?: string; aadObjectId?: string; name?: string };
  recipient?: { id?: string };
  conversation?: { id?: string; conversationType?: string; tenantId?: string };
  channelData?: { tenant?: { id?: string } };
  membersAdded?: { id?: string; aadObjectId?: string }[];
  text?: string;
}

const base = (u: string) => (u.endsWith("/") ? u : `${u}/`);

async function connector(cfg: TeamsBotConfig, method: "GET" | "POST", serviceUrl: string, path: string, body?: unknown): Promise<Res> {
  if (!SERVICE_URL_OK.test(base(serviceUrl))) throw new Error("허용되지 않은 serviceUrl");
  const token = await botToken(cfg);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.TEAMS_TIMEOUT_MS ?? 10000));
  try {
    return await doFetch(`${base(serviceUrl)}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 개인 채팅 활동이면 주소를 저장(구성원 조회로 이메일 확인). 저장했으면 true. */
export async function handleBotActivity(cfg: TeamsBotConfig, a: BotActivity): Promise<{ stored: boolean; reply?: string }> {
  const conv = a.conversation;
  if (!a.serviceUrl || !conv?.id || conv.conversationType !== "personal") return { stored: false };
  const tenantId = conv.tenantId ?? a.channelData?.tenant?.id ?? "";
  if (tenantId !== cfg.tenantId) return { stored: false }; // 다른 회사(테넌트)에서 온 활동은 받지 않는다
  const db = getDb();
  const userId = a.from?.id ?? "";
  const aad = a.from?.aadObjectId ?? a.membersAdded?.find((m) => m.aadObjectId)?.aadObjectId ?? "";
  if (!aad) return { stored: false };
  if (a.type === "installationUpdate" && (a.action === "remove" || a.action === "remove-upgrade")) {
    await db.update(schema.teamsConversations).set({ removedAt: nowIso(), updatedAt: nowIso() }).where(eq(schema.teamsConversations.aadObjectId, aad));
    return { stored: false };
  }
  let email: string | null = null;
  let upn: string | null = null;
  let name: string | null = a.from?.name ?? null;
  try {
    const r = await connector(cfg, "GET", a.serviceUrl, `v3/conversations/${encodeURIComponent(conv.id)}/members/${encodeURIComponent(userId || aad)}`);
    if (r.status === 200) {
      const mem = (await r.json()) as { email?: string; userPrincipalName?: string; name?: string };
      email = mem.email?.toLowerCase() ?? null;
      upn = mem.userPrincipalName?.toLowerCase() ?? null;
      name = mem.name ?? name;
    }
  } catch {
    /* 이메일을 못 얻어도 주소는 저장(다음 활동 때 다시 시도) */
  }
  const row = { aadObjectId: aad, email, upn, name, tenantId, conversationId: conv.id, serviceUrl: a.serviceUrl, removedAt: null, updatedAt: nowIso() };
  await db.insert(schema.teamsConversations).values(row).onConflictDoUpdate({ target: schema.teamsConversations.aadObjectId, set: { ...row, email: email ?? sql`${schema.teamsConversations.email}`, upn: upn ?? sql`${schema.teamsConversations.upn}` } });
  const welcome = "Wide Bot 알림이 이 채팅으로 옵니다(배송 도착·장애 등). 받는 항목은 Wide Bot 화면에서 바꿀 수 있습니다.";
  const isInstall = a.type === "installationUpdate" || (a.type === "conversationUpdate" && !!a.membersAdded?.some((m) => m.id === a.recipient?.id));
  return { stored: true, reply: isInstall ? welcome : a.type === "message" ? "이 채팅은 알림 전용입니다. 자세한 내용은 Wide Bot 화면에서 확인하세요." : undefined };
}

/** 같은 대화에 짧은 답장(설치 환영·안내). 실패해도 무시. */
export async function replyText(cfg: TeamsBotConfig, a: BotActivity, text: string): Promise<void> {
  try {
    await connector(cfg, "POST", a.serviceUrl!, `v3/conversations/${encodeURIComponent(a.conversation!.id!)}/activities`, { type: "message", text });
  } catch {
    /* 무시 */
  }
}

// ---------------------------------------------------------------- 보내기

export async function findConversation(email: string) {
  const e = email.trim().toLowerCase();
  const rows = await getDb().select().from(schema.teamsConversations).where(or(eq(schema.teamsConversations.email, e), eq(schema.teamsConversations.upn, e)));
  return rows.find((r) => !r.removedAt) ?? null;
}

/** 개인에게 카드 1건(직접 발송). 앱이 설치되지 않은 사람은 보낼 대화가 없어 실패로 남긴다. */
export async function sendBotCard(cfg: TeamsBotConfig, email: string, card: Record<string, unknown>, summary: string): Promise<{ ok: boolean; reason: string }> {
  const conv = await findConversation(email);
  if (!conv) return { ok: false, reason: "Teams 앱(Wide Bot)이 이 직원에게 설치되지 않음 — Teams 관리 센터 설치 정책 확인" };
  try {
    const t0 = Date.now();
    const res = await connector(cfg, "POST", conv.serviceUrl, `v3/conversations/${encodeURIComponent(conv.conversationId)}/activities`, {
      type: "message",
      summary,
      attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }],
    });
    if (res.status >= 200 && res.status < 300) return { ok: true, reason: `Teams 봇 직접 발송(${Date.now() - t0}ms)` };
    if (res.status === 403 || res.status === 404) {
      await getDb().update(schema.teamsConversations).set({ removedAt: nowIso(), updatedAt: nowIso() }).where(eq(schema.teamsConversations.aadObjectId, conv.aadObjectId));
      return { ok: false, reason: `Teams 봇 발송 거절(HTTP ${res.status}) — 앱이 제거됐거나 차단됨` };
    }
    return { ok: false, reason: `Teams 봇 발송 실패(HTTP ${res.status}) ${(await res.text().catch(() => "")).slice(0, 150)}`.trim() };
  } catch (e) {
    return { ok: false, reason: `Teams 봇 발송 실패: ${(e as Error).name === "AbortError" ? "시간 초과" : (e as Error).message}` };
  }
}
