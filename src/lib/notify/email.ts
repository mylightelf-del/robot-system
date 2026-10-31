/**
 * 이메일 발송 — AWS SES v2 (프로젝트 리전 ap-southeast-2).
 * 서버 .env: MAIL_MODE=live, MAIL_FROM("표시이름 <주소>"), SES_ACCESS_KEY_ID/SES_SECRET_ACCESS_KEY(발송 전용 IAM 사용자, 정책: ses:SendEmail 만, 발신 주소 제한), SES_REGION.
 * SES 가 샌드박스 상태면 '인증된 주소'로만 보낼 수 있다(하루 200통). 정식 발송은 SES 프로덕션 접근 승인 뒤.
 * MAIL_MODE 가 live 가 아니거나 설정이 빠지면 모의 발송으로 기록한다(실제 전송 없음).
 */
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

export interface EmailConfig {
  from: string;
  /** 보내는 주소가 아직 SES 에서 확인되지 않아 거부되면 이 주소로 다시 보낸다(도메인 DKIM 확인 대기 중). */
  fallbackFrom: string | null;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function emailConfig(): EmailConfig | null {
  if (process.env.MAIL_MODE !== "live") return null;
  const from = process.env.MAIL_FROM || "";
  const accessKeyId = process.env.SES_ACCESS_KEY_ID || "";
  const secretAccessKey = process.env.SES_SECRET_ACCESS_KEY || "";
  if (!from || !accessKeyId || !secretAccessKey) return null;
  return { from, fallbackFrom: process.env.MAIL_FROM_FALLBACK || null, region: process.env.SES_REGION || "ap-southeast-2", accessKeyId, secretAccessKey };
}

type Sender = (input: { from: string; to: string; subject: string; text: string; html: string }) => Promise<{ messageId: string }>;
let senderOverride: Sender | null = null;
/** 시험용: SES 대신 쓸 발송 함수(실제 전송 없음). */
export function setEmailSenderForTest(s: Sender | null): void {
  senderOverride = s;
}

let client: SESv2Client | null = null;
function sesSender(cfg: EmailConfig): Sender {
  client ??= new SESv2Client({ region: cfg.region, credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } });
  return async ({ from, to, subject, text, html }) => {
    const out = await client!.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: subject, Charset: "UTF-8" }, Body: { Text: { Data: text, Charset: "UTF-8" }, Html: { Data: html, Charset: "UTF-8" } } } },
      }),
    );
    return { messageId: out.MessageId ?? "" };
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** 알림 메일 본문(텍스트 + 간단한 HTML). lines 는 "항목: 값" 줄. */
export function renderEmail(title: string, lines: string[], url: string): { text: string; html: string } {
  const text = `${title}\n\n${lines.join("\n")}\n\n관제 화면: ${url}\n\n— 청소로봇 통합관제(자동 발송, 회신 불가)`;
  const rows = lines
    .map((l) => {
      const i = l.indexOf(":");
      return i > 0 ? `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;white-space:nowrap">${esc(l.slice(0, i))}</td><td style="padding:4px 0">${esc(l.slice(i + 1).trim())}</td></tr>` : `<tr><td colspan="2" style="padding:4px 0">${esc(l)}</td></tr>`;
    })
    .join("");
  const html = `<div style="font-family:'Malgun Gothic',Apple SD Gothic Neo,sans-serif;font-size:14px;color:#111827;max-width:560px">
<div style="background:#1e3a5f;color:#fff;padding:12px 16px;font-weight:bold">${esc(title)}</div>
<table style="border-collapse:collapse;margin:12px 16px">${rows}</table>
<div style="margin:8px 16px 16px"><a href="${esc(url)}" style="background:#1e3a5f;color:#fff;padding:8px 14px;text-decoration:none;border-radius:4px">관제 화면 열기</a></div>
<div style="margin:0 16px 12px;color:#6b7280;font-size:12px">청소로봇 통합관제 자동 발송 메일입니다. 회신하지 마세요.</div></div>`;
  return { text, html };
}

export async function sendEmail(to: string, subject: string, text: string, html: string): Promise<{ ok: boolean; reason: string }> {
  const cfg = emailConfig();
  if (!cfg && !senderOverride) return { ok: false, reason: "이메일 발송 미설정" };
  const send = senderOverride ?? sesSender(cfg!);
  const from = cfg?.from ?? "test@example.invalid";
  try {
    const { messageId } = await send({ from, to, subject, text, html });
    return { ok: true, reason: `이메일 발송(SES ${messageId.slice(0, 12)}…)` };
  } catch (first) {
    let e = first;
    const err0 = first as { name?: string; message?: string };
    // 보내는 주소(도메인) 확인 전: "Email address is not verified ... <보내는 주소>" → 대체 주소로 한 번 더
    const senderUnverified = err0.name === "MessageRejected" && /not verified/i.test(String(err0.message)) && String(err0.message).includes(from.replace(/^.*<|>$/g, ""));
    if (senderUnverified && cfg?.fallbackFrom) {
      try {
        const { messageId } = await send({ from: cfg.fallbackFrom, to, subject, text, html });
        return { ok: true, reason: `이메일 발송(대체 주소, SES ${messageId.slice(0, 12)}…)` };
      } catch (e2) {
        e = e2;
      }
    }
    const err = e as { name?: string; message?: string };
    // 샌드박스에서 인증 안 된 수신자: MessageRejected "Email address is not verified"
    return { ok: false, reason: `이메일 발송 실패: ${err.name ?? "Error"} ${String(err.message ?? "").slice(0, 200)}` };
  }
}
