/**
 * 카카오톡 알림 — "나에게 보내기"(카카오 로그인한 사용자 본인의 '나와의 채팅'으로 전송).
 * 공식 문서(2026-10-30 확인):
 *  - 인가: GET https://kauth.kakao.com/oauth/authorize?client_id&redirect_uri&response_type=code&scope&state
 *  - 토큰: POST https://kauth.kakao.com/oauth/token (form) grant_type=authorization_code|refresh_token, client_id, redirect_uri, code, client_secret(설정 ON 이면 필수)
 *    응답 access_token·expires_in·refresh_token·refresh_token_expires_in. 갱신 응답의 refresh_token 은 남은 기간 1개월 미만일 때만 새로 온다.
 *  - 사용자 ID: GET https://kapi.kakao.com/v1/user/access_token_info → id
 *  - 전송: POST https://kapi.kakao.com/v2/api/talk/memo/default/send (form) template_object=JSON, 성공 시 result_code 0.
 *    text 템플릿: object_type "text", text(최대 200자), link{web_url, mobile_web_url}(도메인은 앱의 '제품 링크 관리 > 웹 도메인' 에 등록), button_title.
 *  - 동의 항목: talk_message. 다른 사람에게 보내기는 별도 권한이 필요해 쓰지 않는다(수신자마다 본인이 연결).
 * 고객사·다수에게 보내는 '알림톡'(비즈니스 채널·템플릿 검수·발송대행사)은 별도 단계다.
 */
import { eq, lt } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import { open, seal, tokenEncryptionConfigured } from "@/lib/util/secretBox";
import { nowIso } from "@/lib/util/time";

export const KAKAO_TEXT_MAX = 200;

export interface KakaoConfig {
  restKey: string;
  clientSecret: string | null;
  redirectUri: string;
  authBase: string;
  apiBase: string;
}

export function kakaoConfig(): KakaoConfig | null {
  const restKey = process.env.KAKAO_REST_API_KEY || "";
  const base = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  if (!restKey || !base || !tokenEncryptionConfigured()) return null;
  return {
    restKey,
    clientSecret: process.env.KAKAO_CLIENT_SECRET || null,
    redirectUri: `${base}/api/kakao/callback`,
    // 시험용 모의 서버 주소로 바꿀 수 있다(운영은 기본값)
    authBase: process.env.KAKAO_AUTH_BASE || "https://kauth.kakao.com",
    apiBase: process.env.KAKAO_API_BASE || "https://kapi.kakao.com",
  };
}

export function kakaoAuthorizeUrl(cfg: KakaoConfig, state: string): string {
  const q = new URLSearchParams({ client_id: cfg.restKey, redirect_uri: cfg.redirectUri, response_type: "code", scope: "talk_message", state });
  return `${cfg.authBase}/oauth/authorize?${q.toString()}`;
}

type TokenResponse = { access_token?: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number; error?: string; error_description?: string };

async function tokenRequest(cfg: KakaoConfig, params: Record<string, string>): Promise<TokenResponse> {
  const body = new URLSearchParams({ client_id: cfg.restKey, ...params, ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}) });
  const res = await fetch(`${cfg.authBase}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" }, body, signal: AbortSignal.timeout(10_000) });
  const j = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !j.access_token) throw new Error(`카카오 토큰 오류: ${j.error ?? res.status}${j.error_description ? ` (${j.error_description})` : ""}`);
  return j;
}

const plus = (sec: number | undefined) => new Date(Date.now() + (sec ?? 0) * 1000).toISOString();

/** 인가 코드 → 토큰 → 카카오 회원번호 확인 → 이 사용자에 연결 저장(토큰은 암호화). */
export async function linkKakao(userId: string, code: string): Promise<{ kakaoUserId: string }> {
  const cfg = kakaoConfig();
  if (!cfg) throw new Error("카카오 연동이 설정되지 않았습니다.");
  const t = await tokenRequest(cfg, { grant_type: "authorization_code", redirect_uri: cfg.redirectUri, code });
  const info = await fetch(`${cfg.apiBase}/v1/user/access_token_info`, { headers: { Authorization: `Bearer ${t.access_token}` }, signal: AbortSignal.timeout(10_000) });
  const ij = (await info.json().catch(() => ({}))) as { id?: number | string };
  if (!info.ok || ij.id === undefined) throw new Error("카카오 사용자 정보를 확인하지 못했습니다.");
  const row = {
    userId,
    kakaoUserId: String(ij.id),
    accessToken: seal(t.access_token!),
    accessExpiresAt: plus(t.expires_in),
    refreshToken: seal(t.refresh_token ?? ""),
    refreshExpiresAt: t.refresh_token_expires_in ? plus(t.refresh_token_expires_in) : null,
    linkedAt: nowIso(),
    lastSentAt: null,
    lastError: null,
  };
  await getDb().insert(schema.kakaoLinks).values(row).onConflictDoUpdate({ target: schema.kakaoLinks.userId, set: { ...row } });
  return { kakaoUserId: row.kakaoUserId };
}

export async function unlinkKakao(userId: string): Promise<void> {
  await getDb().delete(schema.kakaoLinks).where(eq(schema.kakaoLinks.userId, userId));
}

export async function kakaoLinkStatus(userId: string): Promise<{ linked: boolean; linkedAt: string | null; lastSentAt: string | null; lastError: string | null; refreshExpiresAt: string | null }> {
  const l = await getDb().query.kakaoLinks.findFirst({ where: eq(schema.kakaoLinks.userId, userId) });
  return { linked: !!l, linkedAt: l?.linkedAt ?? null, lastSentAt: l?.lastSentAt ?? null, lastError: l?.lastError ?? null, refreshExpiresAt: l?.refreshExpiresAt ?? null };
}

/** 리프레시 토큰으로 액세스 토큰 갱신. 새 리프레시 토큰이 오면 함께 바꾼다. */
async function refreshLink(cfg: KakaoConfig, link: typeof schema.kakaoLinks.$inferSelect): Promise<string> {
  const t = await tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: open(link.refreshToken) });
  await getDb()
    .update(schema.kakaoLinks)
    .set({
      accessToken: seal(t.access_token!),
      accessExpiresAt: plus(t.expires_in),
      ...(t.refresh_token ? { refreshToken: seal(t.refresh_token), refreshExpiresAt: t.refresh_token_expires_in ? plus(t.refresh_token_expires_in) : null } : {}),
      lastError: null,
    })
    .where(eq(schema.kakaoLinks.userId, link.userId));
  return t.access_token!;
}

/** 사용자 본인의 카카오톡으로 보낸다. 액세스 토큰이 5분 안에 만료되거나 401 이면 한 번 갱신 후 재시도. */
export async function sendKakaoToUser(userId: string, text: string, url: string): Promise<{ ok: boolean; reason: string }> {
  const cfg = kakaoConfig();
  if (!cfg) return { ok: false, reason: "카카오 연동 미설정" };
  const db = getDb();
  const link = await db.query.kakaoLinks.findFirst({ where: eq(schema.kakaoLinks.userId, userId) });
  if (!link) return { ok: false, reason: "수신자가 카카오톡을 연결하지 않음(내 계정 → 카카오톡 연결)" };
  const body = (token: string) => {
    const t = text.length > KAKAO_TEXT_MAX ? `${text.slice(0, KAKAO_TEXT_MAX - 1)}…` : text;
    const template = { object_type: "text", text: t, link: { web_url: url, mobile_web_url: url }, button_title: "관제 화면 열기" };
    return fetch(`${cfg.apiBase}/v2/api/talk/memo/default/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
      body: new URLSearchParams({ template_object: JSON.stringify(template) }),
      signal: AbortSignal.timeout(10_000),
    });
  };
  try {
    let token = new Date(link.accessExpiresAt).getTime() - Date.now() < 5 * 60_000 ? await refreshLink(cfg, link) : open(link.accessToken);
    let res = await body(token);
    if (res.status === 401) {
      token = await refreshLink(cfg, link);
      res = await body(token);
    }
    const j = (await res.json().catch(() => ({}))) as { result_code?: number; msg?: string; code?: number };
    if (!res.ok || j.result_code !== 0) throw new Error(`카카오 전송 실패: HTTP ${res.status}${j.code !== undefined ? ` code ${j.code}` : ""}${j.msg ? ` ${j.msg}` : ""}`);
    await db.update(schema.kakaoLinks).set({ lastSentAt: nowIso(), lastError: null }).where(eq(schema.kakaoLinks.userId, userId));
    return { ok: true, reason: "카카오톡(나에게 보내기) 전송" };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    await db.update(schema.kakaoLinks).set({ lastError: msg }).where(eq(schema.kakaoLinks.userId, userId));
    return { ok: false, reason: msg };
  }
}

/**
 * 하루 1회: 리프레시 토큰이 35일 안에 만료되는 연결을 갱신한다(남은 기간 1개월 미만이면 새 리프레시 토큰이 온다).
 * 이렇게 하면 알림이 드문 사용자도 연결이 끊기지 않는다. 실패하면 lastError 에 남기고 화면에 '다시 연결' 을 안내한다.
 */
export async function keepKakaoLinksAlive(): Promise<{ refreshed: number; failed: number }> {
  const cfg = kakaoConfig();
  if (!cfg) return { refreshed: 0, failed: 0 };
  const soon = new Date(Date.now() + 35 * 86_400_000).toISOString();
  const links = await getDb().select().from(schema.kakaoLinks).where(lt(schema.kakaoLinks.refreshExpiresAt, soon));
  let refreshed = 0;
  let failed = 0;
  for (const l of links) {
    try {
      await refreshLink(cfg, l);
      refreshed += 1;
    } catch (e) {
      failed += 1;
      await getDb().update(schema.kakaoLinks).set({ lastError: (e as Error).message.slice(0, 300) }).where(eq(schema.kakaoLinks.userId, l.userId));
    }
  }
  return { refreshed, failed };
}
