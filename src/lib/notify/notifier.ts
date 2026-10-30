import type { Incident, NotificationLog, NotificationRecipient, NotificationSetting } from "@/lib/domain/types";
import { SEVERITY_LABEL, SEVERITY_ORDER } from "@/lib/domain/status";
import { formatDateTime, localHourMinute, minutesBetween } from "@/lib/util/time";
import { newId } from "@/lib/util/random";
import { getRobot, getSite } from "@/lib/db/repo";
import { emailConfig, renderEmail, sendEmail } from "./email";
import { kakaoConfig, sendKakaoToUser } from "./kakao";

/**
 * 알림 발송 모듈(교체 가능).
 * - 이메일: AWS SES(MAIL_MODE=live + 설정) → 실제 발송, 아니면 모의.
 * - 카카오톡: 수신 주소가 "user:<사용자 ID>" 이고 카카오 연동이 설정되면 그 사용자 본인에게 '나에게 보내기'. 전화번호 수신(알림톡)은 발송대행사 선정 전이라 모의.
 * 발송 결과는 장애 건의 알림 기록(notification_logs)에 SENT / MOCK_SENT / SUPPRESSED / FAILED 로 남는다.
 */
export type ChannelMode = "live" | "mock";
export function channelModes(): { EMAIL: ChannelMode; KAKAO: ChannelMode } {
  return { EMAIL: emailConfig() ? "live" : "mock", KAKAO: kakaoConfig() ? "live" : "mock" };
}

export const KAKAO_USER_PREFIX = "user:";

export interface Message {
  subject: string; // 이메일 제목
  title: string; // 본문 머리말
  lines: string[]; // "항목: 값"
  url: string; // 관제 화면 링크
}

/** 수신자 한 명에게 실제/모의 발송. */
export async function deliver(r: Pick<NotificationRecipient, "channel" | "address">, m: Message): Promise<{ status: NotificationLog["status"]; reason: string }> {
  const modes = channelModes();
  if (r.channel === "EMAIL") {
    if (modes.EMAIL === "mock") return { status: "MOCK_SENT", reason: "모의 발송(이메일 설정 전 — 실제 전송 없음)" };
    const { text, html } = renderEmail(m.title, m.lines, m.url);
    const res = await sendEmail(r.address, m.subject, text, html);
    return { status: res.ok ? "SENT" : "FAILED", reason: res.reason };
  }
  if (!r.address.startsWith(KAKAO_USER_PREFIX)) return { status: "MOCK_SENT", reason: "모의 발송(전화번호 알림톡 — 발송대행사 선정 전)" };
  if (modes.KAKAO === "mock") return { status: "MOCK_SENT", reason: "모의 발송(카카오 연동 설정 전 — 실제 전송 없음)" };
  const text = [m.title, ...m.lines].join("\n");
  const res = await sendKakaoToUser(r.address.slice(KAKAO_USER_PREFIX.length), text, m.url);
  return { status: res.ok ? "SENT" : "FAILED", reason: res.reason };
}

function withinHours(now: string, from: string, to: string, tz: string): boolean {
  const hm = localHourMinute(now, tz);
  return from <= to ? from <= hm && hm <= to : hm >= from || hm <= to; // 22:00~06:00 같은 자정 넘김도 허용
}

const KIND_LABEL = { OCCURRED: "장애 발생", RESOLVED: "장애 복구", ESCALATED: "미조치 확대 통보" } as const;

async function incidentMessage(incident: Incident, kind: keyof typeof KIND_LABEL, tz: string, now: string): Promise<Message> {
  const site = await getSite(incident.siteId);
  const robot = await getRobot(incident.robotId);
  const base = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  const label = KIND_LABEL[kind];
  const lines = [
    `사업장: ${site?.name ?? incident.siteId}`,
    `로봇: ${robot?.name ?? incident.robotId}`,
    `내용: ${incident.customerMessage}`,
    `등급: ${SEVERITY_LABEL[incident.severity] ?? incident.severity}`,
    `발생: ${formatDateTime(incident.occurredAt, tz)}`,
    ...(kind === "RESOLVED" ? [`복구: ${formatDateTime(now, tz)}`] : []),
    ...(kind === "ESCALATED" ? [`경과: ${Math.round(minutesBetween(incident.occurredAt, now))}분째 미조치`] : []),
  ];
  return { subject: `[청소로봇 ${label}] ${site?.name ?? ""} ${robot?.name ?? ""} — ${incident.customerMessage}`.slice(0, 150), title: `[${label}] ${site?.name ?? ""} · ${robot?.name ?? ""}`, lines, url: `${base}/incidents?site=${encodeURIComponent(incident.siteId)}` };
}

/**
 * 장애 통보. 수신자 설정(등급·시간대·중복 억제)을 적용하고 발송 기록을 돌려준다.
 * 상태 이벤트와 고객 통보를 분리한다: 이 함수는 "장애 통보"만 담당한다.
 */
export async function notifyIncident(
  setting: NotificationSetting | undefined,
  incident: Incident,
  recentSameIncidentNotifiedAt: string | null,
  now: string,
  tz: string,
  kind: "OCCURRED" | "RESOLVED" | "ESCALATED",
): Promise<NotificationLog[]> {
  if (!setting || setting.recipients.length === 0) return [];
  const logs: NotificationLog[] = [];
  let message: Message | null = null;
  for (const r of setting.recipients) {
    const base = { id: newId("ntf"), at: now, channel: r.channel, recipient: r.address };
    if (SEVERITY_ORDER[incident.severity] < SEVERITY_ORDER[r.minSeverity]) {
      logs.push({ ...base, status: "SUPPRESSED", reason: `장애 등급 ${incident.severity} < 수신 기준 ${r.minSeverity}` });
      continue;
    }
    if (!withinHours(now, r.hoursFrom, r.hoursTo, tz)) {
      logs.push({ ...base, status: "SUPPRESSED", reason: `수신 시간대(${r.hoursFrom}~${r.hoursTo}) 외` });
      continue;
    }
    if (kind === "OCCURRED" && recentSameIncidentNotifiedAt && minutesBetween(recentSameIncidentNotifiedAt, now) < setting.dedupeMinutes) {
      logs.push({ ...base, status: "SUPPRESSED", reason: `${setting.dedupeMinutes}분 내 동일 장애 중복 억제` });
      continue;
    }
    message ??= await incidentMessage(incident, kind, tz, now);
    const res = await deliver(r, message);
    logs.push({ ...base, status: res.status, reason: `${KIND_LABEL[kind]} — ${res.reason}` });
  }
  return logs;
}

/** 시험 발송(관리 설정·내 계정의 '시험 발송' 버튼). 장애 기록 없이 보낸다. */
export async function sendTestMessage(r: Pick<NotificationRecipient, "channel" | "address">, who: string): Promise<{ status: NotificationLog["status"]; reason: string }> {
  const base = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  return deliver(r, {
    subject: "[청소로봇 관제] 알림 시험 발송",
    title: "[시험] 청소로봇 관제 알림",
    lines: [`요청: ${who}`, `시각: ${formatDateTime(new Date().toISOString())}`, "내용: 알림 설정 확인용 시험 메시지입니다."],
    url: `${base}/incidents`,
  });
}
