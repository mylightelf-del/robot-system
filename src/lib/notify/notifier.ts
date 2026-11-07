import type { Incident, NotificationLog, NotificationRecipient, NotificationSetting, NotifyKind } from "@/lib/domain/types";
import { SEVERITY_LABEL, SEVERITY_ORDER } from "@/lib/domain/status";
import { formatDateTime, localHourMinute, minutesBetween } from "@/lib/util/time";
import { newId } from "@/lib/util/random";
import { getRobot, getSite, getUser } from "@/lib/db/repo";
import { canAccessSite } from "@/lib/auth/authz";
import { emailConfig, renderEmail, sendEmail, type EmailAttachment } from "./email";
import { kakaoConfig, sendKakaoToUser } from "./kakao";

/**
 * 알림 발송 모듈(교체 가능).
 * - 이메일: AWS SES(MAIL_MODE=live + 설정) → 실제 발송, 아니면 모의. 첨부(보고서 파일)는 이메일에만 붙는다.
 * - 카카오톡: 수신 주소가 "user:<사용자 ID>" 이고 카카오 연동이 설정되면 그 사용자 본인에게 '나에게 보내기'. 전화번호 수신(알림톡)은 발송대행사 선정 전이라 모의.
 * - 수신자는 통보 종류(kinds)·등급·시간대로 거른다. 발송 결과는 notification_logs 에 SENT / MOCK_SENT / SUPPRESSED / FAILED 로 남는다.
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
  /** 이메일 첨부(보고서 PPT·Excel 등). 카카오톡에는 붙지 않고 링크만 간다. */
  attachments?: EmailAttachment[];
}

/** 수신자 한 명에게 실제/모의 발송. */
export async function deliver(r: Pick<NotificationRecipient, "channel" | "address">, m: Message): Promise<{ status: NotificationLog["status"]; reason: string }> {
  const modes = channelModes();
  if (r.channel === "EMAIL") {
    if (modes.EMAIL === "mock") return { status: "MOCK_SENT", reason: "모의 발송(이메일 설정 전 — 실제 전송 없음)" };
    const { text, html } = renderEmail(m.title, m.lines, m.url);
    const res = await sendEmail(r.address, m.subject, text, html, m.attachments);
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

/** 수신자가 이 종류를 받는가(kinds 가 비어 있으면 전부). */
export function receivesKind(r: Pick<NotificationRecipient, "kinds">, kind: NotifyKind): boolean {
  return !r.kinds || r.kinds.length === 0 || r.kinds.includes(kind);
}

export interface NotifyOptions {
  /** 통보 종류(수신자 kinds 필터·기록). */
  kind: NotifyKind;
  /** 기록에 붙일 머리말(억제 사유에도 앞에 붙는다). */
  label: string;
  /** 장애 등급 필터(장애 통보만). */
  severity?: Incident["severity"];
  /** 수신 시간대 필터 적용 여부(보고서는 시간대와 무관하게 보낸다). 기본 적용. */
  applyHours?: boolean;
  /** 같은 대상 ID(계획 회차·로봇·보고서). 기록의 refId. */
  refId?: string | null;
  /** 억제 조건을 추가로 검사(예: 중복 억제). 억제 사유를 돌려주면 보내지 않는다. */
  extraSuppress?: (r: NotificationRecipient) => string | null;
}

/**
 * 사업장 수신자들에게 통보. 종류·등급·시간대·권한을 거르고 발송 기록(저장 전)을 돌려준다.
 * 메시지는 실제로 보낼 수신자가 있을 때 한 번만 만든다(첨부 생성 비용).
 */
export async function notifyRecipients(setting: NotificationSetting | undefined, siteId: string, now: string, tz: string, opts: NotifyOptions, buildMessage: () => Promise<Message>): Promise<NotificationLog[]> {
  if (!setting || setting.recipients.length === 0) return [];
  const logs: NotificationLog[] = [];
  let message: Message | null = null;
  for (const r of setting.recipients) {
    const base = { id: newId("ntf"), at: now, channel: r.channel, recipient: r.address, kind: opts.kind, refId: opts.refId ?? null };
    const suppress = (why: string) => logs.push({ ...base, status: "SUPPRESSED", reason: `${opts.label} — 억제: ${why}` });
    if (!receivesKind(r, opts.kind)) {
      suppress("이 종류의 통보를 받지 않음");
      continue;
    }
    if (opts.severity && SEVERITY_ORDER[opts.severity] < SEVERITY_ORDER[r.minSeverity]) {
      suppress(`장애 등급 ${opts.severity} < 수신 기준 ${r.minSeverity}`);
      continue;
    }
    if (opts.applyHours !== false && !withinHours(now, r.hoursFrom, r.hoursTo, tz)) {
      suppress(`수신 시간대(${r.hoursFrom}~${r.hoursTo}) 외`);
      continue;
    }
    const extra = opts.extraSuppress?.(r);
    if (extra) {
      suppress(extra);
      continue;
    }
    // 카카오톡(사용자 본인) 수신자는 보낼 때마다 활성·사업장 접근을 다시 확인한다(비활성화·권한 회수 뒤에도 계속 받는 일 방지)
    if (r.channel === "KAKAO" && r.address.startsWith(KAKAO_USER_PREFIX)) {
      const u = await getUser(r.address.slice(KAKAO_USER_PREFIX.length));
      if (!u || !u.active || !(await canAccessSite(u, siteId))) {
        suppress("수신자 비활성 또는 이 사업장 권한 없음");
        continue;
      }
    }
    message ??= await buildMessage();
    const res = await deliver(r, message);
    logs.push({ ...base, status: res.status, reason: `${opts.label} — ${res.reason}` });
  }
  return logs;
}

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
 * 장애 통보. 수신자 설정(종류·등급·시간대·중복 억제)을 적용하고 발송 기록을 돌려준다.
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
  return notifyRecipients(
    setting,
    incident.siteId,
    now,
    tz,
    {
      kind: kind === "ESCALATED" ? "ESCALATION" : "INCIDENT",
      label: KIND_LABEL[kind],
      severity: incident.severity,
      refId: incident.id,
      extraSuppress: () => (kind === "OCCURRED" && recentSameIncidentNotifiedAt && setting && minutesBetween(recentSameIncidentNotifiedAt, now) < setting.dedupeMinutes ? `${setting.dedupeMinutes}분 내 동일 장애 중복 억제` : null),
    },
    () => incidentMessage(incident, kind, tz, now),
  );
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
