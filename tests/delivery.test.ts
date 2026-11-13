import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { AgentClient } from "@/lib/delivery/agent";
import { agentMockState, agentMockTransport, MOCK_DEVICE_ID, MOCK_ROBOT } from "@/lib/delivery/mock";
import { callDeliveryRobot, checkStuckRobots, dispatchDelivery, getDeliveryView, ingestAgentNotify, processDeliveryEvents, saveDeliveryRecipients, sendDeliveryReminders, setDeliveryRobotSite, syncDeliveryCatalog, syncDeliveryState } from "@/lib/services/delivery";
import { POST as notifyPOST } from "@/app/api/webhooks/pudu-agent/route";
import { getDb, resetAndSeed, schema, user } from "./helpers";

const db = () => getDb();
const client = () => new AgentClient(agentMockTransport, MOCK_DEVICE_ID);

let seq = 0;
function deliveryMsg(status: string, at: number, dest = "2601", extra: Record<string, unknown> = {}) {
  seq += 1;
  return { msgId: `m-${seq}`, msgType: "notifyDeliveryTask", robotId: MOCK_ROBOT.id, groupId: "MOCK-GROUP", deviceId: MOCK_DEVICE_ID, timestamp: at, data: { deliveryMode: "General", trays: [{ destinations: [{ destination: dest, type: "manual", status, estimatedTime: 60000, spendTime: 30000, ...extra }] }] } };
}

describe("배송로봇 에이전트 — 조회 전용 클라이언트", () => {
  it("호출·배송 지시·조작 명령 경로는 요청 전에 막는다", async () => {
    const c = client() as unknown as { call: (m: string, p: string) => Promise<unknown> };
    agentMockState.requests.length = 0;
    for (const p of ["/api/robot/call", "/api/robot/cancel/call", "/api/robot/delivery/task", "/api/robot/custom/call", "/api/robot/action"]) {
      await expect(c.call("POST", p)).rejects.toThrow(/조회 전용/);
    }
    expect(agentMockState.requests).toEqual([]);
  });
});

describe("배송 도착 알림(모의 에이전트)", () => {
  beforeAll(() => {
    process.env.PUDU_AGENT_MODE = "mock";
    process.env.PUDU_AGENT_NOTIFY_TOKEN = "test-token-123";
    process.env.PUDU_AGENT_REMIND_MINUTES = "3";
  });
  afterAll(() => {
    delete process.env.PUDU_AGENT_MODE;
    delete process.env.PUDU_AGENT_NOTIFY_TOKEN;
  });
  beforeEach(async () => {
    await resetAndSeed();
  });

  it("목록·상태 동기화: 로봇이 사업장 미지정으로 등록되고 목적지·배터리를 받는다", async () => {
    expect((await syncDeliveryCatalog(client())).ok).toBe(true);
    const r = (await db().query.deliveryRobots.findFirst({ where: eq(schema.deliveryRobots.agentRobotId, MOCK_ROBOT.id) }))!;
    expect(r).toMatchObject({ siteId: null, name: MOCK_ROBOT.name, groupId: "MOCK-GROUP" });
    expect(r.destinations.map((d) => d.name)).toContain("2601");
    expect((await syncDeliveryState(client())).ok).toBe(true);
    const s = (await db().query.deliveryRobots.findFirst({ where: eq(schema.deliveryRobots.id, r.id) }))!;
    expect(s.lastState).toMatchObject({ robotState: "FREE", robotPower: 87 });
    expect(s.lastSeenAt).not.toBeNull();
  });

  it("수신 라우트: 토큰이 없거나 틀리면 401, 같은 msgId 는 한 번만 저장, 연동을 끄면 503", async () => {
    const post = (body: unknown, token?: string) => notifyPOST(new Request(`http://x/api/webhooks/pudu-agent${token ? `?token=${token}` : ""}`, { method: "POST", body: JSON.stringify(body) }));
    const m = deliveryMsg("Await", Date.now());
    expect((await post(m)).status).toBe(401);
    expect((await post(m, "wrong-token-xyz")).status).toBe(401);
    const ok = await post(m, "test-token-123");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ code: 0, data: { stored: true } });
    expect(await (await post(m, "test-token-123")).json()).toMatchObject({ data: { duplicate: true } });
    process.env.PUDU_AGENT_MODE = "unconfigured";
    expect((await post(deliveryMsg("Await", Date.now()), "test-token-123")).status).toBe(503);
    process.env.PUDU_AGENT_MODE = "mock";
  });

  it("도착 → 목적지 수신자에게 한 번 알림, 미수령이면 재알림 1회, 완료 후에는 알리지 않음", async () => {
    const hq = await user("u-hq");
    await syncDeliveryCatalog(client());
    const robot = (await db().query.deliveryRobots.findFirst({ where: eq(schema.deliveryRobots.agentRobotId, MOCK_ROBOT.id) }))!;

    // 사업장 미지정: 도착해도 보낼 곳이 없다는 기록만 남는다
    const t0 = Date.now() - 20 * 60_000;
    await ingestAgentNotify(deliveryMsg("OnTheWay", t0, "2602"));
    await ingestAgentNotify(deliveryMsg("Arrived", t0 + 60_000, "2602"));
    await processDeliveryEvents();
    const noSite = (await db().select().from(schema.deliveryLegs).where(eq(schema.deliveryLegs.destination, "2602")))[0];
    expect(noSite.notifyResult).toContain("사업장 미지정");

    await setDeliveryRobotSite(hq, robot.id, "site-01");
    await saveDeliveryRecipients(hq, { siteId: "site-01", destination: "2601", userIds: ["u-hq", "u-site-a"], channels: ["EMAIL"] });

    const t1 = Date.now() - 10 * 60_000;
    for (const [st, dt] of [["Await", 0], ["OnTheWay", 10_000], ["Arrived", 60_000]] as const) await ingestAgentNotify(deliveryMsg(st, t1 + dt));
    // 같은 도착 알림이 다시 와도(전체 트레이 재통보) 한 번만
    await ingestAgentNotify(deliveryMsg("Arrived", t1 + 61_000));
    // 늦게 온 옛 알림(대기)은 상태를 되돌리지 않는다
    await ingestAgentNotify(deliveryMsg("Await", t1 - 5_000));
    expect((await processDeliveryEvents()).counts.errors).toBe(0);
    const legs = await db().select().from(schema.deliveryLegs).where(eq(schema.deliveryLegs.destination, "2601"));
    expect(legs.length).toBe(1);
    expect(legs[0]).toMatchObject({ status: "Arrived", siteId: "site-01", source: "manual" });
    expect(legs[0].notifiedAt).not.toBeNull();
    const logs = await db().select().from(schema.notificationLogs).where(and(eq(schema.notificationLogs.kind, "DELIVERY"), eq(schema.notificationLogs.refId, legs[0].id)));
    expect(logs.length).toBe(2); // 두 직원 × 메일
    expect(logs.every((l) => l.channel === "EMAIL" && (l.status === "MOCK_SENT" || l.status === "SENT"))).toBe(true);

    // 3분 넘게 미수령 → 재알림 1회
    expect(await sendDeliveryReminders()).toBe(1);
    expect(await sendDeliveryReminders()).toBe(0);
    expect((await db().select().from(schema.notificationLogs).where(eq(schema.notificationLogs.refId, legs[0].id))).length).toBe(4);

    // 완료(빈 트레이 감지)
    await ingestAgentNotify(deliveryMsg("Complete", t1 + 5 * 60_000, "2601", { completeType: "TRAY_EMPTY" }));
    await processDeliveryEvents();
    const done = (await db().query.deliveryLegs.findFirst({ where: eq(schema.deliveryLegs.id, legs[0].id) }))!;
    expect(done).toMatchObject({ status: "Complete", completeType: "TRAY_EMPTY" });

    // 다음 배송(같은 목적지)은 새 구간, 기본 수신자('*') 로 대체 발송
    await saveDeliveryRecipients(hq, { siteId: "site-01", destination: "*", userIds: ["u-hq"], channels: ["EMAIL"] });
    await ingestAgentNotify(deliveryMsg("Arrived", Date.now(), "회의실A"));
    await processDeliveryEvents();
    const other = (await db().select().from(schema.deliveryLegs).where(eq(schema.deliveryLegs.destination, "회의실A")))[0];
    expect(other.notifyResult).toContain("메일");
    expect((await db().select().from(schema.notificationLogs).where(eq(schema.notificationLogs.refId, other.id))).length).toBe(1);
  });

  it("화면: 고객 계정은 볼 수 없고, 현장 담당자는 자기 사업장 로봇만 본다", async () => {
    await syncDeliveryCatalog(client());
    await expect(getDeliveryView(await user("u-cust-1"))).rejects.toThrow(/본사·현장/);
    const hqView = await getDeliveryView(await user("u-hq"));
    expect(hqView.robots.length).toBe(1); // 미지정 로봇은 본사만
    const siteView = await getDeliveryView(await user("u-site-a"));
    expect(siteView.robots.length).toBe(0);
    expect(siteView.admin).toBe(false);
  });

  describe("배송 지시·주문별 수신자·취소/막힘/오류 알림", () => {
    const setup = async () => {
      const hq = await user("u-hq");
      await syncDeliveryCatalog(client());
      await syncDeliveryState(client());
      await setDeliveryRobotSite(hq, "DR-MOCKFLASH01", "site-01");
      agentMockState.commands.length = 0;
      return hq;
    };

    it("배송 보내기: 트레이별 목적지·ID 로 전송, 지시한 받는 사람에게 도착 알림, 취소되면 취소 알림", async () => {
      const hq = await setup();
      await saveDeliveryRecipients(hq, { siteId: "site-01", destination: "2601", userIds: ["u-hq"], channels: ["EMAIL"] });
      const r = await dispatchDelivery(hq, { robotId: "DR-MOCKFLASH01", trays: [{ destination: "2601", recipientUserIds: ["u-site-a"] }, { destination: "2602" }] });
      expect(agentMockState.commands.length).toBe(1);
      const body = agentMockState.commands[0].body as { robotId: string; type: string; deliverySort: string; executeTask: boolean; trays: { destinations: { destination: string; id: string }[] }[] };
      expect(body).toMatchObject({ robotId: MOCK_ROBOT.id, type: "new", deliverySort: "fixed", executeTask: true });
      expect(body.trays.map((t) => t.destinations[0].destination)).toEqual(["2601", "2602"]);
      const order = (await db().select().from(schema.deliveryOrders).where(eq(schema.deliveryOrders.id, r.id)))[0];
      expect(order.status).toBe("ACCEPTED");
      // 중복 클릭 방지
      await expect(dispatchDelivery(hq, { robotId: "DR-MOCKFLASH01", trays: [{ destination: "2603" }] })).rejects.toThrow(/방금 보낸/);
      // 도착: 지시할 때 고른 사람(u-site-a)에게 — 목적지 수신자(u-hq)가 아니라
      const ref = body.trays[0].destinations[0].id;
      await ingestAgentNotify(deliveryMsg("Arrived", Date.now() - 1000, "2601", { id: ref, type: "remote" }));
      await processDeliveryEvents();
      const leg = (await db().select().from(schema.deliveryLegs).where(eq(schema.deliveryLegs.taskRef, ref)))[0];
      expect(leg.notifyResult).toContain("이현장");
      expect(leg.notifyResult).not.toContain("김본사");
      // 두 번째 트레이 취소 → 취소 알림(2602 는 목적지 수신자가 없으므로 기본 수신자도 없으면 안 감)
      await saveDeliveryRecipients(hq, { siteId: "site-01", destination: "*", userIds: ["u-hq"], channels: ["EMAIL"] });
      const ref2 = body.trays[1].destinations[0].id;
      await ingestAgentNotify(deliveryMsg("OnTheWay", Date.now() - 900, "2602", { id: ref2 }));
      await ingestAgentNotify(deliveryMsg("Cancel", Date.now() - 800, "2602", { id: ref2 }));
      await processDeliveryEvents();
      const c = (await db().select().from(schema.deliveryLegs).where(eq(schema.deliveryLegs.taskRef, ref2)))[0];
      expect(c.status).toBe("Cancel");
      expect(c.notifyResult).toContain("취소 알림");
      expect((await db().select().from(schema.notificationLogs).where(eq(schema.notificationLogs.refId, `${c.id}:cancel`))).length).toBe(1);
      // 취소·완료된 배송은 재알림하지 않고, 도착 알림 받은 미수령 건만 재알림
      expect(await sendDeliveryReminders(new Date(Date.now() + 10 * 60_000).toISOString())).toBe(1);
    });

    it("거부: 고객·사업장 원격 제어 꺼짐(감사 DENIED)·없는 목적지·로봇 배송 중·에이전트 거부(실패 기록)", async () => {
      const hq = await setup();
      await expect(dispatchDelivery(await user("u-cust-1"), { robotId: "DR-MOCKFLASH01", trays: [{ destination: "2601" }] })).rejects.toThrow();
      await expect(dispatchDelivery(hq, { robotId: "DR-MOCKFLASH01", trays: [{ destination: "없는곳" }] })).rejects.toThrow(/지도에 없는/);
      await db().update(schema.sites).set({ remoteControlEnabled: false }).where(eq(schema.sites.id, "site-01"));
      await expect(dispatchDelivery(hq, { robotId: "DR-MOCKFLASH01", trays: [{ destination: "2601" }] })).rejects.toThrow(/원격 제어/);
      const denied = await db().select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "DELIVERY:DELIVERY"), eq(schema.auditLogs.result, "DENIED")));
      expect(denied.some((a) => a.detail === "사업장 원격 제어 꺼짐")).toBe(true);
      await db().update(schema.sites).set({ remoteControlEnabled: true }).where(eq(schema.sites.id, "site-01"));
      const r = (await db().query.deliveryRobots.findFirst({ where: eq(schema.deliveryRobots.id, "DR-MOCKFLASH01") }))!;
      await db().update(schema.deliveryRobots).set({ lastState: { ...(r.lastState ?? {}), robotState: "BUSY" } }).where(eq(schema.deliveryRobots.id, r.id));
      await expect(dispatchDelivery(hq, { robotId: "DR-MOCKFLASH01", trays: [{ destination: "2601" }] })).rejects.toThrow(/배송 중/);
      // 호출은 배송 중에도 가능(끝난 뒤 수행). 에이전트가 거부하면 실패로 기록하고 오류
      agentMockState.rejectNext = true;
      await expect(callDeliveryRobot(hq, { robotId: "DR-MOCKFLASH01", destination: "2601" })).rejects.toThrow();
      const failed = (await db().select().from(schema.deliveryOrders).where(eq(schema.deliveryOrders.status, "FAILED")))[0];
      expect(failed.kind).toBe("CALL");
      expect(agentMockState.commands.every((c) => c.path !== "/api/robot/action" && c.path !== "/api/robot/custom/call")).toBe(true);
    });

    it("막힘은 정해진 시간 넘게 이어질 때 한 번, 운행 오류는 바로 한 번 — 기본 수신자에게", async () => {
      const hq = await setup();
      await saveDeliveryRecipients(hq, { siteId: "site-01", destination: "*", userIds: ["u-hq"], channels: ["EMAIL"] });
      const t = Date.now() - 5 * 60_000;
      await ingestAgentNotify({ msgId: "mv1", msgType: "notifyRobotMoveState", robotId: MOCK_ROBOT.id, timestamp: t, data: { state: "Stuck", errors: [] } });
      await processDeliveryEvents();
      expect(await checkStuckRobots()).toBe(1);
      expect(await checkStuckRobots()).toBe(0);
      await ingestAgentNotify({ msgId: "mv2", msgType: "notifyRobotMoveState", robotId: MOCK_ROBOT.id, timestamp: t + 60_000, data: { state: "Moving" } });
      await ingestAgentNotify({ msgId: "mv3", msgType: "notifyRobotMoveState", robotId: MOCK_ROBOT.id, timestamp: t + 120_000, data: { state: "Error", errors: [{ errorType: "LaserError", level: "Error", detail: "레이저 이상" }] } });
      await ingestAgentNotify({ msgId: "mv4", msgType: "notifyRobotMoveState", robotId: MOCK_ROBOT.id, timestamp: t + 130_000, data: { state: "Error", errors: [] } });
      await processDeliveryEvents();
      const logs = await db().select().from(schema.notificationLogs).where(eq(schema.notificationLogs.kind, "DELIVERY"));
      expect(logs.filter((l) => l.refId?.includes(":STUCK:")).length).toBe(1);
      expect(logs.filter((l) => l.refId?.includes(":ERROR:")).length).toBe(1);
    });
  });
});