import { and, eq, gt } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import { createSession, destroySession, destroySessionByToken, destroyUserSessions, listUserSessions, type SessionInfo } from "@/lib/auth/session";
import type { SessionKind, User } from "@/lib/domain/types";
import { hashPassword, validatePasswordPolicy, verifyPassword } from "@/lib/auth/password";
import { addMinutes, nowIso } from "@/lib/util/time";
import { ValidationError } from "@/lib/util/errors";
import { audit } from "./audit";

function maxFailures(): number {
  return Number(process.env.LOGIN_MAX_FAILURES ?? 5);
}
function lockMinutes(): number {
  return Number(process.env.LOGIN_LOCK_MINUTES ?? 15);
}

/** token 은 사용자에게 주는 원문(쿠키·앱 저장), sessionId 는 DB 의 해시 id(기기 목록·감사용). */
export type LoginResult = { ok: true; token: string; sessionId: string; expiresAt: string } | { ok: false; error: string };

export interface LoginOptions {
  /** web(기본) 또는 app. 앱 세션은 만료가 길다. */
  kind?: SessionKind;
  /** 앱이 보낸 기기 이름(예: "Galaxy S24"). 없으면 User-Agent 요약. */
  deviceName?: string;
}

/**
 * 로그인. 실패 사유(없는 계정/틀린 비밀번호/비활성)를 구분해 노출하지 않는다.
 * 연속 실패 시 잠금, 성공·실패·잠금은 감사 기록에 남긴다(입구 web/app 과 기기 포함).
 */
export async function login(emailRaw: string, password: string, userAgent: string, opts: LoginOptions = {}): Promise<LoginResult> {
  const db = getDb();
  const email = emailRaw.trim().toLowerCase();
  const generic = { ok: false as const, error: "이메일 또는 비밀번호가 올바르지 않습니다." };
  if (!email || !password) return generic;
  const u = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
  if (!u) {
    // 타이밍 차이로 계정 존재 여부가 드러나지 않도록 해시 검증 비용을 한 번 소모한다.
    await verifyPassword(password, "scrypt$16384$8$1$00$00");
    return generic;
  }
  const now = nowIso();
  if (u.lockedUntil && u.lockedUntil > now) {
    await audit({ id: u.id, name: u.name }, { siteId: null, robotId: null, action: "AUTH:LOGIN", params: {}, result: "DENIED", detail: "잠금 중", vendorTraceId: null }, db);
    return { ok: false, error: "로그인이 잠시 잠겼습니다. 잠시 후 다시 시도하세요." };
  }
  const okPw = await verifyPassword(password, u.passwordHash);
  if (!okPw || !u.active) {
    const failed = u.failedLogins + 1;
    const lock = failed >= maxFailures();
    await db
      .update(schema.users)
      .set({ failedLogins: lock ? 0 : failed, lockedUntil: lock ? addMinutes(now, lockMinutes()) : null })
      .where(eq(schema.users.id, u.id));
    await audit({ id: u.id, name: u.name }, { siteId: null, robotId: null, action: "AUTH:LOGIN", params: {}, result: "DENIED", detail: !u.active ? "비활성 계정" : lock ? `연속 실패 ${failed}회 — ${lockMinutes()}분 잠금` : `비밀번호 불일치(${failed}회)`, vendorTraceId: null }, db);
    return generic;
  }
  await db.update(schema.users).set({ failedLogins: 0, lockedUntil: null, lastLoginAt: now }).where(eq(schema.users.id, u.id));
  const kind = opts.kind ?? "web";
  const created = await createSession(u.id, userAgent, { kind, deviceName: opts.deviceName });
  await audit({ id: u.id, name: u.name }, { siteId: null, robotId: null, action: "AUTH:LOGIN", params: { channel: kind, sessionId: created.id }, result: "OK", detail: kind === "app" ? `앱 · ${opts.deviceName?.trim() || "기기 이름 없음"}` : null, vendorTraceId: null }, db);
  return { ok: true, token: created.token, sessionId: created.id, expiresAt: created.expiresAt };
}

/** 로그아웃: 토큰 원문으로 그 세션만 지운다(앱 푸시 기기도 함께). */
export async function logout(token: string | undefined, user: { id: string; name: string } | null, kind: SessionKind = "web"): Promise<void> {
  if (token) await destroySessionByToken(token);
  if (user) await audit(user, { siteId: null, robotId: null, action: "AUTH:LOGOUT", params: { channel: kind }, result: "OK", detail: null, vendorTraceId: null });
}

export type SessionRow = SessionInfo & { current: boolean; pushDevices: number };

/** 내 계정의 '로그인된 기기' — 웹·앱 세션 전부. 토큰 원문은 없다. */
export async function listMySessions(user: User, currentSessionId: string | null): Promise<SessionRow[]> {
  const db = getDb();
  const rows = await listUserSessions(user.id);
  const devices = await db.select({ sessionId: schema.pushDevices.sessionId }).from(schema.pushDevices).where(eq(schema.pushDevices.userId, user.id));
  return rows.map((s) => ({ ...s, current: s.id === currentSessionId, pushDevices: devices.filter((d) => d.sessionId === s.id).length }));
}

/** 내 기기 끊기(그 세션만). 다른 사람의 세션은 지울 수 없다. */
export async function revokeMySession(user: User, sessionId: string): Promise<void> {
  const db = getDb();
  const s = await db.query.sessions.findFirst({ where: and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, user.id)) });
  if (!s) throw new ValidationError("해당 기기(세션)를 찾을 수 없습니다.");
  await destroySession(sessionId);
  await audit(user, { siteId: null, robotId: null, action: "AUTH:REVOKE_SESSION", params: { sessionId, channel: s.kind, device: s.deviceName }, result: "OK", detail: null, vendorTraceId: null }, db);
}

export async function getInviteInfo(token: string): Promise<{ name: string; email: string } | null> {
  if (!token) return null;
  const u = await getDb().query.users.findFirst({ where: and(eq(schema.users.inviteToken, token), gt(schema.users.inviteExpiresAt, nowIso()), eq(schema.users.active, true)) });
  return u ? { name: u.name, email: u.email } : null;
}

/** 초대 링크로 비밀번호 설정. 토큰은 1회용이며 설정 즉시 무효화된다. */
export async function acceptInvite(token: string, password: string, password2: string): Promise<void> {
  const db = getDb();
  if (password !== password2) throw new ValidationError("비밀번호 확인이 일치하지 않습니다.");
  const policy = validatePasswordPolicy(password);
  if (policy) throw new ValidationError(policy);
  const u = await db.query.users.findFirst({ where: and(eq(schema.users.inviteToken, token), gt(schema.users.inviteExpiresAt, nowIso()), eq(schema.users.active, true)) });
  if (!u) throw new ValidationError("초대 링크가 만료되었거나 유효하지 않습니다. 본사 관리자에게 재발급을 요청하세요.");
  await db.update(schema.users).set({ passwordHash: await hashPassword(password), inviteToken: null, inviteExpiresAt: null, failedLogins: 0, lockedUntil: null }).where(eq(schema.users.id, u.id));
  await destroyUserSessions(u.id);
  await audit({ id: u.id, name: u.name }, { siteId: null, robotId: null, action: "AUTH:SET_PASSWORD", params: {}, result: "OK", detail: "초대 링크 사용", vendorTraceId: null }, db);
}

/** 로그인 사용자의 비밀번호 변경. */
export async function changePassword(user: { id: string; name: string }, current: string, next: string, next2: string): Promise<void> {
  const db = getDb();
  const u = await db.query.users.findFirst({ where: eq(schema.users.id, user.id) });
  if (!u || !(await verifyPassword(current, u.passwordHash))) throw new ValidationError("현재 비밀번호가 올바르지 않습니다.");
  if (next !== next2) throw new ValidationError("새 비밀번호 확인이 일치하지 않습니다.");
  const policy = validatePasswordPolicy(next);
  if (policy) throw new ValidationError(policy);
  await db.update(schema.users).set({ passwordHash: await hashPassword(next) }).where(eq(schema.users.id, u.id));
  await audit(user, { siteId: null, robotId: null, action: "AUTH:CHANGE_PASSWORD", params: {}, result: "OK", detail: null, vendorTraceId: null }, db);
}
