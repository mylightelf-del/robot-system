import { DEFAULT_TZ } from "./config";

/** 서버는 ISO UTC 로 주고, 화면은 사업장 시간대로 보여 준다(서버 util/time.ts 와 같은 규칙). */
export function fmtDateTime(iso: string | null | undefined, tz: string = DEFAULT_TZ): string {
  if (!iso) return "미수신";
  try {
    return new Intl.DateTimeFormat("ko-KR", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  } catch {
    return iso.slice(0, 16).replace("T", " ");
  }
}
export function fmtDate(iso: string | null | undefined, tz: string = DEFAULT_TZ): string {
  if (!iso) return "-";
  try {
    return new Intl.DateTimeFormat("ko-KR", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}
export function relative(iso: string | null | undefined, now: string | number = Date.now()): string {
  if (!iso) return "미수신";
  const min = Math.round((new Date(now).getTime() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}
export function num(n: number | null | undefined, unit = ""): string {
  if (n === null || n === undefined) return "-";
  return `${Math.round(n).toLocaleString("ko-KR")}${unit}`;
}
export function pct(n: number | null | undefined): string {
  return n === null || n === undefined ? "해당 없음" : `${n}%`;
}
