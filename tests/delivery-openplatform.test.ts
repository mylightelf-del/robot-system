import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { PuduApi } from "@/lib/vendors/pudu/api";
import { macToRobotId, opTimestampMs, opToAgentNotify, pascal } from "@/lib/delivery/openplatform";
import { dispatchDelivery, getDeliveryHealth, processDeliveryEvents, saveDeliveryRecipients, setDeliveryRobotSite, syncOpenPlatformCatalog, syncOpenPlatformState } from "@/lib/services/delivery";
import { processPuduEvents } from "@/worker/pudu";
import { getDb, resetAndSeed, schema, user } from "./helpers";

/** 운영 수신 원문(2026-11-12)의 형식을 따른 시험값. SN·MAC·매장은 가짜. */
const SN = "TESTFLASH0001";
const MAC = "AA:BB:CC:00:11:22";
const RID = "aabbcc001122";
function deliveryCb(status: string, ts: number, dest = "227") {
  return {
    callback_type: "notifyDeliveryTask",
    data: {
      sn: SN,
      mac: MAC,
      trays: [{ destinations: [{ id: "", type: "MANUAL", status, timeout: false, map_info: { map_code: "", map_name: "" }, spend_time: 88, destination: dest, complete_type: "", estimated_time: 885 }] }, { destinations: [] }],
      task_id: "",
      task_type: "",
      timestamp: ts,
      spent_time: 0,
      task_status: "",
      is_over_time: false,
      delivery_mode: "GENERAL",
      notify_timestamp: 0,
    },
  };
}

const fakeApi = (online = true) =>
  ({
    listRobots: async () => ({ list: [{ sn: SN, mac: MAC, shop_id: 900001, shop_name: "시험 매장", product_code: "FlashBot", nickname: "시험 플래시봇" }, { sn: "PUDU-SN-001", mac: "00:00:00:00:00:01", shop_id: 900001, shop_name: "시험 매장", nickname: "청소로봇" }] }),
    listMaps: async () => ({ shop_id: 900001, list: [{ name: "시험지도", floor: "1", is_used: 1 }] }),
    mapDetail: async () => ({ map_name: "시험지도", url: "", width: 1, height: 1, resolution: 0.05, origin: [0, 0, 0], element_list: [{ id: "1", name: "227", type: "source", vector_list: [] }, { id: "2", name: "충전대", type: "chargeWorkStation", vector_list: [] }, { id: "3", name: "구역1", type: "area", vector_list: [] }] }),
    statusV2: async () => ({ sn: SN, mac: MAC, timestamp: "1794176507", battery: 76, is_charging: 1, run_state: online ? "IDLE" : "OFFLINE", move_state: "IDLE" }),
  }) as unknown as PuduApi;

describe("배송 신형 경로 — 콜백 변환", () => {
  it("MAC·상태·시간 단위를 에이전트 꼴로 바꾼다", () => {
    expect(macToRobotId("08:E9:F6:CF:1E:70")).toBe("08e9f6cf1e70");
    expect(pascal("ON_THE_WAY")).toBe("OnTheWay");
    expect(pascal("STUCK")).toBe("Stuck");
    expect(opTimestampMs({ timestamp: 1794176507, notify_timestamp: 0 })).toBe(1794176507000);
    const n = opToAgentNotify(deliveryCb("ON_THE_WAY", 1794176507), RID, "op:1")!;
    expect(n.msgType).toBe("notifyDeliveryTask");
    const d = (n.data!.trays as { destinations: Record<string, unknown>[] }[])[0].destinations[0];
    expect(d).toMatchObject({ destination: "227", status: "OnTheWay", type: "manual", spendTime: 88_000, estimatedTime: 885_000 });
    expect(opToAgentNotify({ callback_type: "notifyCleanStatus", data: { sn: SN } }, RID, "op:2")).toBeNull();
  });
});

describe("배송 신형 경로 — 등록·상태·콜백·지시", () => {
  const fetchCalls: { url: string; body: unknown }[] = [];
  beforeAll(() => {
    process.env.PUDU_DELIVERY_SHOP_IDS = "900001";
    process.env.PUDU_API_APP_KEY = process.env.PUDU_API_APP_KEY ?? "test-key";
    process.env.PUDU_API_APP_SECRET = process.env.PUDU_API_APP_SECRET ?? "test-secret";
    process.env.PUDU_API_CLUSTER = process.env.PUDU_API_CLUSTER ?? "sea";
    vi.stubGlobal("fetch", async (url: string, init: { body?: string }) => {
      fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ message: "SUCCESS", trace_id: "t", data: { code: 0, message: "ok", taskId: "OP-TASK-1" } }), { status: 200 });
    });
  });
  afterAll(() => {
    delete process.env.PUDU_DELIVERY_SHOP_IDS;
    vi.unstubAllGlobals();
  });
  beforeEach(async () => {
    await resetAndSeed();
    fetchCalls.length = 0;
  });

  it("지정 매장의 비청소 로봇만 신형으로 등록하고, 지도 목적지·상태를 받는다", async () => {
    // 청소로봇으로 이미 등록된 SN 은 건너뛴다
    await getDb().update(schema.robots).set({ vendorRobotId: "PUDU-SN-001" }).where(eq(schema.robots.vendor, "PUDU"));
    const r = await syncOpenPlatformCatalog(fakeApi());
    expect(r.ok).toBe(true);
    const rows = await getDb().select().from(schema.deliveryRobots);
    expect(rows.map((x) => x.agentRobotId)).toEqual([RID]);
    expect(rows[0]).toMatchObject({ source: "openplatform", sn: SN, shopId: "900001", name: "시험 플래시봇" });
    expect(rows[0].destinations.map((d) => d.name)).toEqual(["227", "충전대"]);

    expect((await syncOpenPlatformState(fakeApi(false))).ok).toBe(true);
    let s = (await getDb().query.deliveryRobots.findFirst({ where: eq(schema.deliveryRobots.agentRobotId, RID) }))!;
    expect(s.lastSeenAt).toBeNull(); // 오프라인은 수신으로 치지 않음
    await syncOpenPlatformState(fakeApi(true));
    s = (await getDb().query.deliveryRobots.findFirst({ where: eq(schema.deliveryRobots.agentRobotId, RID) }))!;
    expect(s.lastState).toMatchObject({ robotState: "FREE", robotPower: 76, online: true, mapName: "시험지도" });
    expect(s.lastSeenAt).not.toBeNull();
    const h = await getDeliveryHealth(await user("u-hq"));
    expect(h.op.enabled).toBe(true);
  });

  it("오픈플랫폼 콜백: 등록 로봇은 배송 구간·도착 알림으로, 미등록 로봇은 건드리지 않음", async () => {
    const hq = await user("u-hq");
    await syncOpenPlatformCatalog(fakeApi());
    await setDeliveryRobotSite(hq, `DR-${RID}`, "site-01");
    await saveDeliveryRecipients(hq, { siteId: "site-01", destination: "227", userIds: ["u-hq"], channels: ["EMAIL"] });
    const t = Math.floor(Date.now() / 1000) - 120;
    const ev = (i: number, payload: unknown) => ({ id: `vev-op-${i}`, vendor: "PUDU" as const, eventType: "notifyDeliveryTask", vendorRobotId: SN, eventKey: `op-${i}`, receivedAt: new Date().toISOString(), occurredAt: null, payload });
    await getDb().insert(schema.vendorEvents).values([
      ev(1, deliveryCb("ON_THE_WAY", t)),
      ev(2, deliveryCb("ARRIVED", t + 60)),
      ev(3, { ...deliveryCb("ARRIVED", t + 60), data: { ...deliveryCb("ARRIVED", t + 60).data, sn: "OTHER-CUSTOMER", mac: "11:11:11:11:11:11" } }),
    ]);
    await processPuduEvents();
    expect((await getDb().select().from(schema.deliveryEvents)).length).toBe(2);
    expect((await processDeliveryEvents()).counts.errors).toBe(0);
    const legs = await getDb().select().from(schema.deliveryLegs);
    expect(legs.length).toBe(1);
    expect(legs[0]).toMatchObject({ destination: "227", status: "Arrived", siteId: "site-01" });
    expect(legs[0].notifiedAt).not.toBeNull();
    expect(await getDb().select().from(schema.deliveryRobots).where(eq(schema.deliveryRobots.sn, "OTHER-CUSTOMER"))).toEqual([]); // 다른 고객사 로봇은 만들지 않음
  });

  it("배송 보내기: 신형은 클라우드 delivery_task 로 보내고 지시 기록을 남긴다, 호출은 준비 중", async () => {
    const hq = await user("u-hq");
    await syncOpenPlatformCatalog(fakeApi());
    await syncOpenPlatformState(fakeApi(true));
    await setDeliveryRobotSite(hq, `DR-${RID}`, "site-01");
    const r = await dispatchDelivery(hq, { robotId: `DR-${RID}`, trays: [{ destination: "227" }] });
    expect(r.message).toContain("클라우드 접수");
    const call = fetchCalls.find((c) => c.url.includes("/open-platform-service/v1/delivery_task"))!;
    expect(call.body).toMatchObject({ sn: SN, shopId: "900001", payload: { deliverySort: "fixed", executeTask: true, trays: [{ destinations: [{ destination: "227", mapInfo: { mapName: "시험지도" } }] }] } });
    const orders = await getDb().select().from(schema.deliveryOrders);
    expect(orders[0]).toMatchObject({ status: "ACCEPTED" });
  });
});
