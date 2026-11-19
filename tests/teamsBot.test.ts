import { generateKeyPairSync, sign } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { AgentClient } from "@/lib/delivery/agent";
import { agentMockTransport, MOCK_DEVICE_ID, MOCK_ROBOT } from "@/lib/delivery/mock";
import { setTeamsBotFetchForTest } from "@/lib/notify/teamsBot";
import { processDeliveryEvents, saveDeliveryRecipients, setDeliveryRobotSite, syncDeliveryCatalog, ingestAgentNotify } from "@/lib/services/delivery";
import { POST as botPOST } from "@/app/api/teams/messages/route";
import { getDb, resetAndSeed, schema, user } from "./helpers";

/** Teams 봇 직접 발송: Microsoft 쪽(OpenID·토큰·Connector)은 가짜 응답, 서명은 시험용 RSA 키로 실제 검증. */
const APP_ID = "11111111-2222-3333-4444-555555555555";
const TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SERVICE = "https://smba.trafficmanager.net/apac/";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-kid", endorsements: ["msteams"] };

const calls: { url: string; method: string; auth?: string; body?: unknown }[] = [];
const members: Record<string, { email: string; userPrincipalName: string; name: string }> = {
  "29:hq": { email: "HQ-Admin@example.invalid", userPrincipalName: "hq-admin@example.invalid", name: "김본사" },
};

function jwt(claims: Record<string, unknown>, kid = "test-kid"): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "RS256", typ: "JWT", kid });
  const body = enc(claims);
  return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
}
const goodClaims = () => ({ iss: "https://api.botframework.com", aud: APP_ID, exp: Math.floor(Date.now() / 1000) + 600, nbf: Math.floor(Date.now() / 1000) - 10, serviceurl: SERVICE });

function installActivity(fromId = "29:hq", aad = "aad-hq", tenant = TENANT) {
  return { type: "installationUpdate", action: "add", serviceUrl: SERVICE, from: { id: fromId, aadObjectId: aad, name: "김본사" }, recipient: { id: `28:${APP_ID}` }, conversation: { id: `a:conv-${aad}`, conversationType: "personal", tenantId: tenant }, channelData: { tenant: { id: tenant } } };
}
const post = (body: unknown, token?: string) => botPOST(new Request("http://x/api/teams/messages", { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) }));

describe("Teams 봇 직접 발송", () => {
  beforeAll(() => {
    process.env.TEAMS_BOT_APP_ID = APP_ID;
    process.env.TEAMS_BOT_APP_SECRET = "test-secret-value";
    process.env.TEAMS_BOT_TENANT_ID = TENANT;
    process.env.PUDU_AGENT_MODE = "mock";
    setTeamsBotFetchForTest(async (url, init) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, auth: init?.headers?.Authorization, body: init?.body ? (url.includes("oauth2") ? init.body : JSON.parse(init.body)) : undefined });
      const json = (status: number, b: unknown) => ({ status, json: async () => b, text: async () => JSON.stringify(b) });
      if (url.includes("openidconfiguration")) return json(200, { jwks_uri: "https://login.botframework.com/v1/.well-known/keys" });
      if (url.endsWith("/keys")) return json(200, { keys: [jwk] });
      if (url.includes("/oauth2/v2.0/token")) return json(200, { access_token: "bot-token-xyz", expires_in: 3600 });
      const mm = /\/members\/([^/]+)$/.exec(url);
      if (mm) return members[decodeURIComponent(mm[1])] ? json(200, members[decodeURIComponent(mm[1])]) : json(404, {});
      if (url.endsWith("/activities") && url.includes("conv-gone")) return json(403, { error: { code: "BotDisabledByAdmin" } });
      if (url.endsWith("/activities")) return json(201, { id: "act-1" });
      return json(404, {});
    });
  });
  afterAll(() => {
    setTeamsBotFetchForTest(null);
    delete process.env.TEAMS_BOT_APP_ID;
    delete process.env.TEAMS_BOT_APP_SECRET;
    delete process.env.TEAMS_BOT_TENANT_ID;
    delete process.env.PUDU_AGENT_MODE;
  });
  beforeEach(async () => {
    await resetAndSeed();
    calls.length = 0;
  });

  it("수신 주소: 서명이 없거나 위조·다른 앱 대상이면 401, 저장하지 않음", async () => {
    expect((await post(installActivity())).status).toBe(401);
    const forged = jwt(goodClaims()).replace(/\.[^.]+$/, ".AAAA");
    expect((await post(installActivity(), forged)).status).toBe(401);
    expect((await post(installActivity(), jwt({ ...goodClaims(), aud: "other-app" }))).status).toBe(401);
    expect((await post(installActivity(), jwt({ ...goodClaims(), exp: 1000 }))).status).toBe(401);
    expect((await post(installActivity(), jwt(goodClaims(), "unknown-kid"))).status).toBe(401);
    expect(await getDb().select().from(schema.teamsConversations)).toEqual([]);
  });

  it("앱 설치 알림 → 개인 채팅 주소·이메일(소문자) 저장 + 환영 메시지, 다른 회사(테넌트)는 무시", async () => {
    expect((await post(installActivity(), jwt(goodClaims()))).status).toBe(200);
    const rows = await getDb().select().from(schema.teamsConversations);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ aadObjectId: "aad-hq", email: "hq-admin@example.invalid", conversationId: "a:conv-aad-hq", serviceUrl: SERVICE, removedAt: null });
    const welcome = calls.find((c) => c.method === "POST" && c.url.endsWith("/activities"));
    expect(welcome?.auth).toBe("Bearer bot-token-xyz");
    expect((welcome?.body as { text: string }).text).toContain("Wide Bot 알림");

    await post(installActivity("29:x", "aad-x", "other-tenant"), jwt(goodClaims()));
    expect(await getDb().select().from(schema.teamsConversations)).toHaveLength(1);

    // 앱 제거 → 보내지 않음 표시
    await post({ ...installActivity(), action: "remove" }, jwt(goodClaims()));
    expect((await getDb().select().from(schema.teamsConversations))[0].removedAt).not.toBeNull();
  });

  it("배송 도착 → 설치된 직원은 봇으로 바로 카드, 미설치 직원은 실패 기록(사유 안내)", async () => {
    await post(installActivity(), jwt(goodClaims()));
    calls.length = 0;
    const hq = await user("u-hq");
    await syncDeliveryCatalog(new AgentClient(agentMockTransport, MOCK_DEVICE_ID));
    await setDeliveryRobotSite(hq, `DR-${MOCK_ROBOT.id}`, "site-01");
    await saveDeliveryRecipients(hq, { siteId: "site-01", destination: "2601", userIds: ["u-hq", "u-site-a"], channels: ["TEAMS"] });
    await ingestAgentNotify({ msgId: "bot-1", msgType: "notifyDeliveryTask", robotId: MOCK_ROBOT.id, timestamp: Date.now(), data: { trays: [{ destinations: [{ destination: "2601", status: "Arrived" }] }] } });
    await processDeliveryEvents();

    const sends = calls.filter((c) => c.url === `${SERVICE}v3/conversations/a%3Aconv-aad-hq/activities`);
    expect(sends).toHaveLength(1);
    expect(sends[0].auth).toBe("Bearer bot-token-xyz");
    const body = sends[0].body as { type: string; summary: string; attachments: { contentType: string; content: { type: string } }[] };
    expect(body.summary).toContain("2601");
    expect(body.attachments[0]).toMatchObject({ contentType: "application/vnd.microsoft.card.adaptive", content: { type: "AdaptiveCard" } });

    const logs = await getDb().select().from(schema.notificationLogs).where(eq(schema.notificationLogs.channel, "TEAMS"));
    const byWho = Object.fromEntries(logs.map((l) => [l.recipient, l]));
    expect(byWho["hq-admin@example.invalid"]).toMatchObject({ status: "SENT" });
    expect(byWho["hq-admin@example.invalid"].reason).toContain("봇 직접 발송");
    expect(byWho["site-a@example.invalid"]).toMatchObject({ status: "FAILED" });
    expect(byWho["site-a@example.invalid"].reason).toContain("설치되지 않음");
  });

  it("앱이 막히거나 제거돼 403 이면 실패 기록 + 다음부터 보내지 않음, Microsoft 가 아닌 serviceUrl 로는 토큰을 보내지 않음", async () => {
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(schema.teamsConversations).values([
      { aadObjectId: "aad-gone", email: "gone@example.invalid", upn: null, name: "x", tenantId: TENANT, conversationId: "a:conv-gone", serviceUrl: SERVICE, removedAt: null, updatedAt: now },
      { aadObjectId: "aad-evil", email: "evil@example.invalid", upn: null, name: "y", tenantId: TENANT, conversationId: "a:c", serviceUrl: "https://attacker.example.com/", removedAt: null, updatedAt: now },
    ]);
    const { deliver } = await import("@/lib/notify/notifier");
    const m = { subject: "s", title: "t", lines: ["로봇: A"], url: "https://x/delivery" };
    expect((await deliver({ channel: "TEAMS", address: "gone@example.invalid" }, m)).status).toBe("FAILED");
    expect((await db.select().from(schema.teamsConversations).where(eq(schema.teamsConversations.aadObjectId, "aad-gone")))[0].removedAt).not.toBeNull();
    const r = await deliver({ channel: "TEAMS", address: "evil@example.invalid" }, m);
    expect(r.status).toBe("FAILED");
    expect(calls.some((c) => c.url.includes("attacker"))).toBe(false);
  });
});
