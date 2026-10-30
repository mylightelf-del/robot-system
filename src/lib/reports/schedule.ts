/**
 * 보고서 발행 일정(설치일 기준). 날짜는 모두 사업장 시간대의 YYYY-MM-DD.
 *
 * 사용자 확정 규칙(2026-10-30):
 *  - 설치 완료보고서: 설치일(D0)
 *  - 일간보고서: D+1 ~ D+6 (하루씩, 6건)
 *  - 주간보고서: D+7, D+14, D+21 (각 7일: D+1~D+7, D+8~D+14, D+15~D+21)
 *  - 월간보고서: 설치일 차월부터 매월 설치일과 같은 날짜. 그 날짜가 없는 달(예: 31일)은 그 달 말일.
 *    n개월차 = (직전 기준일+1) ~ (n개월 뒤 기준일). 1개월차는 D+1 부터.
 *
 * 해석(문서화한 가정): "D+n 보고서" 는 D+n 일까지의 실적을 담는다. 그날 실적이 다 들어와야 하므로
 * 초안은 기간 마지막 날의 다음 날 오전(DRAFT_HOUR)에 자동 작성한다. 설치 완료보고서만 설치 당일 작성.
 */

export type ReportKind = "INSTALLATION" | "DAILY" | "WEEKLY" | "MONTHLY";

export const REPORT_KIND_LABEL: Record<ReportKind, string> = {
  INSTALLATION: "설치 완료보고서",
  DAILY: "일간보고서",
  WEEKLY: "주간보고서",
  MONTHLY: "월간보고서",
};

export const DAILY_COUNT = 6;
export const WEEKLY_COUNT = 3;
/** 초안 자동 작성 시각(사업장 현지 시). 전날 실적 동기화(10분 주기)가 끝난 뒤. */
export const DRAFT_HOUR = 6;

export interface ReportPeriod {
  kind: ReportKind;
  /** 설치 0, 일간 D+n 의 n, 주간 n주차, 월간 n개월차. 설치일 없이 만든 달력 월 보고서는 0. */
  seq: number;
  periodStart: string;
  periodEnd: string; // 포함
}

export interface ScheduledReport extends ReportPeriod {
  /** 초안 자동 작성일(이 날 DRAFT_HOUR 이후). */
  draftOn: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateKey(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function addDays(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  const t = (k: string) => {
    const [y, m, d] = k.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((t(b) - t(a)) / 86_400_000);
}

/** 설치일로부터 n개월 뒤 같은 날짜(없으면 그 달 말일). */
export function monthAnniversary(installedOn: string, n: number): string {
  const [y, m, d] = installedOn.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, lastDay))).toISOString().slice(0, 10);
}

/** 달력 월(YYYY-MM)의 기간 — 설치일 이전에 쓰던 월간 보고서와 호환. */
export function calendarMonthPeriod(month: string): ReportPeriod {
  const start = `${month}-01`;
  const [y, m] = month.split("-").map(Number);
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { kind: "MONTHLY", seq: 0, periodStart: start, periodEnd: end };
}

/**
 * 설치일부터 draftOn <= until 인 일정 전부(시간순). 월간은 무기한이므로 until 로 자른다.
 */
export function reportSchedule(installedOn: string, until: string): ScheduledReport[] {
  if (!isDateKey(installedOn)) throw new Error(`설치일 형식 오류: ${installedOn}`);
  const out: ScheduledReport[] = [];
  const push = (p: ReportPeriod, draftOn: string) => {
    if (draftOn <= until) out.push({ ...p, draftOn });
  };
  push({ kind: "INSTALLATION", seq: 0, periodStart: installedOn, periodEnd: installedOn }, installedOn);
  for (let n = 1; n <= DAILY_COUNT; n++) {
    const day = addDays(installedOn, n);
    push({ kind: "DAILY", seq: n, periodStart: day, periodEnd: day }, addDays(day, 1));
  }
  for (let w = 1; w <= WEEKLY_COUNT; w++) {
    const end = addDays(installedOn, 7 * w);
    push({ kind: "WEEKLY", seq: w, periodStart: addDays(end, -6), periodEnd: end }, addDays(end, 1));
  }
  for (let k = 1; ; k++) {
    const end = monthAnniversary(installedOn, k);
    const draftOn = addDays(end, 1);
    if (draftOn > until) break;
    push({ kind: "MONTHLY", seq: k, periodStart: addDays(monthAnniversary(installedOn, k - 1), 1), periodEnd: end }, draftOn);
  }
  return out.sort((a, b) => (a.draftOn === b.draftOn ? kindOrder(a.kind) - kindOrder(b.kind) : a.draftOn.localeCompare(b.draftOn)));
}

function kindOrder(k: ReportKind): number {
  return ["INSTALLATION", "DAILY", "WEEKLY", "MONTHLY"].indexOf(k);
}

export function periodKey(p: Pick<ReportPeriod, "kind" | "periodStart" | "periodEnd">): string {
  return `${p.kind}:${p.periodStart}~${p.periodEnd}`;
}

export function parsePeriodKey(key: string): Pick<ReportPeriod, "kind" | "periodStart" | "periodEnd"> | null {
  const m = key.match(/^(INSTALLATION|DAILY|WEEKLY|MONTHLY):(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$/);
  if (!m || !isDateKey(m[2]) || !isDateKey(m[3]) || m[2] > m[3]) return null;
  return { kind: m[1] as ReportKind, periodStart: m[2], periodEnd: m[3] };
}

function md(k: string): string {
  const [, m, d] = k.split("-");
  return `${Number(m)}/${Number(d)}`;
}

export function periodText(p: Pick<ReportPeriod, "periodStart" | "periodEnd">): string {
  const y = (k: string) => k.slice(0, 4);
  if (p.periodStart === p.periodEnd) return `${y(p.periodStart)}. ${md(p.periodStart)}`;
  return y(p.periodStart) === y(p.periodEnd) ? `${y(p.periodStart)}. ${md(p.periodStart)} ~ ${md(p.periodEnd)}` : `${y(p.periodStart)}. ${md(p.periodStart)} ~ ${y(p.periodEnd)}. ${md(p.periodEnd)}`;
}

/** 보고서 이름: "일간보고서 D+3", "주간보고서 2주차", "월간보고서 1개월차", "월간보고서 2026년 9월"(달력 월). */
export function reportTitle(p: Pick<ReportPeriod, "kind" | "seq" | "periodStart">): string {
  switch (p.kind) {
    case "INSTALLATION":
      return REPORT_KIND_LABEL.INSTALLATION;
    case "DAILY":
      return `${REPORT_KIND_LABEL.DAILY} D+${p.seq}`;
    case "WEEKLY":
      return `${REPORT_KIND_LABEL.WEEKLY} ${p.seq}주차`;
    case "MONTHLY":
      return p.seq > 0 ? `${REPORT_KIND_LABEL.MONTHLY} ${p.seq}개월차` : `${REPORT_KIND_LABEL.MONTHLY} ${p.periodStart.slice(0, 4)}년 ${Number(p.periodStart.slice(5, 7))}월`;
  }
}

/** 의견란 이름(종류별). 저장 키는 공통이다. */
export function commentLabels(kind: ReportKind): { overallOpinion: string; incompleteReasons: string; improvements: string; focusZones: string; nextMonthPlan: string } {
  switch (kind) {
    case "INSTALLATION":
      return { overallOpinion: "설치 총평", incompleteReasons: "미완료·보완 필요 사항", improvements: "교육·인수인계 내용", focusZones: "운영 구역 특이사항", nextMonthPlan: "안정화 기간(D+1~D+21) 계획" };
    case "DAILY":
      return { overallOpinion: "일일 운영 의견", incompleteReasons: "미완료 사유", improvements: "조정·조치 사항", focusZones: "집중 관리 구역", nextMonthPlan: "다음 날 계획" };
    case "WEEKLY":
      return { overallOpinion: "주간 종합 의견", incompleteReasons: "미완료 사유", improvements: "개선 사항", focusZones: "집중 관리 구역", nextMonthPlan: "다음 주 계획" };
    case "MONTHLY":
      return { overallOpinion: "종합 의견", incompleteReasons: "미완료 사유", improvements: "개선 사항", focusZones: "집중 관리 구역", nextMonthPlan: "차월 계획" };
  }
}
