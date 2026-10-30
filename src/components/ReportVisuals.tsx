import type { ReportAggregates, ReportContent } from "@/lib/domain/types";

/** 구역·로봇 구분색(밝은 배경·인쇄 모두에서 구분되는 8색). */
export const PALETTE = ["#2563eb", "#16a34a", "#d97706", "#db2777", "#7c3aed", "#0891b2", "#dc2626", "#65a30d"];

const md = (k: string) => `${Number(k.slice(5, 7))}.${Number(k.slice(8, 10))}`;

/** 단계 일정(화살표). 첨부 양식의 "제품 설치 및 맵핑 → 운영 및 세부 조정 → 정상 운영" 형태. */
export function PhaseTimeline({ phases }: { phases: NonNullable<ReportContent["phases"]> }) {
  if (!phases.length) return null;
  return (
    <div className="flex w-full overflow-hidden rounded" role="list" aria-label="단계 일정">
      {phases.map((p, i) => (
        <div
          key={i}
          role="listitem"
          className="flex-1 min-w-0 text-white text-center py-2 px-4"
          style={{
            background: i === phases.length - 1 ? "#1e3a5f" : i % 2 === 0 ? "#3b82c4" : "#2a6aa8",
            clipPath: i === phases.length - 1 ? "polygon(0 0, 100% 0, 100% 100%, 0 100%, 12px 50%)" : i === 0 ? "polygon(0 0, calc(100% - 12px) 0, 100% 50%, calc(100% - 12px) 100%, 0 100%)" : "polygon(0 0, calc(100% - 12px) 0, 100% 50%, calc(100% - 12px) 100%, 0 100%, 12px 50%)",
            WebkitPrintColorAdjust: "exact",
            printColorAdjust: "exact",
          }}
        >
          <div className="text-sm font-semibold truncate">{p.label}</div>
          <div className="text-xs opacity-90">{p.from === p.to ? md(p.from) : `${md(p.from)} ~ ${md(p.to)}`}</div>
        </div>
      ))}
    </div>
  );
}

type MapSnap = NonNullable<NonNullable<ReportAggregates["installation"]>["maps"]>[number];

function centroid(poly: [number, number][]): [number, number] {
  const n = poly.length || 1;
  return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
}

/** 층 지도 위 청소 범위(구역 다각형·이름·면적). 이미지가 없는 층은 격자 위에 구역만 그린다. */
export function ZoneMap({ map }: { map: MapSnap }) {
  const { widthPx: w, heightPx: h } = map;
  const fs = Math.max(10, Math.round(Math.min(w, h) / 28));
  return (
    <figure className="break-inside-avoid">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto border rounded bg-white" role="img" aria-label={`${map.floorName} 청소 구역`} style={{ maxHeight: 520 }}>
        {map.hasImage ? (
          <image href={`/api/maps/${map.mapVersionId}`} x={0} y={0} width={w} height={h} preserveAspectRatio="none" />
        ) : (
          <>
            <defs>
              <pattern id={`grid-${map.floorId}`} width={w / 20} height={w / 20} patternUnits="userSpaceOnUse">
                <path d={`M ${w / 20} 0 L 0 0 0 ${w / 20}`} fill="none" stroke="#e5e7eb" strokeWidth={1} />
              </pattern>
            </defs>
            <rect width={w} height={h} fill={`url(#grid-${map.floorId})`} />
          </>
        )}
        {map.zones.map((z, i) => {
          const c = PALETTE[i % PALETTE.length];
          const [cx, cy] = centroid(z.polygon);
          return (
            <g key={i}>
              <polygon points={z.polygon.map((p) => p.join(",")).join(" ")} fill={c} fillOpacity={0.28} stroke={c} strokeWidth={Math.max(1.5, w / 400)} />
              <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle" fontSize={fs} fontWeight={700} fill="#111827" stroke="#fff" strokeWidth={fs / 5} paintOrder="stroke">
                {z.name}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="text-xs text-gray-600 mt-1">
        &lt; {map.floorName} &gt; 청소 구역 {map.zones.length}개 · 합계 {map.zones.reduce((s, z) => s + z.areaM2, 0).toLocaleString()}㎡{map.hasImage ? "" : " (지도 이미지 없음 — 구역 배치만 표시)"}
      </figcaption>
    </figure>
  );
}

type WeeklyRow = NonNullable<NonNullable<ReportAggregates["installation"]>["weekly"]>[number];
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const WEEK_LABEL = ["일", "월", "화", "수", "목", "금", "토"];
export const DEFAULT_BLOCK_MIN = 60;

/** 주간 예약 타임라인: 요일(행) × 0~24시(열). 블록 길이는 최근 실적 평균 소요 시간(없으면 60분 점선 = 미정). */
export function WeeklyTimeline({ rows }: { rows: WeeklyRow[] }) {
  if (!rows.length) return <p className="text-sm text-gray-500">사용 중인 예약이 없습니다.</p>;
  const robots = Array.from(new Set(rows.map((r) => r.robotName)));
  const color = (name: string) => PALETTE[robots.indexOf(name) % PALETTE.length];
  const minOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return (
    <div className="text-xs">
      <div className="grid grid-cols-[2rem_1fr] mb-1">
        <div />
        <div className="relative h-4">
          {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((hh) => (
            <span key={hh} className="absolute -translate-x-1/2 text-gray-500" style={{ left: `${(hh / 24) * 100}%` }}>
              {hh}
            </span>
          ))}
        </div>
      </div>
      {WEEK.map((d) => {
        const items = rows.filter((r) => r.daysOfWeek.includes(d));
        return (
          <div key={d} className="grid grid-cols-[2rem_1fr] items-stretch border-t">
            <div className={`py-1 font-medium ${d === 0 ? "text-red-600" : d === 6 ? "text-blue-700" : ""}`}>{WEEK_LABEL[d]}</div>
            <div className="relative" style={{ minHeight: `${Math.max(1, items.length) * 18 + 6}px` }}>
              {[3, 6, 9, 12, 15, 18, 21].map((hh) => (
                <div key={hh} className="absolute top-0 bottom-0 border-l border-dashed border-gray-200" style={{ left: `${(hh / 24) * 100}%` }} />
              ))}
              {items.map((r, i) => {
                const start = minOf(r.time);
                const dur = r.durationMin ?? DEFAULT_BLOCK_MIN;
                const width = Math.max(1.2, (Math.min(dur, 24 * 60 - start) / (24 * 60)) * 100);
                return (
                  <div
                    key={i}
                    className={`absolute rounded px-1 text-white truncate ${r.durationMin === null ? "border border-dashed border-white/80" : ""}`}
                    style={{ left: `${(start / (24 * 60)) * 100}%`, width: `${width}%`, top: `${3 + i * 18}px`, height: 16, lineHeight: "16px", background: color(r.robotName), opacity: r.durationMin === null ? 0.7 : 1, WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" }}
                    title={`${r.time} ${r.robotName} · ${r.taskName} (${r.durationMin === null ? "소요 미정" : `약 ${r.durationMin}분`})`}
                  >
                    {r.time} {r.taskName}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="flex flex-wrap gap-3 mt-2">
        {robots.map((n) => (
          <span key={n} className="inline-flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded" style={{ background: color(n), WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" }} />
            {n}
          </span>
        ))}
        <span className="text-gray-500">블록 길이 = 최근 실적 평균 소요 시간(점선은 실적이 없어 60분으로 표시)</span>
      </div>
    </div>
  );
}
