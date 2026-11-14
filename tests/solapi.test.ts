import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { normalizePhone, sendAlimtalk, setSolapiFetchForTest, solapiAuthHeader, solapiConfig } from "@/lib/notify/solapi";
import { deliver } from "@/lib/notify/notifier";

const ENV = { SOLAPI_API_KEY: "test-key", SOLAPI_API_SECRET: "test-secret", SOLAPI_PFID: "KA01PF-test", SOLAPI_TEMPLATES: JSON.stringify({ DELIVERY_ARRIVED: "KA01TP-arrived" }) };

describe("솔라피 알림톡", () => {
  afterEach(() => {
    setSolapiFetchForTest(null);
    for (const k of [...Object.keys(ENV), "SOLAPI_SENDER"]) delete process.env[k];
  });

  it("인증 헤더: HMAC-SHA256(시크릿, date+salt) hex", () => {
    const h = solapiAuthHeader("k", "s", "2026-11-14T00:00:00.000Z", "abc");
    const sig = createHmac("sha256", "s").update("2026-11-14T00:00:00.000Zabc").digest("hex");
    expect(h).toBe(`HMAC-SHA256 apiKey=k, date=2026-11-14T00:00:00.000Z, salt=abc, signature=${sig}`);
  });

  it("휴대폰 번호 정규화", () => {
    expect(normalizePhone("010-1234-5678")).toBe("01012345678");
    expect(normalizePhone("+82 10 1234 5678")).toBe("01012345678");
    expect(normalizePhone("02-123-4567")).toBeNull();
    expect(normalizePhone("")).toBeNull();
  });

  it("발송 본문: pfId·templateId·변수(문자열)·문자 대체 없음, 실패 목록은 실패로", async () => {
    Object.assign(process.env, ENV);
    const cfg = solapiConfig()!;
    let body: { messages: { to: string; kakaoOptions: { pfId: string; templateId: string; variables: Record<string, string>; disableSms: boolean } }[] } | null = null;
    let auth = "";
    setSolapiFetchForTest(async (_url, init) => {
      body = JSON.parse(String(init.body));
      auth = String((init.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify({ groupInfo: {}, failedMessageList: [] }), { status: 200 });
    });
    const r = await sendAlimtalk(cfg, "010-1111-2222", "DELIVERY_ARRIVED", { "#{목적지}": "2601", "#{로봇}": "FlashBot", "#{시각}": "10:05" });
    expect(r.ok).toBe(true);
    expect(body!.messages[0]).toMatchObject({ to: "01011112222", kakaoOptions: { pfId: "KA01PF-test", templateId: "KA01TP-arrived", variables: { "#{목적지}": "2601" }, disableSms: true } });
    expect(auth).toMatch(/^HMAC-SHA256 apiKey=test-key, date=.+, salt=[0-9a-f]+, signature=[0-9a-f]{64}$/);
    expect(auth).not.toContain("test-secret");
    // 템플릿 미등록
    expect((await sendAlimtalk(cfg, "01011112222", "DELIVERY_CANCEL", {})).reason).toMatch(/템플릿 미등록/);
    // 접수 실패 목록
    setSolapiFetchForTest(async () => new Response(JSON.stringify({ failedMessageList: [{ statusCode: "3104", statusMessage: "템플릿 불일치" }] }), { status: 200 }));
    expect((await sendAlimtalk(cfg, "01011112222", "DELIVERY_ARRIVED", {})).ok).toBe(false);
  });

  it("알림 경로: 전화번호 카카오 → 솔라피 미설정이면 모의, 템플릿 없는 알림은 보내지 않음, 설정되면 발송", async () => {
    const m = { subject: "s", title: "t", lines: [], url: "u" };
    expect((await deliver({ channel: "KAKAO", address: "01011112222" }, m)).status).toBe("MOCK_SENT");
    Object.assign(process.env, ENV);
    expect((await deliver({ channel: "KAKAO", address: "01011112222" }, m)).status).toBe("SUPPRESSED");
    setSolapiFetchForTest(async () => new Response(JSON.stringify({ failedMessageList: [] }), { status: 200 }));
    const r = await deliver({ channel: "KAKAO", address: "01011112222" }, { ...m, alimtalk: { template: "DELIVERY_ARRIVED", variables: { "#{목적지}": "2601" } } });
    expect(r.status).toBe("SENT");
  });
});
