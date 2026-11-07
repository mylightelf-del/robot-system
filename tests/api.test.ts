import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash, generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, resetAndSeed, SAMPLE_PASSWORD, schema, user } from "./helpers";
import { resolveSession } from "@/lib/auth/session";
import { addRecipient } from "@/lib/services/admin";
import { simulateIncident } from "@/lib/services/incidents";
import { deliver } from "@/lib/notify/notifier";
import { POST as loginPost } from "@/app/api/v1/auth/login/route";
import { POST as logoutPost } from "@/app/api/v1/auth/logout/route";
import { GET as meGet } from "@/app/api/v1/me/route";
import { GET as sessionsGet } from "@/app/api/v1/me/sessions/route";
import { DELETE as sessionDelete } from "@/app/api/v1/me/sessions/[sessionId]/route";
import { GET as siteGet } from "@/app/api/v1/sites/[siteId]/route";
import { GET as robotGet } from "@/app/api/v1/robots/[robotId]/route";
import { GET as incidentsGet } from "@/app/api/v1/incidents/route";
import { GET as incidentGet } from "@/app/api/v1/incidents/[incidentId]/route";
import { POST as ackPost } from "@/app/api/v1/incidents/[incidentId]/ack/route";
import { POST as commandPost } from "@/app/api/v1/robots/[robotId]/commands/route";
import { GET as devicesGet, POST as devicesPost, DELETE as devicesDelete } from "@/app/api/v1/devices/route";
import { POST as subscribePost } from "@/app/api/v1/subscriptions/route";
import { GET as notificationsGet } from "@/app/api/v1/notifications/route";
import { GET as dashboardGet } from "@/app/api/v1/dashboard/route";

const db = () => getDb();

/** 라우트 핸들러를 HTTP 없이 직접 부른다(요청 객체 + params). */
async function call<P extends Record<string, string>>(handler: (req: Request, ctx?: { params: Promise<P> }) => Promise<Response>, method: string, path: string, opts: { token?: string; body?: unknown; params?: P; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "user-agent": "vitest-app", ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(`https://widebot.test${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const res = await handler(req, { params: Promise.resolve(opts.params ?? ({} as P)) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, headers: res.headers };
}

async function appLogin(email: string, deviceName = "Galaxy S24") {
  const r = await call(loginPost, "POST", "/api/v1/auth/login", { body: { email, password: SAMPLE_PASSWORD, deviceName } });
  if (r.status !== 200) throw new Error(`로그인 실패 ${r.status} ${JSON.stringify(r.json)}`);
  return r.json as { token: string; sessionId: string; user: { id: string } };
}

// ---- FCM 모의 서버: 토큰 발급 + messages:send. 등록 토큰에 "bad" 가 들어 있으면 UNREGISTERED 로 거절한다.
type FState = { sent: { token: string; title: string; body: string; data: Record<string, string>; auth: string }[]; tokenCalls: number };
function startFcm(state: FState): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/token") {
      const form = new URLSearchParams(raw);
      if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer" || (form.get("assertion") ?? "").split(".").length !== 3) return send(400, { error: "invalid_grant" });
      state.tokenCalls += 1;
      return send(200, { access_token: `fcm-at-${state.tokenCalls}`, expires_in: 3600, token_type: "Bearer" });
    }
    if (url.pathname === "/v1/projects/test-proj/messages:send") {
      const m = JSON.parse(raw).message as { token: string; notification: { title: string; body: string }; data: Record<string, string> };
      if (m.token.includes("bad")) return send(404, { error: { code: 404, status: "NOT_FOUND", message: "Requested entity was not found.", details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }] } });
      state.sent.push({ token: m.token, title: m.notification.title, body: m.notification.body, data: m.data, auth: String(req.headers.authorization) });
      return send(200, { name: `projects/test-proj/messages/${state.sent.length}` });
    }
    send(404, {});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise((r) => server.close(() => r())) })));
}

const FCM_TOKEN_OK = "fcm-registration-token-okay-0123456789abcdef";
const FCM_TOKEN_BAD = "fcm-registration-token-bad-0123456789abcdef";

describe("앱 API(/api/v1): 토큰 로그인·사업장 범위·명령·기기·푸시", () => {
  const saved = { ...process.env };
  let fcm: Awaited<ReturnType<typeof startFcm>>;
  const fstate: FState = { sent: [], tokenCalls: 0 };
  let serviceAccountJson = "";

  beforeAll(async () => {
    fcm = await startFcm(fstate);
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    serviceAccountJson = JSON.stringify({ project_id: "test-proj", client_email: "fcm@test-proj.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
  });
  afterAll(async () => {
    await fcm.close();
    process.env = saved;
  });
  beforeEach(async () => {
    await resetAndSeed();
    fstate.sent = [];
    process.env.APP_BASE_URL = "https://widebot.example";
    delete process.env.FCM_SERVICE_ACCOUNT_JSON;
    delete process.env.FCM_SERVICE_ACCOUNT_FILE;
    delete process.env.MAIL_MODE;
  });

  it("로그인은 토큰을 돌려주고 DB 에는 해시만 남는다. 틀리면 사유를 구분하지 않는 401", async () => {
    const bad = await call(loginPost, "POST", "/api/v1/auth/login", { body: { email: "hq-admin@example.invalid", password: "wrong-1" } });
    const none = await call(loginPost, "POST", "/api/v1/auth/login", { body: { email: "nobody@example.invalid", password: "wrong-1" } });
    expect(bad.status).toBe(401);
    expect(none.status).toBe(401);
    expect((bad.json.error as { message: string }).message).toBe((none.json.error as { message: string }).message);

    const r = await appLogin("hq-admin@example.invalid");
    expect(r.user.id).toBe("u-hq");
    const row = await db().query.sessions.findFirst({ where: eq(schema.sessions.id, r.sessionId) });
    expect(row?.kind).toBe("app");
    expect(row?.deviceName).toBe("Galaxy S24");
    expect(row?.id).toBe(createHash("sha256").update(r.token).digest("hex"));
    expect(row?.id).not.toBe(r.token);
    // 앱 세션은 웹(12시간)보다 길다(기본 30일)
    expect(new Date(row!.expiresAt).getTime() - Date.now()).toBeGreaterThan(20 * 24 * 3600 * 1000);
    const logs = await db().select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "AUTH:LOGIN"));
    expect(logs.some((l) => l.userId === "u-hq" && l.result === "OK" && (l.params as { channel: string }).channel === "app")).toBe(true);
  });

  it("Bearer 없이 또는 잘못된 토큰이면 401, 있으면 /me 가 사용자·세션·사업장을 준다", async () => {
    expect((await call(meGet, "GET", "/api/v1/me")).status).toBe(401);
    expect((await call(meGet, "GET", "/api/v1/me", { token: "not-a-real-token" })).status).toBe(401);
    const r = await appLogin("site-a@example.invalid", "현장폰");
    const me = await call(meGet, "GET", "/api/v1/me", { token: r.token });
    expect(me.status).toBe(200);
    expect((me.json.user as { id: string }).id).toBe("u-site-a");
    expect((me.json.session as { kind: string; deviceName: string }).kind).toBe("app");
    expect((me.json.session as { deviceName: string }).deviceName).toBe("현장폰");
    expect((me.json.sites as unknown[]).length).toBeGreaterThan(0);
    expect(me.headers.get("cache-control")).toContain("no-store");
    expect((await call(dashboardGet, "GET", "/api/v1/dashboard", { token: r.token })).status).toBe(200);
  });

  it("사업장 범위: 고객은 다른 사업장의 사업장·로봇·장애에 접근할 수 없다(URL 조작 차단)", async () => {
    const c = await appLogin("customer1@example.invalid"); // site-01 만
    expect((await call(siteGet, "GET", "/api/v1/sites/site-01", { token: c.token, params: { siteId: "site-01" } })).status).toBe(200);
    expect((await call(siteGet, "GET", "/api/v1/sites/site-02", { token: c.token, params: { siteId: "site-02" } })).status).toBe(403);
    expect((await call(robotGet, "GET", "/api/v1/robots/PW-R-006", { token: c.token, params: { robotId: "PW-R-006" } })).status).toBe(404); // site-02 로봇
    expect((await call(incidentsGet, "GET", "/api/v1/incidents?siteId=site-02", { token: c.token })).status).toBe(403);
    // 고객 응답에는 원시 오류·내부 메모가 없다
    const inc = await call(incidentsGet, "GET", "/api/v1/incidents", { token: c.token });
    expect(inc.status).toBe(200);
    for (const i of inc.json.incidents as Record<string, unknown>[]) {
      expect(i.rawMessage).toBeFalsy(); // 고객에게는 원시 오류를 비운다
      expect(i.siteId).toBe("site-01");
    }
    const robot = await call(robotGet, "GET", "/api/v1/robots/PW-R-001", { token: c.token, params: { robotId: "PW-R-001" } });
    expect(robot.status).toBe(200);
    expect((robot.json.robot as Record<string, unknown>).internalNote).toBeUndefined();
  });

  it("명령: 고객 기본은 403(감사 DENIED), 멱등 키 없으면 400, 있으면 201 + 입구·기기 기록, 같은 키 재전송은 409", async () => {
    const c = await appLogin("customer1@example.invalid");
    const denied = await call(commandPost, "POST", "/api/v1/robots/PW-R-001/commands", { token: c.token, params: { robotId: "PW-R-001" }, body: { type: "STOP", idempotencyKey: "k-1" } });
    expect(denied.status).toBe(403);
    const deniedLog = (await db().select().from(schema.auditLogs).where(eq(schema.auditLogs.userId, "u-cust-1"))).find((l) => l.action === "COMMAND:STOP" && l.result === "DENIED" && (l.params as { origin?: { channel: string } }).origin?.channel === "app");
    expect(deniedLog).toBeTruthy();

    const hq = await appLogin("hq-admin@example.invalid", "본사폰");
    const noKey = await call(commandPost, "POST", "/api/v1/robots/PW-R-003/commands", { token: hq.token, params: { robotId: "PW-R-003" }, body: { type: "START_TASK", params: { taskId: "task-PW-R-003-night" } } });
    expect(noKey.status).toBe(400);
    const badType = await call(commandPost, "POST", "/api/v1/robots/PW-R-003/commands", { token: hq.token, params: { robotId: "PW-R-003" }, body: { type: "JOYSTICK", idempotencyKey: "k-x" } });
    expect(badType.status).toBe(400);

    const ok = await call(commandPost, "POST", "/api/v1/robots/PW-R-003/commands", { token: hq.token, params: { robotId: "PW-R-003" }, body: { type: "START_TASK", params: { taskId: "task-PW-R-003-night" }, idempotencyKey: "k-2" } });
    expect(ok.status).toBe(201);
    const cmd = ok.json.command as { id: string; state: string };
    expect(cmd.state).toBe("ACCEPTED");
    const row = await db().query.commands.findFirst({ where: eq(schema.commands.id, cmd.id) });
    expect(row?.origin).toEqual({ channel: "app", device: "본사폰", sessionId: hq.sessionId });
    expect(row?.idempotencyKey).toBe("app:u-hq:k-2"); // 사용자별로 키 공간을 나눈다
    const aud = (await db().select().from(schema.auditLogs).where(eq(schema.auditLogs.robotId, "PW-R-003"))).find((l) => l.action === "COMMAND:START_TASK" && l.result === "OK");
    expect((aud?.params as { origin: { channel: string; device: string } }).origin).toMatchObject({ channel: "app", device: "본사폰" });

    const dup = await call(commandPost, "POST", "/api/v1/robots/PW-R-003/commands", { token: hq.token, params: { robotId: "PW-R-003" }, body: { type: "START_TASK", params: { taskId: "task-PW-R-003-night" }, idempotencyKey: "k-2" } });
    expect(dup.status).toBe(409);
  });

  it("장애 조치: 현장 담당자는 확인할 수 있고 고객 기본은 403", async () => {
    const hq = await appLogin("hq-admin@example.invalid");
    const list = await call(incidentsGet, "GET", "/api/v1/incidents?siteId=site-01", { token: hq.token });
    const open = (list.json.incidents as { id: string; status: string }[]).find((i) => i.status === "OPEN")!;
    expect(open).toBeTruthy();
    const c = await appLogin("customer1@example.invalid");
    expect((await call(ackPost, "POST", `/api/v1/incidents/${open.id}/ack`, { token: c.token, params: { incidentId: open.id } })).status).toBe(403);
    const acked = await call(ackPost, "POST", `/api/v1/incidents/${open.id}/ack`, { token: hq.token, params: { incidentId: open.id } });
    expect(acked.status).toBe(200);
    expect(acked.json.status).toBe("ACKED");
    expect((await call(incidentGet, "GET", `/api/v1/incidents/${open.id}`, { token: c.token, params: { incidentId: open.id } })).status).toBe(200);
  });

  it("기기: 푸시 토큰 등록 → 구독(PUSH) 가능 → 기기 끊기 시 토큰 무효·푸시 기기 삭제", async () => {
    const a = await appLogin("site-a@example.invalid", "현장폰");
    // 기기 등록 전에는 PUSH 구독 불가
    const early = await call(subscribePost, "POST", "/api/v1/subscriptions", { token: a.token, body: { siteId: "site-01", channel: "PUSH" } });
    expect(early.status).toBe(400);
    const bad = await call(devicesPost, "POST", "/api/v1/devices", { token: a.token, body: { token: "short", platform: "android" } });
    expect(bad.status).toBe(400);
    const reg = await call(devicesPost, "POST", "/api/v1/devices", { token: a.token, body: { token: FCM_TOKEN_OK, platform: "android", appVersion: "0.1.0" } });
    expect(reg.status).toBe(201);
    const devices = await call(devicesGet, "GET", "/api/v1/devices", { token: a.token });
    expect((devices.json.devices as Record<string, unknown>[]).length).toBe(1);
    expect((devices.json.devices as Record<string, unknown>[])[0].token).toBeUndefined(); // 토큰은 돌려주지 않는다
    expect((devices.json.devices as Record<string, unknown>[])[0].deviceName).toBe("현장폰");
    const sub = await call(subscribePost, "POST", "/api/v1/subscriptions", { token: a.token, body: { siteId: "site-01", channel: "PUSH", kinds: ["INCIDENT"] } });
    expect(sub.status).toBe(201);
    // 다른 사업장(권한 없음)은 403
    expect((await call(subscribePost, "POST", "/api/v1/subscriptions", { token: a.token, body: { siteId: "site-05", channel: "PUSH" } })).status).toBe(403);

    // 두 번째 기기(웹처럼 다른 세션)에서 첫 세션을 끊는다
    const b = await appLogin("site-a@example.invalid", "태블릿");
    const sessions = await call(sessionsGet, "GET", "/api/v1/me/sessions", { token: b.token });
    const rows = sessions.json.sessions as { id: string; current: boolean; deviceName: string; pushDevices: number }[];
    expect(rows.find((s) => s.deviceName === "현장폰")?.pushDevices).toBe(1);
    expect((await call(sessionDelete, "DELETE", `/api/v1/me/sessions/${a.sessionId}`, { token: b.token, params: { sessionId: a.sessionId } })).status).toBe(200);
    expect((await call(meGet, "GET", "/api/v1/me", { token: a.token })).status).toBe(401);
    expect((await db().select().from(schema.pushDevices).where(eq(schema.pushDevices.userId, "u-site-a"))).length).toBe(0);
    // 남의 세션은 끊을 수 없다
    const hq = await appLogin("hq-admin@example.invalid");
    expect((await call(sessionDelete, "DELETE", `/api/v1/me/sessions/${b.sessionId}`, { token: hq.token, params: { sessionId: b.sessionId } })).status).toBe(400);
  });

  it("로그아웃은 그 토큰만 무효로 하고 푸시 기기를 지운다. 기기 해제(DELETE /devices)도 가능", async () => {
    const a = await appLogin("hq-admin@example.invalid", "폰1");
    const b = await appLogin("hq-admin@example.invalid", "폰2");
    await call(devicesPost, "POST", "/api/v1/devices", { token: a.token, body: { token: FCM_TOKEN_OK, platform: "android" } });
    await call(devicesPost, "POST", "/api/v1/devices", { token: b.token, body: { token: FCM_TOKEN_BAD, platform: "ios" } });
    const del = await call(devicesDelete, "DELETE", "/api/v1/devices", { token: b.token, body: { token: FCM_TOKEN_BAD } });
    expect(del.json.removed).toBe(true);
    expect((await call(logoutPost, "POST", "/api/v1/auth/logout", { token: a.token })).status).toBe(200);
    expect((await call(meGet, "GET", "/api/v1/me", { token: a.token })).status).toBe(401);
    expect((await call(meGet, "GET", "/api/v1/me", { token: b.token })).status).toBe(200);
    expect((await db().select().from(schema.pushDevices).where(eq(schema.pushDevices.userId, "u-hq"))).length).toBe(0);
  });

  it("푸시 발송: 설정 전에는 모의, 설정 후 FCM 접수 → SENT(요약만, 딥링크 data), 무효 토큰 기기는 비활성 처리", async () => {
    const hq = await user("u-hq");
    const a = await appLogin("site-a@example.invalid", "현장폰");
    await call(devicesPost, "POST", "/api/v1/devices", { token: a.token, body: { token: FCM_TOKEN_OK, platform: "android" } });
    await addRecipient(hq, "site-01", { channel: "PUSH", address: "user:u-site-a", minSeverity: "HIGH", hoursFrom: "00:00", hoursTo: "23:59" });
    // 수신자 검증: 푸시는 사용자 주소만, 비활성 사용자 거부
    await expect(addRecipient(hq, "site-01", { channel: "PUSH", address: "010-0000-0000", minSeverity: "HIGH", hoursFrom: "00:00", hoursTo: "23:59" })).rejects.toThrow(/사용자/);
    await expect(addRecipient(hq, "site-01", { channel: "PUSH", address: "user:u-inactive", minSeverity: "HIGH", hoursFrom: "00:00", hoursTo: "23:59" })).rejects.toThrow(/활성/);

    // 1) FCM 설정 전 → 모의
    const inc1 = (await simulateIncident(hq, "PW-R-001", "BRUSH_MOTOR", "HIGH", "push-1"))!;
    const logs1 = await db().select().from(schema.notificationLogs).where(eq(schema.notificationLogs.incidentId, inc1.id));
    expect(logs1.find((l) => l.channel === "PUSH")?.status).toBe("MOCK_SENT");

    // 2) FCM 설정 후 → 실제 발송(모의 서버)
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson;
    process.env.FCM_API_BASE = fcm.url;
    process.env.FCM_OAUTH_TOKEN_URL = `${fcm.url}/token`;
    const inc2 = (await simulateIncident(hq, "PW-R-002", "BRUSH_MOTOR", "HIGH", "push-2"))!;
    const logs2 = await db().select().from(schema.notificationLogs).where(eq(schema.notificationLogs.incidentId, inc2.id));
    const push = logs2.find((l) => l.channel === "PUSH")!;
    expect(push.status).toBe("SENT");
    expect(push.reason).toContain("1대");
    expect(fstate.sent.length).toBe(1);
    expect(fstate.sent[0].token).toBe(FCM_TOKEN_OK);
    expect(fstate.sent[0].auth).toMatch(/^Bearer fcm-at-/);
    expect(fstate.sent[0].title).toContain("장애 발생");
    expect(fstate.sent[0].body).not.toContain("원시"); // 요약 두 줄만(사업장·로봇)
    expect(fstate.sent[0].data).toMatchObject({ kind: "INCIDENT", refId: inc2.id, siteId: "site-01" });
    expect(fstate.sent[0].data.url).toContain("/incidents");

    // 3) 내 알림함에 보인다
    const inbox = await call(notificationsGet, "GET", "/api/v1/notifications", { token: a.token });
    expect((inbox.json.notifications as { incidentId: string | null; channel: string }[]).some((n) => n.incidentId === inc2.id && n.channel === "PUSH")).toBe(true);

    // 4) 무효 토큰 기기: FAILED 기록 + disabledAt. 기기 없는 사용자는 실패 사유 '기기 없음'
    const b = await appLogin("site-a@example.invalid", "옛폰");
    await call(devicesPost, "POST", "/api/v1/devices", { token: b.token, body: { token: FCM_TOKEN_BAD, platform: "android" } });
    const r = await deliver({ channel: "PUSH", address: "user:u-site-a" }, { subject: "s", title: "t", lines: ["a", "b", "c"], url: "https://x" });
    expect(r.status).toBe("SENT"); // 1대 성공, 1대 실패
    expect(r.reason).toContain("실패 1대");
    const badRow = await db().query.pushDevices.findFirst({ where: eq(schema.pushDevices.token, FCM_TOKEN_BAD) });
    expect(badRow?.disabledAt).toBeTruthy();
    expect(badRow?.lastError).toContain("UNREGISTERED");
    expect((await deliver({ channel: "PUSH", address: "user:u-hq" }, { subject: "s", title: "t", lines: [], url: "https://x" })).reason).toContain("기기 없음");
    expect((await deliver({ channel: "PUSH", address: "010-1234-5678" }, { subject: "s", title: "t", lines: [], url: "https://x" })).status).toBe("FAILED");
    delete process.env.FCM_API_BASE;
    delete process.env.FCM_OAUTH_TOKEN_URL;
  });

  it("웹 세션도 해시 저장: 쿠키 토큰으로 세션을 찾고, DB 의 id 로는 로그인할 수 없다", async () => {
    const { login } = await import("@/lib/services/auth");
    const r = await login("hq-admin@example.invalid", SAMPLE_PASSWORD, "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0", { kind: "web" });
    if (!r.ok) throw new Error("login failed");
    expect((await resolveSession(r.token))?.user.id).toBe("u-hq");
    expect(await resolveSession(r.sessionId)).toBeNull(); // 해시(id)를 토큰처럼 쓰면 실패
    const row = await db().query.sessions.findFirst({ where: eq(schema.sessions.id, r.sessionId) });
    expect(row?.kind).toBe("web");
    expect(row?.deviceName).toBe("Chrome · Windows");
    // 웹 토큰도 /api/v1 Bearer 로 쓸 수 있다(같은 세션 테이블). 단 입구는 web 으로 기록된다.
    const me = await call(meGet, "GET", "/api/v1/me", { token: r.token });
    expect((me.json.session as { kind: string }).kind).toBe("web");
  });
});
