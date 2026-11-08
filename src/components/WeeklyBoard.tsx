import { PALETTE } from "./ReportVisuals";

export type WeeklyBoardRow = { robotName: string; taskName: string; floorName: string; daysOfWeek: number[]; time: string; durationMin: number | null };

const WEEK = [1, 2, 3, 4, 5, 6, 0];
const WEEK_LABEL = ["일", "월", "화", "수", "목", "금", "토"];

/** 주간 예약 보드(작업·일정 화면): 요일을 열로, 각 요일의 예약을 시각 순 목록으로. 시간축 없이 '무엇이 언제 도는지' 만 본다. */
export function WeeklyBoard({ rows }: { rows: WeeklyBoardRow[] }) {
  if (!rows.length) return <p className="text-sm text-gray-500">사용 중인 예약이 없습니다.</p>;
  const robots = Array.from(new Set(rows.map((r) => r.robotName)));
  const color = (name: string) => PALETTE[robots.indexOf(name) % PALETTE.length];
  return (
    <div className="text-xs">
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
        {WEEK.map((d) => {
          const items = rows.filter((r) => r.daysOfWeek.includes(d)).sort((a, b) => a.time.localeCompare(b.time) || a.robotName.localeCompare(b.robotName));
          return (
            <div key={d} className="rounded-lg border border-gray-200 bg-white min-w-0">
              <div className={`px-2 py-1 border-b text-center font-semibold rounded-t-lg ${d === 0 ? "text-red-600 bg-red-50" : d === 6 ? "text-blue-700 bg-blue-50" : "text-gray-700 bg-gray-50"}`}>
                {WEEK_LABEL[d]} <span className="font-normal text-gray-400">{items.length}</span>
              </div>
              {items.length === 0 ? (
                <div className="px-2 py-2 text-gray-400 text-center">—</div>
              ) : (
                <ul className="divide-y">
                  {items.map((r, i) => (
                    <li key={i} className="px-2 py-1.5 flex gap-1.5 items-start" title={`${r.time} ${r.robotName} · ${r.taskName} · ${r.floorName} (${r.durationMin === null ? "소요 미정" : `약 ${r.durationMin}분`})`}>
                      <span className="mt-1 inline-block w-2 h-2 rounded-full shrink-0" style={{ background: color(r.robotName) }} />
                      <span className="min-w-0">
                        <span className="font-mono font-semibold text-gray-900">{r.time}</span>
                        <span className="block truncate text-gray-800">{r.taskName}</span>
                        <span className="block truncate text-gray-500">
                          {r.robotName}
                          {r.durationMin !== null ? ` · 약 ${r.durationMin}분` : ""}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-3 mt-2">
        {robots.map((n) => (
          <span key={n} className="inline-flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded" style={{ background: color(n) }} />
            {n}
          </span>
        ))}
        <span className="text-gray-500">소요 시간은 최근 30일 그 작업의 평균</span>
      </div>
    </div>
  );
}
