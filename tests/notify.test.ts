import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { open, seal } from "@/lib/util/secretBox";
import { setEmailSenderForTest } from "@/lib/notify/email";
import { keepKakaoLinksAlive, linkKakao, sendKakaoToUser } from "@/lib/notify/kakao";
import { channelModes, deliver, notifyIncident } from "@/lib/notify/notifier";
import { escalateOverdueIncidents, simulateIncident } from "@/lib/services/incidents";
import { addRecipient } from "@/lib/services/admin";
import { testSelf } from "@/lib/services/notify";
import { getNotificationSetting } from "@/lib/db/repo";
import { ValidationError } from "@/lib/util/errors";
import { addMinutes, nowIso } from "@/lib/util/time";
import { getDb, resetAndSeed, schema, user } from "./helpers";

/** 카카오 모의 서버(공식 문서의 경로·파라미터 그대로). */
type KState = { tokens: number; sent: { auth: string; template: Record<string, unknown> }[]; expireNext: boolean; refreshCalls: number; giveNewRefresh: boolean };
function startKakao(state: KState): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/oauth/token") {
      if (form.get("client_id") !== "rest-key" || form.get("client_secret") !== "secret") return send(401, { error: "invalid_client" });
      if (form.get("grant_type") === "authorization_code") {
        if (form.get("code") !== "good-code" || !form.get("redirect_uri")?.endsWith("/api/kakao/callback")) return send(400, { error: "invalid_grant" });
        state.tokens += 1;
        return send(200, { token_type: "bearer", access_token: `at-${state.tokens}`, expires_in: 43199, refresh_token: "rt-1", refresh_token_expires_in: 20 * 86400 });
      }
      if (form.get("grant_type") === "refresh_token") {
        state.refreshCalls += 1;
        state.tokens += 1;
        return send(200, { token_type: "bearer", access_token: `at-${state.tokens}`, expires_in: 43199, ...(state.giveNewRefresh ? { refresh_token: "rt-2", refresh_token_expires_in: 60 * 86400 } : {}) });
      }
    }
    if (url.pathname === "/v1/user/access_token_info") return send(200, { id: 123456789, expires_in: 43000, app_id: 1 });
    if (url.pathname === "/v2/api/talk/memo/default/send") {
      if (state.expireNext) {
        state.expireNext = false;
        return send(401, { msg: "this access token does not exist", code: -401 });
      }
      state.sent.push({ auth: String(req.headers.authorization), template: JSON.parse(form.get("template_object") ?? "{}") });
      return send(200, { result_code: 0 });
    }
    send(404, {});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise((r) => server.close(() => r())) })));
}

describe("알림 발송(이메일·카카오톡)", () => {
  const db = () => getDb();
  const kstate: KState = { tokens: 0, sent: [], expireNext: false, refreshCalls: 0, giveNewRefresh: true };
  let kakao: Awaited<ReturnType<typeof startKakao>>;
  const saved = { ...process.env };

  beforeAll(async () => {
    kakao = await startKakao(kstate);
  });
  afterAll(async () => {
    await kakao.close();
    process.env = saved;
    setEmailSenderForTest(null);
  });
  beforeEach(async () => {
    await resetAndSeed();
    Object.assign(kstate, { tokens: 0, sent: [], expireNext: false, refreshCalls: 0, giveNewRefresh: true });
    process.env.APP_BASE_URL = "https://widebot.example";
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.KAKAO_REST_API_KEY = "rest-key";
    process.env.KAKAO_CLIENT_SECRET = "secret";
    process.env.KAKAO_AUTH_BASE = kakao.url;
    process.env.KAKAO_API_BASE = kakao.url;
    delete process.env.MAIL_MODE;
    setEmailSenderForTest(null);
  });

  it("토큰 암호화: 왕복, 위조·다른 키 거부", () => {
    const s = seal("secret-token");
    expect(s.startsWith("v1:")).toBe(true);
    expect(s).not.toContain("secret-token");
    expect(open(s)).toBe("secret-token");
    const parts = s.split(":");
    expect(() => open([parts[0], parts[1], parts[2], Buffer.from("x").toString("base64")].join(":"))).toThrow();
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    expect(() => open(s)).toThrow();
  });

  it("이메일: 설정 전 모의, live 설정이면 발송(SENT), 공급사 오류는 FAILED", async () => {
    expect(channelModes().EMAIL).toBe("mock");
    expect((await deliver({ channel: "EMAIL", address: "a@b.c" }, { subject: "s", title: "t", lines: ["사업장: x"], url: "https://x" })).status).toBe("MOCK_SENT");
    Object.assign(process.env, { MAIL_MODE: "live", MAIL_FROM: "관제 <noreply@widebot.kro.kr>", SES_ACCESS_KEY_ID: "AKIA-TEST", SES_SECRET_ACCESS_KEY: "x" });
    const sent: { to: string; subject: string; html: string }[] = [];
    setEmailSenderForTest(async (m) => {
      sent.push(m);
      return { messageId: "0100018c-test" };
    });
    expect(channelModes().EMAIL).toBe("live");
    const ok = await deliver({ channel: "EMAIL", address: "ops@example.com" }, { subject: "[장애] <x>", title: "제목", lines: ["사업장: <A&B>"], url: "https://widebot.example/incidents" });
    expect(ok.status).toBe("SENT");
    expect(sent[0].to).toBe("ops@example.com");
    expect(sent[0].html).toContain("&lt;A&amp;B&gt;"); // HTML 이스케이프
    setEmailSenderForTest(async () => {
      throw Object.assign(new Error("Email address is not verified."), { name: "MessageRejected" });
    });
    const bad = await deliver({ channel: "EMAIL", address: "x@example.com" }, { subject: "s", title: "t", lines: [], url: "https://x" });
    expect(bad).toMatchObject({ status: "FAILED" });
    expect(bad.reason).toContain("MessageRejected");
    // 보내는 도메인이 아직 확인 전이면 대체 주소로 한 번 더 보낸다
    process.env.MAIL_FROM_FALLBACK = "관제 <fallback@gmail.example>";
    const froms: string[] = [];
    setEmailSenderForTest(async (m) => {
      froms.push(m.from);
      if (m.from.includes("noreply@widebot.kro.kr")) throw Object.assign(new Error("Email address is not verified. The following identities failed the check in region AP-SOUTHEAST-2: noreply@widebot.kro.kr"), { name: "MessageRejected" });
      return { messageId: "fallback-id" };
    });
    const fb = await deliver({ channel: "EMAIL", address: "ops@example.com" }, { subject: "s", title: "t", lines: [], url: "https://x" });
    expect(fb.status).toBe("SENT");
    expect(fb.reason).toContain("대체 주소");
    expect(froms).toEqual(["관제 <noreply@widebot.kro.kr>", "관제 <fallback@gmail.example>"]);
    delete process.env.MAIL_FROM_FALLBACK;
  });

  it("카카오톡: 연결(토큰 암호화 저장) → 나에게 보내기(200자·링크) → 401 이면 갱신 후 재시도 → 연결 유지 갱신", async () => {
    const hq = await user("u-hq");
    await expect(linkKakao(hq.id, "bad-code")).rejects.toThrow(/카카오 토큰 오류/);
    const r = await linkKakao(hq.id, "good-code");
    expect(r.kakaoUserId).toBe("123456789");
    const row = (await db().query.kakaoLinks.findFirst({ where: eq(schema.kakaoLinks.userId, hq.id) }))!;
    expect(row.accessToken).not.toContain("at-1"); // 평문 저장 안 함
    expect(open(row.accessToken)).toBe("at-1");

    const long = "가".repeat(300);
    const s1 = await sendKakaoToUser(hq.id, long, "https://widebot.example/incidents");
    expect(s1.ok).toBe(true);
    expect(kstate.sent[0].auth).toBe("Bearer at-1");
    expect(kstate.sent[0].template).toMatchObject({ object_type: "text", link: { web_url: "https://widebot.example/incidents", mobile_web_url: "https://widebot.example/incidents" } });
    expect(String(kstate.sent[0].template.text).length).toBe(200);

    kstate.expireNext = true;
    kstate.giveNewRefresh = false; // 남은 기간이 1개월 이상이면 새 리프레시 토큰이 오지 않는다(공식 문서)
    const s2 = await sendKakaoToUser(hq.id, "두 번째", "https://widebot.example/");
    expect(s2.ok).toBe(true);
    expect(kstate.refreshCalls).toBe(1);
    expect(kstate.sent[1].auth).toBe("Bearer at-2");

    // 리프레시 토큰 남은 기간 20일 → 하루 1회 연결 유지에서 갱신, 새 리프레시 토큰 저장
    kstate.giveNewRefresh = true;
    const k = await keepKakaoLinksAlive();
    expect(k).toEqual({ refreshed: 1, failed: 0 });
    const after = (await db().query.kakaoLinks.findFirst({ where: eq(schema.kakaoLinks.userId, hq.id) }))!;
    expect(open(after.refreshToken)).toBe("rt-2");
    expect(new Date(after.refreshExpiresAt!).getTime()).toBeGreaterThan(Date.now() + 50 * 86400_000);

    // 연결하지 않은 사용자는 실패로 기록, 전화번호 수신은 모의
    expect((await deliver({ channel: "KAKAO", address: "user:u-site-a" }, { subject: "s", title: "t", lines: [], url: "https://x" })).status).toBe("FAILED");
    expect((await deliver({ channel: "KAKAO", address: "010-0000-0000" }, { subject: "s", title: "t", lines: [], url: "https://x" })).status).toBe("MOCK_SENT");
    // 내 카카오톡 시험 발송
    expect((await testSelf(hq, "KAKAO")).status).toBe("SENT");
  });

  it("수신자 추가 검증: 이메일 형식, 카카오톡은 활성 사용자", async () => {
    const hq = await user("u-hq");
    await expect(addRecipient(hq, "site-01", { channel: "EMAIL", address: "not-an-email", minSeverity: "HIGH", hoursFrom: "00:00", hoursTo: "23:59" })).rejects.toThrow(ValidationError);
    await expect(addRecipient(hq, "site-01", { channel: "KAKAO", address: "user:u-inactive", minSeverity: "HIGH", hoursFrom: "00:00", hoursTo: "23:59" })).rejects.toThrow(ValidationError);
    await addRecipient(hq, "site-01", { channel: "KAKAO", address: "user:u-hq", minSeverity: "HIGH", hoursFrom: "00:00", hoursTo: "23:59" });
  });

  it("장애 발생 알림 → 카카오톡 실제 발송, 미조치 확대 통보는 한 번만·최근 24시간 장애만", async () => {
    const hq = await user("u-hq");
    await linkKakao(hq.id, "good-code");
    await db().delete(schema.notificationRecipients).where(eq(schema.notificationRecipients.siteId, "site-01"));
    await addRecipient(hq, "site-01", { channel: "KAKAO", address: `user:${hq.id}`, minSeverity: "HIGH", hoursFrom: "00:00", hoursTo: "23:59" });
    const inc = (await simulateIncident(hq, "PW-R-001", "BRUSH_MOTOR", "HIGH", "esc-1"))!;
    expect(inc.notifications.map((n) => n.status)).toEqual(["SENT"]);
    expect(String(kstate.sent[0].template.text)).toContain("[장애 발생]");
    // 확대 통보: 사업장 기준 시간(60분) 전에는 없음, 지나면 1회(샘플의 다른 미조치 장애도 함께 처리되므로 이 장애의 기록으로 확인)
    const escalations = async () => (await db().select().from(schema.notificationLogs).where(eq(schema.notificationLogs.incidentId, inc.id))).filter((n) => n.reason.startsWith("미조치 확대 통보")).length;
    await escalateOverdueIncidents(addMinutes(nowIso(), 30));
    expect(await escalations()).toBe(0);
    await escalateOverdueIncidents(addMinutes(nowIso(), 90));
    expect(await escalations()).toBe(1);
    await escalateOverdueIncidents(addMinutes(nowIso(), 120));
    expect(await escalations()).toBe(1);
    expect(String(kstate.sent.at(-1)!.template.text)).toContain("미조치 확대 통보");
    // 24시간보다 오래된 장애는 확대 통보하지 않음(배포 직후 몰아서 보내지 않도록)
    const inc2 = (await simulateIncident(hq, "PW-R-002", "BRUSH_MOTOR", "HIGH", "esc-2"))!;
    await escalateOverdueIncidents(addMinutes(nowIso(), 60 * 30));
    expect((await db().select().from(schema.notificationLogs).where(eq(schema.notificationLogs.incidentId, inc2.id))).filter((n) => n.reason.startsWith("미조치 확대 통보")).length).toBe(0);
    const setting = await getNotificationSetting("site-01");
    expect(setting!.recipients.length).toBe(1);
    // 등급 미달로 억제되는 확대 통보도 한 번만 기록(5분마다 쌓이지 않음)
    const med = (await simulateIncident(hq, "PW-R-002", "OBSTACLE_STUCK", "MEDIUM", "esc-med"))!;
    await escalateOverdueIncidents(addMinutes(nowIso(), 90));
    await escalateOverdueIncidents(addMinutes(nowIso(), 95));
    const medLogs = (await db().select().from(schema.notificationLogs).where(eq(schema.notificationLogs.incidentId, med.id))).filter((n) => n.reason.startsWith("미조치 확대 통보"));
    expect(medLogs.map((n) => n.status)).toEqual(["SUPPRESSED"]);
    // 등급 미달은 억제
    const low = await notifyIncident(setting, { ...inc, severity: "LOW" }, null, nowIso(), "Asia/Seoul", "OCCURRED");
    expect(low[0].status).toBe("SUPPRESSED");
  });
});
