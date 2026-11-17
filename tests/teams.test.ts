import { createServer, type Server } from "node:http";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { AgentClient } from "@/lib/delivery/agent";
import { agentMockTransport, MOCK_DEVICE_ID, MOCK_ROBOT } from "@/lib/delivery/mock";
import { teamsCard, teamsConfig } from "@/lib/notify/teams";
import { processDeliveryEvents, saveDeliveryRecipients, sendDeliveryReminders, setDeliveryRobotSite, syncDeliveryCatalog, syncDeliveryState } from "@/lib/services/delivery";
import { POST as agentNotifyPOST } from "@/app/api/webhooks/pudu-agent/route";
import { getDb, resetAndSeed, schema, user } from "./helpers";

/**
 * 가상 시험: 로봇 → (가상) 에이전트 웹훅 → Wide Bot → (가상) Teams 워크플로 웹훅 → 개인별 카드.
 * Teams 쪽은 실제 Power Automate 대신 이 파일의 HTTP 서버가 받는다(202 응답, 본문 기록).
 * TEAMS_SIM_OUT=<경로> 로 받은 본문을 파일로 남길 수 있다(카드 미리보기용).
 */
const received: { path: string; body: Record<string, unknown> }[] = [];
const allReceived: typeof received = []; // 파일 저장용(시험마다 비우지 않음)
let server: Server;
let port = 0;

function agentMsg(seq: number, status: string, at: number, dest: string) {
  return { msgId: `sim-${seq}`, msgType: "notifyDeliveryTask", robotId: MOCK_ROBOT.id, groupId: "MOCK-GROUP", deviceId: MOCK_DEVICE_ID, timestamp: at, data: { deliveryMode: "General", trays: [{ destinations: [{ destination: dest, type: "manual", status, estimatedTime: 60000, spendTime: 30000 }] }] } };
}
const postAgent = (body: unknown) => agentNotifyPOST(new Request("http://x/api/webhooks/pudu-agent?token=sim-token-123", { method: "POST", body: JSON.stringify(body) }));

describe("Teams 개인 발송 — 가상 웹훅 끝단 시험", () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const item = { path: req.url ?? "", body: JSON.parse(raw || "{}") };
        received.push(item);
        allReceived.push(item);
        res.writeHead(202).end(); // 실제 워크플로 웹훅도 202(접수)만 돌려준다
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
    process.env.TEAMS_WORKFLOW_URL = `http://127.0.0.1:${port}/workflows/sim/triggers/manual/paths/invoke`;
    process.env.PUDU_AGENT_MODE = "mock";
    process.env.PUDU_AGENT_NOTIFY_TOKEN = "sim-token-123";
    process.env.PUDU_AGENT_REMIND_MINUTES = "3";
  });
  afterAll(async () => {
    if (process.env.TEAMS_SIM_OUT) writeFileSync(process.env.TEAMS_SIM_OUT, JSON.stringify(allReceived, null, 2));
    delete process.env.TEAMS_WORKFLOW_URL;
    delete process.env.PUDU_AGENT_MODE;
    delete process.env.PUDU_AGENT_NOTIFY_TOKEN;
    await new Promise((r) => server.close(r));
  });
  beforeEach(async () => {
    await resetAndSeed();
    received.length = 0;
  });

  it("https 가 아닌 외부 주소는 받지 않는다(가상 시험용 localhost 만 예외)", () => {
    const keep = process.env.TEAMS_WORKFLOW_URL;
    process.env.TEAMS_WORKFLOW_URL = "http://example.com/hook";
    expect(teamsConfig()).toBeNull();
    process.env.TEAMS_WORKFLOW_URL = keep;
    expect(teamsConfig()?.url).toContain("127.0.0.1");
  });

  it("도착 → 목적지 수신자 각자에게 Teams 카드 1건씩, 미수령이면 재알림 1건씩", async () => {
    const hq = await user("u-hq");
    const client = new AgentClient(agentMockTransport, MOCK_DEVICE_ID);
    await syncDeliveryCatalog(client);
    await syncDeliveryState(client);
    await setDeliveryRobotSite(hq, `DR-${MOCK_ROBOT.id}`, "site-01");
    await saveDeliveryRecipients(hq, { siteId: "site-01", destination: "2601", userIds: ["u-hq", "u-site-a"], channels: ["TEAMS"] });

    const t = Date.now() - 10 * 60_000; // 10분 전 도착 → 재알림 대상
    expect((await postAgent(agentMsg(1, "OnTheWay", t, "2601"))).status).toBe(200);
    expect((await postAgent(agentMsg(2, "Arrived", t + 60_000, "2601"))).status).toBe(200);
    expect((await processDeliveryEvents()).counts.errors).toBe(0);

    // 개인별 1건씩, 받는 사람 = 각 사용자 이메일
    expect(received.map((r) => r.body.recipient).sort()).toEqual(["hq-admin@example.invalid", "site-a@example.invalid"]);
    const first = received[0].body as { type: string; title: string; attachments: { contentType: string; content: { type: string; version: string; body: { type: string; facts?: { title: string; value: string }[] }[]; actions: { url: string }[] } }[] };
    expect(first.type).toBe("message");
    expect(first.title).toContain("2601");
    const card = first.attachments[0];
    expect(card.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(card.content).toMatchObject({ type: "AdaptiveCard", version: "1.4" });
    expect(card.content.body.find((b) => b.type === "FactSet")?.facts?.some((f) => f.title === "로봇")).toBe(true);
    expect(card.content.actions[0].url).toContain("/delivery");

    // 기록: 개인별 SENT, 받는 사람 이메일
    const leg = (await getDb().select().from(schema.deliveryLegs).where(eq(schema.deliveryLegs.destination, "2601")))[0];
    const logs = await getDb().select().from(schema.notificationLogs).where(eq(schema.notificationLogs.refId, leg.id));
    expect(logs.map((l) => [l.channel, l.status])).toEqual([["TEAMS", "SENT"], ["TEAMS", "SENT"]]);
    expect(leg.notifyResult).toContain("Teams 발송");

    // 3분 넘게 미수령 → 각자 재알림 1건, 두 번째 실행에서는 없음
    expect(await sendDeliveryReminders()).toBe(1);
    expect(await sendDeliveryReminders()).toBe(0);
    expect(received.length).toBe(4);
    expect(String(received[2].body.title)).toMatch(/재알림|수령/);
  });

  it("워크플로가 거절(4xx)하면 실패로 기록한다", async () => {
    const keep = process.env.TEAMS_WORKFLOW_URL!;
    const bad = createServer((_q, s) => s.writeHead(401).end('{"error":{"code":"DirectApiAuthorizationRequired"}}'));
    await new Promise<void>((r) => bad.listen(0, "127.0.0.1", () => r()));
    process.env.TEAMS_WORKFLOW_URL = `http://127.0.0.1:${(bad.address() as { port: number }).port}/x`;
    const hq = await user("u-hq");
    const client = new AgentClient(agentMockTransport, MOCK_DEVICE_ID);
    await syncDeliveryCatalog(client);
    await setDeliveryRobotSite(hq, `DR-${MOCK_ROBOT.id}`, "site-01");
    await saveDeliveryRecipients(hq, { siteId: "site-01", destination: "2602", userIds: ["u-hq"], channels: ["TEAMS"] });
    await postAgent(agentMsg(10, "Arrived", Date.now(), "2602"));
    await processDeliveryEvents();
    const logs = await getDb().select().from(schema.notificationLogs).where(eq(schema.notificationLogs.channel, "TEAMS"));
    expect(logs[0]).toMatchObject({ status: "FAILED" });
    expect(logs[0].reason).toContain("401");
    process.env.TEAMS_WORKFLOW_URL = keep;
    await new Promise((r) => bad.close(r));
  });

  it("카드: '항목: 값' 줄은 표로, 색은 알림 종류에 따라", () => {
    const c = teamsCard({ title: "도착", lines: ["로봇: FlashBot", "메모 없음"], url: "", tone: "attention" }) as { body: { color?: string; facts?: unknown[]; text?: string }[]; actions: unknown[] };
    expect(c.body[0].color).toBe("attention");
    expect(c.body[1].facts).toEqual([{ title: "로봇", value: "FlashBot" }]);
    expect(c.body[2].text).toBe("메모 없음");
    expect(c.actions).toEqual([]);
  });
});
