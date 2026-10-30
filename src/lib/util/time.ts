/** 시각 유틸. 저장은 UTC ISO, 표시는 사업장 시간대(기본 Asia/Seoul). */

export const DEFAULT_TZ = "Asia/Seoul";

export function nowIso(): string {
  return new Date().toISOString();
}

export function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

export function minutesBetween(aIso: string, bIso: string): number {
  return (new Date(bIso).getTime() - new Date(aIso).getTime()) / 60_000;
}

export function formatDateTime(iso: string | null | undefined, tz: string = DEFAULT_TZ): string {
  if (!iso) return "미수신";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export function formatTime(iso: string | null | undefined, tz: string = DEFAULT_TZ): string {
  if (!iso) return "미수신";
  return new Intl.DateTimeFormat("ko-KR", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

export function formatDate(iso: string | null | undefined, tz: string = DEFAULT_TZ): string {
  if (!iso) return "-";
  return new Intl.DateTimeFormat("ko-KR", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/** 사업장 시간대 기준 YYYY-MM-DD */
export function localDateKey(iso: string, tz: string = DEFAULT_TZ): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** 사업장 시간대 기준 YYYY-MM */
export function localMonthKey(iso: string, tz: string = DEFAULT_TZ): string {
  return localDateKey(iso, tz).slice(0, 7);
}

/** "n분 전" 형식. */
export function relativeFromNow(iso: string | null | undefined, now: string = nowIso()): string {
  if (!iso) return "미수신";
  const min = Math.round(minutesBetween(iso, now));
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

/** 경과 시간(분)을 읽기 쉽게: 59분 → "59분", 135분 → "2시간 15분", 1500분 → "1일 1시간". */
export function formatDurationMin(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m}분`;
  if (m < 1440) {
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h}시간 ${r}분` : `${h}시간`;
  }
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return h ? `${d}일 ${h}시간` : `${d}일`;
}

/** YYYY-MM 문자열에서 전월/익월 */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-");
  return `${y}년 ${Number(m)}월`;
}

/**
 * 사업장 시간대의 (date, HH:mm) 을 UTC ISO 로 변환한다.
 * 시제품에서는 고정 오프셋 테이블로 처리한다(한국 운영 기준). 다른 시간대는 2단계에서 라이브러리로 교체.
 */
const TZ_OFFSET_MIN: Record<string, number> = { "Asia/Seoul": 540, UTC: 0 };
export function localToUtcIso(dateKey: string, hhmm: string, tz: string = DEFAULT_TZ): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const offset = TZ_OFFSET_MIN[tz] ?? 0;
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - offset * 60_000).toISOString();
}

export function localHourMinute(iso: string, tz: string = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}
