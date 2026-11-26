import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import ExcelJS from "exceljs";
import { AgentClient } from "@/lib/delivery/agent";
import { agentMockState, agentMockTransport, MOCK_DEVICE_ID, MOCK_ROBOT } from "@/lib/delivery/mock";
import { readContactsXlsx } from "@/lib/delivery/contactsXlsx";
import { setSolapiFetchForTest } from "@/lib/notify/solapi";
import { addContactPresets, createDeliveryContact, dispatchDelivery, floorToDestination, getDeliveryView, importDeliveryContacts, ingestAgentNotify, listDeliveryPresets, processDeliveryEvents, sendDeliveryReminders, setDeliveryRobotSite, syncDeliveryCatalog, syncDeliveryState, updateDeliveryContact } from "@/lib/services/delivery";
import { getDb, resetAndSeed, schema, user } from "./helpers";

/** 받는 사람 명부·이름 배송·문자 알림. 시험 데이터는 가상의 이름·번호(실명부를 쓰지 않는다). */
const FAKE = [
  { name: "가상일", floor: "8F", dept: "시험부", phone: "010-0000-0001", ext: "0001" },
  { name: "가상이", floor: "5F", dept: "시험부", phone: "010-0000-0002", ext: "0002" },
  { name: "번호없음", floor: "6F", dept: "시험부", phone: "", ext: null },
];
const sms: { to: string; from: string; text: string }[] = [];

describe("배송 받는 사람 명부·문자 알림", () => {
  beforeAll(() => {
    process.env.PUDU_AGENT_MODE = "mock";
    process.env.PUDU_AGENT_REMIND_MINUTES = "3";
    process.env.SOLAPI_API_KEY = "test-key";
    process.env.SOLAPI_API_SECRET = "test-secret";
    process.env.SOLAPI_SENDER = "02-0000-0000";
    setSolapiFetchForTest(async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { messages: { to: string; from: string; text: string }[] };
      sms.push(...body.messages);
      return new Response(JSON.stringify({ failedMessageList: [] }), { status: 200 });
    });
  });
  afterAll(() => {
    setSolapiFetchForTest(null);
    for (const k of ["PUDU_AGENT_MODE", "SOLAPI_API_KEY", "SOLAPI_API_SECRET", "SOLAPI_SENDER"]) delete process.env[k];
  });
  beforeEach(async () => {
    await resetAndSeed();
    sms.length = 0;
    agentMockState.commands.length = 0;
  });

  it("근무층 → 로봇 목적지", () => {
    const d = ["1층", "5층", "8층", "A", "charge10", "지하1층"];
    expect(floorToDestination("8F", d)).toBe("8층");
    expect(floorToDestination("8층", d)).toBe("8층");
    expect(floorToDestination("b1", d)).toBe("지하1층");
    expect(floorToDestination("12F", d)).toBeNull();
    expect(floorToDestination("로비", d)).toBeNull();
  });

  it("엑셀 읽기: 머리글을 찾아 성명·근무층·부서·전화·내선을 읽는다", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("인원명부");
    ws.addRow(["NO", "성명", "근무층", "부서명", "전화번호", "내선번호"]);
    FAKE.forEach((f, i) => ws.addRow([i + 1, f.name, f.floor, f.dept, f.phone, f.ext]));
    const buf = await wb.xlsx.writeBuffer();
    const rows = await readContactsXlsx(buf as ArrayBuffer);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ name: "가상일", floor: "8F", dept: "시험부", phone: "010-0000-0001", ext: "0001" });
    const bad = new ExcelJS.Workbook();
    bad.addWorksheet("x").addRow(["a", "b"]);
    await expect(readContactsXlsx((await bad.xlsx.writeBuffer()) as ArrayBuffer)).rejects.toThrow(/머리글/);
  });

  it("명부 올리기·이름으로 배송 → (솔라피 방식) 그 사람에게 도착 문자·미수령 문자, 화면에는 번호를 가림", async () => {
    process.env.DELIVERY_CONTACT_SMS = "solapi";
    const hq = await user("u-hq");
    await syncDeliveryCatalog(new AgentClient(agentMockTransport, MOCK_DEVICE_ID));
    await syncDeliveryState(new AgentClient(agentMockTransport, MOCK_DEVICE_ID));
    await setDeliveryRobotSite(hq, `DR-${MOCK_ROBOT.id}`, "site-01");

    const r = await importDeliveryContacts(hq, "site-01", FAKE);
    expect(r).toMatchObject({ added: 2, updated: 0, skipped: ["번호없음"] });
    expect((await importDeliveryContacts(hq, "site-01", FAKE.slice(0, 1))).updated).toBe(1); // 같은 이름+번호는 갱신
    const one = (await getDb().select().from(schema.deliveryContacts).where(eq(schema.deliveryContacts.name, "가상일")))[0];
    expect(one.phone).toBe("01000000001");
    await updateDeliveryContact(hq, one.id, { destination: "2601" });

    const view = await getDeliveryView(hq);
    expect(view.contacts.find((c) => c.name === "가상일")).toMatchObject({ phoneMasked: "010-****-0001", destination: "2601" });
    expect(JSON.stringify(view.contacts)).not.toContain("01000000001");

    // 이름 즐겨찾기 → 보내기
    expect((await addContactPresets(hq, [one.id])).created).toBe(1);
    const presets = await listDeliveryPresets(hq, ["site-01"]);
    expect(presets.map((p) => p.name)).toContain("가상일(2601)");

    await dispatchDelivery(hq, { robotId: `DR-${MOCK_ROBOT.id}`, trays: [{ destination: "2601", recipientContactIds: [one.id] }] });
    const taskRef = (agentMockState.commands.at(-1)!.body as { trays: { destinations: { id: string }[] }[] }).trays[0].destinations[0].id;
    const t = Date.now() - 10 * 60_000;
    await ingestAgentNotify({ msgId: "c-1", msgType: "notifyDeliveryTask", robotId: MOCK_ROBOT.id, timestamp: t, data: { trays: [{ destinations: [{ destination: "2601", id: taskRef, status: "Arrived", type: "remote" }] }] } });
    await processDeliveryEvents();
    expect(sms).toHaveLength(1);
    expect(sms[0]).toMatchObject({ to: "01000000001", from: "0200000000" });
    expect(sms[0].text).toContain("가상일님");
    expect(sms[0].text).toContain("2601");
    const leg = (await getDb().select().from(schema.deliveryLegs).where(eq(schema.deliveryLegs.taskRef, taskRef)))[0];
    expect(leg.notifyResult).toContain("가상일 문자 발송");
    const logs = await getDb().select().from(schema.notificationLogs).where(eq(schema.notificationLogs.channel, "SMS"));
    expect(logs[0].recipient).toBe("가상일 010-****-0001"); // 기록에도 번호를 가린다

    expect(await sendDeliveryReminders()).toBe(1);
    expect(sms).toHaveLength(2);
    expect(sms[1].text).toContain("아직 수령");
    delete process.env.DELIVERY_CONTACT_SMS;
  });

  it("(기본) 로봇 문자: 지시에 받는 사람 번호(국가번호 82·앞 0 뺌)를 넣고 Wide Bot 은 문자를 보내지 않는다, 트레이당 1명", async () => {
    const hq = await user("u-hq");
    await syncDeliveryCatalog(new AgentClient(agentMockTransport, MOCK_DEVICE_ID));
    await syncDeliveryState(new AgentClient(agentMockTransport, MOCK_DEVICE_ID));
    await setDeliveryRobotSite(hq, `DR-${MOCK_ROBOT.id}`, "site-01");
    const { id } = await createDeliveryContact(hq, { siteId: "site-01", name: "가상삼", phone: "010-0000-0003", floor: "9F", destination: "2602" });
    const { id: id2 } = await createDeliveryContact(hq, { siteId: "site-01", name: "가상사", phone: "01000000004" });
    await expect(dispatchDelivery(hq, { robotId: `DR-${MOCK_ROBOT.id}`, trays: [{ destination: "2602", recipientContactIds: [id, id2] }] })).rejects.toThrow(/트레이마다 받는 사람 1명/);
    await dispatchDelivery(hq, { robotId: `DR-${MOCK_ROBOT.id}`, trays: [{ destination: "2602", recipientContactIds: [id] }] });
    const dest = (agentMockState.commands.at(-1)!.body as { trays: { destinations: { destination: string; id: string; phoneNum?: string; phoneCode?: string }[] }[] }).trays[0].destinations[0];
    expect(dest).toMatchObject({ destination: "2602", phoneNum: "1000000003", phoneCode: "82" });
    await ingestAgentNotify({ msgId: "r-1", msgType: "notifyDeliveryTask", robotId: MOCK_ROBOT.id, timestamp: Date.now(), data: { trays: [{ destinations: [{ destination: "2602", id: dest.id, status: "Arrived", type: "remote" }] }] } });
    await processDeliveryEvents();
    expect(sms).toHaveLength(0);
    const leg = (await getDb().select().from(schema.deliveryLegs).where(eq(schema.deliveryLegs.taskRef, dest.id)))[0];
    expect(leg.notifyResult).toContain("가상삼 문자: 로봇이 발송");
  });

  it("명부 한 명 추가·수정: 번호 형식·중복 거부, 번호는 바꿀 때만", async () => {
    const hq = await user("u-hq");
    await expect(createDeliveryContact(hq, { siteId: "site-01", name: "가상오", phone: "1234" })).rejects.toThrow(/형식/);
    const { id } = await createDeliveryContact(hq, { siteId: "site-01", name: "가상오", phone: "010-0000-0005", floor: "7F", dept: "시험부" });
    await expect(createDeliveryContact(hq, { siteId: "site-01", name: "가상오", phone: "01000000005" })).rejects.toThrow(/이미 명부/);
    await updateDeliveryContact(hq, id, { name: "가상오수정", dept: "새부서", ext: "1234" });
    let c = (await getDb().select().from(schema.deliveryContacts).where(eq(schema.deliveryContacts.id, id)))[0];
    expect(c).toMatchObject({ name: "가상오수정", dept: "새부서", ext: "1234", phone: "01000000005" });
    await updateDeliveryContact(hq, id, { phone: "010-0000-0055" });
    c = (await getDb().select().from(schema.deliveryContacts).where(eq(schema.deliveryContacts.id, id)))[0];
    expect(c.phone).toBe("01000000055");
    await expect(updateDeliveryContact(hq, id, { phone: "12" })).rejects.toThrow(/형식/);
    await expect(createDeliveryContact(await user("u-site-b"), { siteId: "site-01", name: "x", phone: "01000000006" })).rejects.toThrow(/권한/);
  });

  it("다른 사업장·사용 중지 명부로는 보낼 수 없다", async () => {
    const hq = await user("u-hq");
    await syncDeliveryCatalog(new AgentClient(agentMockTransport, MOCK_DEVICE_ID));
    await syncDeliveryState(new AgentClient(agentMockTransport, MOCK_DEVICE_ID));
    await setDeliveryRobotSite(hq, `DR-${MOCK_ROBOT.id}`, "site-01");
    await importDeliveryContacts(hq, "site-02", FAKE.slice(0, 1));
    const other = (await getDb().select().from(schema.deliveryContacts))[0];
    await expect(dispatchDelivery(hq, { robotId: `DR-${MOCK_ROBOT.id}`, trays: [{ destination: "2601", recipientContactIds: [other.id] }] })).rejects.toThrow(/명부에 없거나/);
    // 현장 담당자는 자기 사업장 명부만
    await expect(importDeliveryContacts(await user("u-site-a"), "site-03", FAKE)).rejects.toThrow(/권한/);
  });
});
