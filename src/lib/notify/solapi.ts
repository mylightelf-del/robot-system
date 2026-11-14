import { createHmac, randomBytes } from "node:crypto";

/**
 * 솔라피(SOLAPI) 카카오 알림톡 발송. 문서: https://solapi.com/developers/api/messages-ata
 * - 인증: Authorization: HMAC-SHA256 apiKey=<키>, date=<ISO 시각>, salt=<무작위>, signature=hex(HMAC-SHA256(시크릿, date + salt))
 * - 발송: POST https://api.solapi.com/messages/v4/send-many/detail  { messages: [{ to, from?, kakaoOptions: { pfId, templateId, variables, disableSms } }] }
 * - 알림톡은 검수된 템플릿만 보낼 수 있다. 템플릿 변수 키는 "#{목적지}" 형식, 값은 문자열.
 * 키·시크릿은 서버 .env 에서만 읽고 로그·오류 문구에 넣지 않는다.
 */
export interface SolapiConfig {
  apiKey: string;
  apiSecret: string;
  /** 카카오 채널(발신 프로필) ID */
  pfId: string;
  /** 알림톡 실패 시 문자 대체 발송 번호(솔라피에 등록한 발신번호). 없으면 대체 발송 안 함. */
  sender: string | null;
  /** 템플릿 키 → 솔라피 템플릿 ID */
  templates: Record<string, string>;
  baseUrl: string;
}

export function solapiConfig(): SolapiConfig | null {
  const apiKey = process.env.SOLAPI_API_KEY;
  const apiSecret = process.env.SOLAPI_API_SECRET;
  const pfId = process.env.SOLAPI_PFID;
  if (!apiKey || !apiSecret || !pfId) return null;
  let templates: Record<string, string> = {};
  try {
    templates = JSON.parse(process.env.SOLAPI_TEMPLATES || "{}");
  } catch {
    templates = {};
  }
  return { apiKey, apiSecret, pfId, sender: process.env.SOLAPI_SENDER || null, templates, baseUrl: (process.env.SOLAPI_BASE_URL || "https://api.solapi.com").replace(/\/$/, "") };
}

export function solapiAuthHeader(apiKey: string, apiSecret: string, date = new Date().toISOString(), salt = randomBytes(16).toString("hex")): string {
  const signature = createHmac("sha256", apiSecret).update(date + salt).digest("hex");
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

/** "010-1234-5678" → "01012345678". 국내 휴대폰 형식이 아니면 null. */
export function normalizePhone(raw: string | null | undefined): string | null {
  const d = String(raw ?? "").replace(/\D/g, "").replace(/^82(?=1)/, "0");
  return /^01[016789]\d{7,8}$/.test(d) ? d : null;
}

type Sender = (url: string, init: RequestInit) => Promise<Response>;
let senderForTest: Sender | null = null;
export function setSolapiFetchForTest(f: Sender | null): void {
  senderForTest = f;
}

/** 템플릿 키(예: DELIVERY_ARRIVED)와 변수로 알림톡 1건 발송. */
export async function sendAlimtalk(cfg: SolapiConfig, to: string, templateKey: string, variables: Record<string, string>): Promise<{ ok: boolean; reason: string }> {
  const phone = normalizePhone(to);
  if (!phone) return { ok: false, reason: "휴대폰 번호 형식 오류" };
  const templateId = cfg.templates[templateKey];
  if (!templateId) return { ok: false, reason: `알림톡 템플릿 미등록(${templateKey}) — SOLAPI_TEMPLATES 에 검수된 템플릿 ID 를 넣으세요` };
  const message: Record<string, unknown> = {
    to: phone,
    kakaoOptions: { pfId: cfg.pfId, templateId, variables: Object.fromEntries(Object.entries(variables).map(([k, v]) => [k, String(v)])), disableSms: !cfg.sender },
  };
  if (cfg.sender) message.from = cfg.sender;
  try {
    const res = await (senderForTest ?? fetch)(`${cfg.baseUrl}/messages/v4/send-many/detail`, {
      method: "POST",
      headers: { Authorization: solapiAuthHeader(cfg.apiKey, cfg.apiSecret), "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [message] }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => null)) as { failedMessageList?: { statusCode?: string; statusMessage?: string }[]; errorCode?: string; errorMessage?: string; groupInfo?: { count?: { registeredFailed?: number } } } | null;
    if (!res.ok) return { ok: false, reason: `솔라피 HTTP ${res.status}${json?.errorCode ? ` ${json.errorCode}` : ""}${json?.errorMessage ? `: ${json.errorMessage}` : ""}` };
    const failed = json?.failedMessageList ?? [];
    if (failed.length) return { ok: false, reason: `솔라피 접수 실패: ${failed[0].statusCode ?? ""} ${failed[0].statusMessage ?? ""}`.trim() };
    return { ok: true, reason: "솔라피 접수(알림톡)" };
  } catch (e) {
    return { ok: false, reason: `솔라피 연결 실패: ${(e as Error).message}` };
  }
}

/**
 * 템플릿 초안(솔라피 콘솔에서 등록·검수). 변수는 #{...}. 버튼: 웹링크 「배송 화면」 → https://widebot.kro.kr/delivery
 * 검수 뒤 받은 템플릿 ID 를 SOLAPI_TEMPLATES={"DELIVERY_ARRIVED":"KA01TP...", ...} 로 서버 .env 에 넣는다.
 */
export const ALIMTALK_TEMPLATE_DRAFTS: Record<string, string> = {
  DELIVERY_ARRIVED: "[Wide Bot] 배송 도착 안내\n배송로봇이 #{목적지}에 도착했습니다.\n\n- 로봇: #{로봇}\n- 도착 시각: #{시각}\n\n수령 후 로봇 화면에서 확인(완료)을 눌러 주세요.",
  DELIVERY_REMIND: "[Wide Bot] 배송 수령 안내\n#{목적지}에 도착한 배송을 아직 수령하지 않았습니다.\n\n- 로봇: #{로봇}\n- 도착 시각: #{시각}\n\n수령 후 로봇 화면에서 확인(완료)을 눌러 주세요.",
  DELIVERY_CANCEL: "[Wide Bot] 배송 취소 안내\n#{목적지} 배송이 취소되었습니다.\n\n- 로봇: #{로봇}\n\n보낸 분께 확인해 주세요.",
  DELIVERY_PROBLEM: "[Wide Bot] 배송로봇 이상 안내\n배송로봇 #{로봇}에 이상이 있습니다.\n\n- 내용: #{내용}\n- 시각: #{시각}\n\n현장 확인이 필요합니다.",
};
