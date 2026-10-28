import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { acceptInvite, changePassword, getInviteInfo, login } from "@/lib/services/auth";
import { createUser, reissueInvite, setUserActive } from "@/lib/services/admin";
import { purgeExpiredSessions } from "@/lib/auth/session";
import { addMinutes, nowIso } from "@/lib/util/time";
import { getDb, resetAndSeed, SAMPLE_PASSWORD, schema, user } from "./helpers";

const db = () => getDb();

describe("인증: 로그인·잠금·초대·세션", () => {
  beforeEach(async () => {
    await resetAndSeed();
  });

  it("올바른 이메일·비밀번호로 로그인하면 세션이 생성된다", async () => {
    const r = await login("hq-admin@example.invalid", SAMPLE_PASSWORD, "vitest");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const s = await db().query.sessions.findFirst({ where: eq(schema.sessions.id, r.sessionId) });
      expect(s?.userId).toBe("u-hq");
    }
    const logs = await db().select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "AUTH:LOGIN"));
    expect(logs.some((l) => l.userId === "u-hq" && l.result === "OK")).toBe(true);
  });

  it("틀린 비밀번호·없는 계정·비활성 계정은 같은 메시지로 거부된다", async () => {
    const a = await login("hq-admin@example.invalid", "wrong-password-1", "vitest");
    const b = await login("nobody@example.invalid", "wrong-password-1", "vitest");
    const c = await login("former@example.invalid", SAMPLE_PASSWORD, "vitest");
    expect(a.ok && b.ok && c.ok).toBe(false);
    expect(!a.ok && !b.ok && a.error === b.error).toBe(true);
    expect(!c.ok && c.error === (a as { error: string }).error).toBe(true);
  });

  it("연속 실패 시 잠금되고, 잠금 중에는 올바른 비밀번호도 거부된다", async () => {
    process.env.LOGIN_MAX_FAILURES = "3";
    for (let i = 0; i < 3; i += 1) await login("site-a@example.invalid", "bad-password-1", "vitest");
    const locked = await login("site-a@example.invalid", SAMPLE_PASSWORD, "vitest");
    expect(locked.ok).toBe(false);
    expect(!locked.ok && locked.error).toContain("잠겼");
    delete process.env.LOGIN_MAX_FAILURES;
  });

  it("초대 링크로 비밀번호를 설정하면 로그인할 수 있고, 링크는 1회용이다", async () => {
    const hq = await user("u-hq");
    const { inviteLink } = await createUser(hq, { name: "신규 현장", email: "new-site@example.invalid", role: "SITE_MANAGER", siteIds: ["site-01"], allowedCommands: [] });
    const token = inviteLink.split("/invite/")[1];
    expect((await getInviteInfo(token))?.email).toBe("new-site@example.invalid");
    // 비밀번호 설정 전에는 로그인 불가
    expect((await login("new-site@example.invalid", "whatever123", "vitest")).ok).toBe(false);
    await expect(acceptInvite(token, "short1", "short1")).rejects.toThrow(/10자/);
    await acceptInvite(token, "NewPassword123", "NewPassword123");
    expect(await getInviteInfo(token)).toBeNull(); // 1회용
    expect((await login("new-site@example.invalid", "NewPassword123", "vitest")).ok).toBe(true);
  });

  it("초대 재발급은 기존 세션을 모두 종료하고 새 토큰을 만든다", async () => {
    const hq = await user("u-hq");
    const r = await login("site-b@example.invalid", SAMPLE_PASSWORD, "vitest");
    expect(r.ok).toBe(true);
    const link = await reissueInvite(hq, "u-site-b");
    expect(link).toContain("/invite/");
    const sessions = await db().select().from(schema.sessions).where(eq(schema.sessions.userId, "u-site-b"));
    expect(sessions.length).toBe(0);
  });

  it("비활성화하면 세션이 즉시 종료된다", async () => {
    const hq = await user("u-hq");
    const r = await login("customer1@example.invalid", SAMPLE_PASSWORD, "vitest");
    expect(r.ok).toBe(true);
    await setUserActive(hq, "u-cust-1", false);
    const sessions = await db().select().from(schema.sessions).where(eq(schema.sessions.userId, "u-cust-1"));
    expect(sessions.length).toBe(0);
    expect((await login("customer1@example.invalid", SAMPLE_PASSWORD, "vitest")).ok).toBe(false);
  });

  it("만료 세션은 정리된다", async () => {
    const r = await login("hq-admin@example.invalid", SAMPLE_PASSWORD, "vitest");
    if (!r.ok) throw new Error("login failed");
    await db().update(schema.sessions).set({ expiresAt: addMinutes(nowIso(), -1) }).where(eq(schema.sessions.id, r.sessionId));
    expect(await purgeExpiredSessions()).toBeGreaterThanOrEqual(1);
  });

  it("비밀번호 변경은 현재 비밀번호 확인과 정책을 거친다", async () => {
    const me = { id: "u-hq", name: "김본사" };
    await expect(changePassword(me, "wrong-1", "NewPassword123", "NewPassword123")).rejects.toThrow(/현재 비밀번호/);
    await expect(changePassword(me, SAMPLE_PASSWORD, "onlyletters", "onlyletters")).rejects.toThrow(/영문과 숫자/);
    await changePassword(me, SAMPLE_PASSWORD, "NewPassword123", "NewPassword123");
    expect((await login("hq-admin@example.invalid", "NewPassword123", "vitest")).ok).toBe(true);
  });
});
