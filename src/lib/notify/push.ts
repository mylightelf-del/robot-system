import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, isNull } from "drizzle-orm";
import type { User } from "@/lib/domain/types";
import { getDb, schema } from "@/lib/db/client";
import { ValidationError } from "@/lib/util/errors";
import { newId } from "@/lib/util/random";
import { nowIso } from "@/lib/util/time";

/**
 * 앱 푸시 — Firebase Cloud Messaging(FCM) HTTP v1.
 * - 설정: FCM_SERVICE_ACCOUNT_JSON(서비스 계정 키 JSON 원문 또는 base64) 또는 FCM_SERVICE_ACCOUNT_FILE(파일 경로). 둘 다 없으면 모의(mock).
 *   키는 서버 .env/파일에만 둔다(저장소·대화·로그 금지). 앱에 들어가는 google-services.json 은 비밀값이 아니다.
 * - 발송: 서비스 계정 JWT(RS256) → OAuth2 액세스 토큰 → projects/{id}/messages:send. 외부 패키지 없이 Node crypto 로 서명한다.
 * - 알림창에는 제목·한 줄 요약만 싣고 본문은 앱이 열려서 서버에서 다시 받는다(고객 계정에 원시 오류가 새지 않게). data 로 kind·refId·siteId 를 실어 딥링크한다.
 * - FCM 이 UNREGISTERED/INVALID_ARGUMENT(토큰 무효)를 돌려주면 그 기기를 비활성 처리한다.
 * - 시험용: FCM_API_BASE / FCM_OAUTH_TOKEN_URL 로 모의 서버를 가리킬 수 있다.
 */
export interface PushConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  apiBase: string;
  tokenUrl: string;
}

let cachedKey: { raw: string; parsed: PushConfig | null } | null = null;

export function pushConfig(): PushConfig | null {
  let raw = process.env.FCM_SERVICE_ACCOUNT_JSON || "";
  if (!raw && process.env.FCM_SERVICE_ACCOUNT_FILE) {
    try {
      raw = readFileSync(process.env.FCM_SERVICE_ACCOUNT_FILE, "utf8");
    } catch {
      return null;
    }
  }
  if (!raw) return null;
  const apiBase = (process.env.FCM_API_BASE || "https://fcm.googleapis.com").replace(/\/$/, "");
  const tokenUrl = process.env.FCM_OAUTH_TOKEN_URL || "https://oauth2.googleapis.com/token";
  if (cachedKey?.raw === raw && cachedKey.parsed) return { ...cachedKey.parsed, apiBase, tokenUrl };
  try {
    const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    const j = JSON.parse(text) as { project_id?: string; client_email?: string; private_key?: string };
    if (!j.project_id || !j.client_email || !j.private_key) throw new Error("필수 필드 없음");
    const parsed = { projectId: j.project_id, clientEmail: j.client_email, privateKey: j.private_key.replace(/\\n/g, "\n"), apiBase, tokenUrl };
    cachedKey = { raw, parsed };
    return parsed;
  } catch {
    cachedKey = { raw, parsed: null };
    return null;
  }
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

let tokenCache: { token: string; expiresAt: number; key: string } | null = null;

/** 서비스 계정으로 OAuth2 액세스 토큰(만료 1시간, 60초 전 갱신). */
export async function fcmAccessToken(cfg: PushConfig): Promise<string> {
  const cacheKey = cfg.clientEmail + cfg.tokenUrl;
  if (tokenCache && tokenCache.key === cacheKey && tokenCache.expiresAt - 60_000 > Date.now()) return tokenCache.token;
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: cfg.clientEmail, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: cfg.tokenUrl, iat, exp: iat + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${b64url(signer.sign(cfg.privateKey))}`;
  const res = await fetch(cfg.tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }) });
  if (!res.ok) throw new Error(`FCM 토큰 발급 실패 HTTP ${res.status}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: j.access_token, expiresAt: Date.now() + j.expires_in * 1000, key: cacheKey };
  return j.access_token;
}

export interface PushMessage {
  title: string;
  body: string;
  /** 딥링크용. 값은 문자열만(FCM data 제약). */
  data: Record<string, string>;
}

export type DeviceRow = typeof schema.pushDevices.$inferSelect;

/** 사용자의 활성 기기(비활성 처리되지 않은 것). */
export async function activeDevicesOf(userId: string): Promise<DeviceRow[]> {
  return getDb().select().from(schema.pushDevices).where(and(eq(schema.pushDevices.userId, userId), isNull(schema.pushDevices.disabledAt)));
}

/** 토큰 한 개로 발송. 무효 토큰이면 invalid=true(호출자가 기기를 비활성 처리). */
async function sendOne(cfg: PushConfig, accessToken: string, deviceToken: string, m: PushMessage): Promise<{ ok: boolean; invalid: boolean; reason: string }> {
  const body = {
    message: {
      token: deviceToken,
      notification: { title: m.title.slice(0, 100), body: m.body.slice(0, 200) },
      data: m.data,
      android: { priority: "HIGH", notification: { channel_id: "alerts", sound: "default" } },
      apns: { payload: { aps: { sound: "default" } } },
    },
  };
  const res = await fetch(`${cfg.apiBase}/v1/projects/${encodeURIComponent(cfg.projectId)}/messages:send`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (res.ok) return { ok: true, invalid: false, reason: "FCM 접수" };
  let detail = "";
  try {
    const j = (await res.json()) as { error?: { status?: string; message?: string; details?: { errorCode?: string }[] } };
    const code = j.error?.details?.find((d) => d.errorCode)?.errorCode ?? j.error?.status ?? "";
    detail = `${code}${j.error?.message ? ` ${j.error.message}` : ""}`.trim();
  } catch {
    detail = `HTTP ${res.status}`;
  }
  const invalid = res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/i.test(detail);
  return { ok: false, invalid, reason: `FCM 오류 HTTP ${res.status} ${detail}`.slice(0, 200) };
}

/**
 * 사용자 본인의 모든 활성 기기로 푸시. 결과는 한 줄 요약(알림 기록용).
 * 기기가 없으면 실패로 돌려준다(수신자 설정은 있으나 앱 로그인이 없는 경우를 운영자가 알 수 있게).
 */
export async function sendPushToUser(userId: string, m: PushMessage): Promise<{ ok: boolean; reason: string }> {
  const cfg = pushConfig();
  if (!cfg) return { ok: false, reason: "FCM 설정 없음" };
  const devices = await activeDevicesOf(userId);
  if (devices.length === 0) return { ok: false, reason: "등록된 앱 기기 없음(앱에서 로그인·알림 허용 필요)" };
  const db = getDb();
  let accessToken: string;
  try {
    accessToken = await fcmAccessToken(cfg);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  let sent = 0;
  const failures: string[] = [];
  for (const d of devices) {
    const r = await sendOne(cfg, accessToken, d.token, m);
    if (r.ok) {
      sent += 1;
      await db.update(schema.pushDevices).set({ lastSeenAt: nowIso(), lastError: null }).where(eq(schema.pushDevices.id, d.id));
    } else {
      failures.push(`${d.deviceName || d.platform}: ${r.reason}`);
      await db.update(schema.pushDevices).set({ lastError: r.reason, ...(r.invalid ? { disabledAt: nowIso() } : {}) }).where(eq(schema.pushDevices.id, d.id));
    }
  }
  if (sent === 0) return { ok: false, reason: failures.join("; ").slice(0, 250) };
  return { ok: true, reason: `기기 ${sent}대 발송${failures.length ? `, 실패 ${failures.length}대` : ""}` };
}

// ---- 기기 등록(앱이 호출) ----

export interface RegisterDeviceInput {
  token: string;
  platform: "android" | "ios";
  appVersion?: string;
  deviceName?: string;
}

/** FCM 등록 토큰을 현재 앱 세션에 묶어 저장한다. 같은 토큰이 다른 사용자/세션에 있으면 현재 것으로 옮긴다(폰 공유·재로그인). */
export async function registerDevice(user: User, sessionId: string, input: RegisterDeviceInput): Promise<DeviceRow> {
  const token = (input.token ?? "").trim();
  if (token.length < 20 || token.length > 4096) throw new ValidationError("푸시 토큰이 올바르지 않습니다.");
  if (input.platform !== "android" && input.platform !== "ios") throw new ValidationError("platform 은 android 또는 ios 여야 합니다.");
  const db = getDb();
  const now = nowIso();
  const values = { userId: user.id, sessionId, token, platform: input.platform, appVersion: (input.appVersion ?? "").slice(0, 40), deviceName: (input.deviceName ?? "").slice(0, 80), lastSeenAt: now, disabledAt: null, lastError: null };
  const existing = await db.query.pushDevices.findFirst({ where: eq(schema.pushDevices.token, token) });
  if (existing) {
    await db.update(schema.pushDevices).set(values).where(eq(schema.pushDevices.id, existing.id));
    return (await db.query.pushDevices.findFirst({ where: eq(schema.pushDevices.id, existing.id) }))!;
  }
  const row = { id: newId("dev"), createdAt: now, ...values };
  await db.insert(schema.pushDevices).values(row);
  return row;
}

/** 앱이 알림을 끄거나 로그아웃 전에 호출. 내 토큰만 지울 수 있다. */
export async function unregisterDevice(user: User, token: string): Promise<boolean> {
  const res = await getDb().delete(schema.pushDevices).where(and(eq(schema.pushDevices.userId, user.id), eq(schema.pushDevices.token, token))).returning({ id: schema.pushDevices.id });
  return res.length > 0;
}

export async function listMyDevices(user: User): Promise<Omit<DeviceRow, "token">[]> {
  const rows = await getDb().select().from(schema.pushDevices).where(eq(schema.pushDevices.userId, user.id));
  return rows.map(({ token: _t, ...rest }) => rest);
}

export async function hasActiveDevice(userId: string): Promise<boolean> {
  return (await activeDevicesOf(userId)).length > 0;
}
