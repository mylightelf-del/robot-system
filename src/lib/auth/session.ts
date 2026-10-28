import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt, lt } from "drizzle-orm";
import type { User } from "@/lib/domain/types";
import { getDb, schema } from "@/lib/db/client";
import { getUser } from "@/lib/db/repo";
import { randomToken } from "./password";
import { addMinutes, nowIso } from "@/lib/util/time";

/**
 * 서버 세션 (2단계).
 * - 세션 ID 는 무작위 토큰이며 DB sessions 테이블에 저장한다. 쿠키에는 ID 만 담는다(httpOnly, sameSite=lax, 운영에서는 secure).
 * - 유휴 만료(SESSION_IDLE_HOURS)와 절대 만료(SESSION_ABSOLUTE_DAYS)를 함께 적용한다.
 * - 사용자 비활성화·삭제 시 세션이 즉시 무효가 되도록 매 요청 DB 에서 사용자 상태를 읽는다.
 */
export const SESSION_COOKIE = "rc_session";

function idleHours(): number {
  return Number(process.env.SESSION_IDLE_HOURS ?? 12);
}
function absoluteDays(): number {
  return Number(process.env.SESSION_ABSOLUTE_DAYS ?? 30);
}

export function cookieOptions() {
  return { path: "/", httpOnly: true, sameSite: "lax" as const, secure: process.env.APP_ENV === "production" };
}

export async function createSession(userId: string, userAgent: string): Promise<string> {
  const db = getDb();
  const now = nowIso();
  const id = randomToken(32);
  await db.insert(schema.sessions).values({ id, userId, createdAt: now, expiresAt: addMinutes(now, idleHours() * 60), lastSeenAt: now, userAgent: userAgent.slice(0, 200) });
  return id;
}

export async function destroySession(sessionId: string): Promise<void> {
  await getDb().delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
}

export async function destroyUserSessions(userId: string): Promise<void> {
  await getDb().delete(schema.sessions).where(eq(schema.sessions.userId, userId));
}

export async function purgeExpiredSessions(): Promise<number> {
  const res = await getDb().delete(schema.sessions).where(lt(schema.sessions.expiresAt, nowIso())).returning({ id: schema.sessions.id });
  return res.length;
}

/** 쿠키의 세션을 검증하고 사용자를 돌려준다. 없거나 만료·비활성이면 null. */
export async function getOptionalUser(): Promise<User | null> {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  if (!id) return null;
  const db = getDb();
  const now = nowIso();
  const s = await db.query.sessions.findFirst({ where: and(eq(schema.sessions.id, id), gt(schema.sessions.expiresAt, now)) });
  if (!s) return null;
  if (addMinutes(s.createdAt, absoluteDays() * 24 * 60) < now) {
    await destroySession(id);
    return null;
  }
  const user = await getUser(s.userId, db);
  if (!user || !user.active) return null;
  // 유휴 만료 연장은 5분에 한 번만 기록한다(쓰기 부하 억제).
  if (addMinutes(s.lastSeenAt, 5) < now) {
    await db.update(schema.sessions).set({ lastSeenAt: now, expiresAt: addMinutes(now, idleHours() * 60) }).where(eq(schema.sessions.id, id));
  }
  return user;
}

/** 로그인 필수 화면에서 사용. 세션이 없으면 로그인 화면으로 보낸다. */
export async function getCurrentUser(): Promise<User> {
  const user = await getOptionalUser();
  if (!user) {
    const h = await headers();
    const path = h.get("x-pathname") ?? "/";
    redirect(`/login?next=${encodeURIComponent(path)}`);
  }
  return user;
}
