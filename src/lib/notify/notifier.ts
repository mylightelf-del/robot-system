import type { Incident, NotificationLog, NotificationSetting } from "@/lib/domain/types";
import { SEVERITY_ORDER } from "@/lib/domain/status";
import { localHourMinute, minutesBetween } from "@/lib/util/time";
import { newId } from "@/lib/util/random";

/**
 * 알림 발송 모듈 (교체 가능).
 * 시제품에서는 모든 발송을 모의 처리(MOCK_SENT)하고 기록만 남긴다.
 * 실제 이메일/카카오 알림톡 공급사·발신 설정·템플릿·과금은 5단계에서 선택 공급사 문서로 확인한다.
 */
export interface NotificationChannel {
  readonly name: "EMAIL" | "KAKAO";
  send(recipient: string, subject: string, body: string): Promise<{ ok: boolean; reason: string }>;
}

export class MockEmailChannel implements NotificationChannel {
  readonly name = "EMAIL" as const;
  async send(): Promise<{ ok: boolean; reason: string }> {
    return { ok: true, reason: "모의 발송(실제 전송 없음)" };
  }
}

export class MockKakaoChannel implements NotificationChannel {
  readonly name = "KAKAO" as const;
  async send(): Promise<{ ok: boolean; reason: string }> {
    return { ok: true, reason: "모의 발송(실제 전송 없음)" };
  }
}

const channels: Record<"EMAIL" | "KAKAO", NotificationChannel> = {
  EMAIL: new MockEmailChannel(),
  KAKAO: new MockKakaoChannel(),
};

function withinHours(now: string, from: string, to: string, tz: string): boolean {
  const hm = localHourMinute(now, tz);
  return from <= hm && hm <= to;
}

/**
 * 장애 발생 통보. 수신자 설정(등급·시간대·중복 억제)을 적용하고 발송 기록을 돌려준다.
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
  if (!setting) return [];
  const logs: NotificationLog[] = [];
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
    const subjectKind = kind === "OCCURRED" ? "장애 발생" : kind === "RESOLVED" ? "장애 복구" : "미조치 확대 통보";
    const res = await channels[r.channel].send(r.address, `[${subjectKind}] ${incident.code}`, incident.customerMessage);
    logs.push({ ...base, status: res.ok ? "MOCK_SENT" : "FAILED", reason: `${subjectKind} — ${res.reason}` });
  }
  return logs;
}
