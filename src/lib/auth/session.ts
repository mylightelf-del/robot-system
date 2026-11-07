import { createHash } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, desc, eq, gt, lt } from "drizzle-orm";
import type { SessionKind, User } from "@/lib/domain/types";
import { getDb, schema } from "@/lib/db/client";
import { getUser } from "@/lib/db/repo";
import { randomToken } from "./password";
import { addMinutes, nowIso } from "@/lib/util/time";

/**
 * 서버 세션 (2단계 → 앱 지원으로 확장).
 * - 사용자에게 주는 것은 무작위 토큰이고, DB 에는 그 SHA-256 해시만 id 로 저장한다(DB 가 유출돼도 토큰을 재사용할 수 없다).
 * - 웹은 쿠키(httpOnly, sameSite=lax, 운영에서는 secure), 앱은 `Authorization: Bearer <토큰>` 헤더로 보낸다.
 * - 종류별 만료: web = 유휴 SESSION_IDLE_HOURS(12h)·절대 SESSION_ABSOLUTE_DAYS(30d), app = 유휴 APP_SESSION_IDLE_DAYS(30d)·절대 APP_SESSION_ABSOLUTE_DAYS(180d).
 * - 사용자 비활성화·삭제 시 세션이 즉시 무효가 되도록 매 요청 DB 에서 사용자 상태를 읽는다.
 */
export const SESSION_COOKIE = "rc_session";

export interface SessionInfo {
  id: string; // 토큰 해시
  userId: string;
  kind: SessionKind;
  deviceName: string;
  userAgent: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
}

export interface AuthContext {
  user: User;
  session: SessionInfo;
}

function idleMinutes(kind: SessionKind): number {
  return kind === "app" ? Number(process.env.APP_SESSION_IDLE_DAYS ?? 30) * 24 * 60 : Number(process.env.SESSION_IDLE_HOURS ?? 12) * 60;
}
function absoluteMinutes(kind: SessionKind): number {
  return (kind === "app" ? Number(process.env.APP_SESSION_ABSOLUTE_DAYS ?? 180) : Number(process.env.SESSION_ABSOLUTE_DAYS ?? 30)) * 24 * 60;
}

export function cookieOptions() {
  return { path: "/", httpOnly: true, sameSite: "lax" as const, secure: process.env.APP_ENV === "production" };
}

/** 토큰 → DB id. 토큰 원문은 저장하지 않는다. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** User-Agent 를 "브라우저 · OS" 정도로 줄인다(기기 목록 표시용, 정확도보다 식별이 목적). */
export function describeUserAgent(ua: string): string {
  const u = ua || "";
  const os = /Android/i.test(u) ? "Android" : /iPhone|iPad/i.test(u) ? "iOS" : /Windows/i.test(u) ? "Windows" : /Mac OS X/i.test(u) ? "macOS" : /Linux/i.test(u) ? "Linux" : "";
  const browser = /Edg\//.test(u) ? "Edge" : /SamsungBrowser/.test(u) ? "삼성 인터넷" : /Chrome\//.test(u) ? "Chrome" : /Safari\//.test(u) ? "Safari" : /Firefox\//.test(u) ? "Firefox" : "";
  const parts = [browser, os].filter(Boolean);
  return parts.length ? parts.join(" · ") : u.slice(0, 40) || "알 수 없는 기기";
}

/** 세션을 만들고 **토큰 원문**을 돌려준다(쿠키 또는 앱에 전달). DB 에는 해시만 남는다. */
export async function createSession(userId: string, userAgent: string, opts: { kind?: SessionKind; deviceName?: string } = {}): Promise<{ token: string; id: string; expiresAt: string }> {
  const db = getDb();
  const now = nowIso();
  const kind = opts.kind ?? "web";
  const token = randomToken(32);
  const id = hashToken(token);
  const expiresAt = addMinutes(now, idleMinutes(kind));
  const deviceName = (opts.deviceName?.trim() || describeUserAgent(userAgent)).slice(0, 80);
  await db.insert(schema.sessions).values({ id, userId, kind, deviceName, createdAt: now, expiresAt, lastSeenAt: now, userAgent: userAgent.slice(0, 200) });
  return { token, id, expiresAt };
}

/** 세션 ID(해시)로 삭제. 앱 푸시 기기는 FK cascade 로 함께 지워진다. */
export async function destroySession(sessionId: string): Promise<void> {
  await getDb().delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
}

export async function destroySessionByToken(token: string): Promise<void> {
  await destroySession(hashToken(token));
}

export async function destroyUserSessions(userId: string): Promise<void> {
  await getDb().delete(schema.sessions).where(eq(schema.sessions.userId, userId));
}

export async function purgeExpiredSessions(): Promise<number> {
  const res = await getDb().delete(schema.sessions).where(lt(schema.sessions.expiresAt, nowIso())).returning({ id: schema.sessions.id });
  return res.length;
}

/**
 * 토큰 원문을 검증하고 사용자·세션을 돌려준다. 없거나 만료·비활성이면 null.
 * 웹(쿠키)·앱(Bearer)·테스트가 모두 이 함수를 거친다.
 */
export async function resolveSession(token: string | undefined | null): Promise<AuthContext | null> {
  if (!token) return null;
  const db = getDb();
  const now = nowIso();
  const id = hashToken(token);
  const s = await db.query.sessions.findFirst({ where: and(eq(schema.sessions.id, id), gt(schema.sessions.expiresAt, now)) });
  if (!s) return null;
  if (addMinutes(s.createdAt, absoluteMinutes(s.kind)) < now) {
    await destroySession(id);
    return null;
  }
  const user = await getUser(s.userId, db);
  if (!user || !user.active) return null;
  // 유휴 만료 연장은 5분에 한 번만 기록한다(쓰기 부하 억제).
  if (addMinutes(s.lastSeenAt, 5) < now) {
    await db.update(schema.sessions).set({ lastSeenAt: now, expiresAt: addMinutes(now, idleMinutes(s.kind)) }).where(eq(schema.sessions.id, id));
  }
  return { user, session: { id: s.id, userId: s.userId, kind: s.kind, deviceName: s.deviceName, userAgent: s.userAgent, createdAt: s.createdAt, expiresAt: s.expiresAt, lastSeenAt: s.lastSeenAt } };
}

/** `Authorization: Bearer <토큰>` 헤더에서 토큰을 꺼낸다. 없으면 null. */
export function bearerToken(h: { get(name: string): string | null }): string | null {
  const v = h.get("authorization") ?? "";
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(v.trim());
  return m ? m[1] : null;
}

/**
 * 화면·서버 액션·기존 /api 라우트에서 현재 사용자와 세션. 쿠키를 먼저 보고, 없으면 Bearer 헤더(앱이 지도 이미지·보고서 파일을 받을 때).
 * `/api/app` 은 CSRF 를 피하기 위해 쿠키를 보지 않고 Bearer 만 받는다(src/lib/api/http.ts).
 */
export async function getOptionalAuth(): Promise<AuthContext | null> {
  const jar = await cookies();
  const fromCookie = jar.get(SESSION_COOKIE)?.value;
  if (fromCookie) return resolveSession(fromCookie);
  const h = await headers();
  return resolveSession(bearerToken(h));
}

/** 쿠키/Bearer 의 세션을 검증하고 사용자를 돌려준다. 없거나 만료·비활성이면 null. */
export async function getOptionalUser(): Promise<User | null> {
  return (await getOptionalAuth())?.user ?? null;
}

/** 로그인 필수 화면에서 사용. 세션이 없으면 로그인 화면으로 보낸다. */
export async function getCurrentUser(): Promise<User> {
  return (await getCurrentAuth()).user;
}

export async function getCurrentAuth(): Promise<AuthContext> {
  const ctx = await getOptionalAuth();
  if (!ctx) {
    const h = await headers();
    const path = h.get("x-pathname") ?? "/";
    redirect(`/login?next=${encodeURIComponent(path)}`);
  }
  return ctx;
}

/** 내 세션 목록(기기 목록). 비밀 토큰은 없고 해시 id 만 돌려준다. */
export async function listUserSessions(userId: string): Promise<SessionInfo[]> {
  const rows = await getDb().select().from(schema.sessions).where(and(eq(schema.sessions.userId, userId), gt(schema.sessions.expiresAt, nowIso()))).orderBy(desc(schema.sessions.lastSeenAt));
  return rows.map((s) => ({ id: s.id, userId: s.userId, kind: s.kind, deviceName: s.deviceName, userAgent: s.userAgent, createdAt: s.createdAt, expiresAt: s.expiresAt, lastSeenAt: s.lastSeenAt }));
}
