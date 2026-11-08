"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { CommonStatus, MapPoint, MapVersion, Zone } from "@/lib/domain/types";
import { STATUS_LABEL } from "@/lib/domain/status";

export interface MapRobot {
  id: string;
  name: string;
  common: CommonStatus;
  pose: { x: number; y: number; headingDeg: number } | null;
  poseIsLastKnown: boolean;
  batteryPct: number | null;
  progressPct: number | null;
}

const FILL: Record<CommonStatus, string> = {
  ERROR: "#dc2626",
  OFFLINE: "#6b7280",
  CLEANING: "#2563eb",
  PAUSED: "#d97706",
  RETURNING: "#4f46e5",
  CHARGING: "#059669",
  IDLE: "#374151",
  UNKNOWN: "#7c3aed",
};

const POINT_STYLE: Record<MapPoint["type"], { color: string; glyph: string; label: string }> = {
  CHARGING: { color: "#059669", glyph: "⚡", label: "충전소" },
  WORKSTATION: { color: "#0891b2", glyph: "⚙", label: "워크스테이션" },
  RETURN: { color: "#4f46e5", glyph: "⌂", label: "반환 지점" },
  MAINTENANCE: { color: "#d97706", glyph: "🔧", label: "유지보수 지점" },
  OTHER: { color: "#64748b", glyph: "•", label: "지점" },
};

const MIN_SCALE = 1;
const MAX_SCALE = 8;

/**
 * 층 지도. 제조사 지도를 가져온 층은 지도 이미지(imageUrl) 위에, 아니면 샘플 틀 위에 구역·로봇·지점을 그린다. 좌표는 모두 px(지도 이미지 기준).
 * - 보기: 100% 는 지도 전체가 한 화면(세로 최대 70vh)에 맞게. 마우스 휠로 커서 기준 확대·축소, 드래그로 이동, 버튼(+/−/맞춤).
 * - 지점: 충전소·워크스테이션·반환 지점·유지보수 지점(제조사 지도 요소). 금지 구역은 옅은 빗금.
 * - 구역 선택 모드(selectable): 구역 클릭으로 선택, 빈 곳 클릭으로 사용자 정의 영역 점 추가(드래그가 아닐 때만).
 * - 오프라인 로봇은 점선 원 + "마지막 위치" 로 구분한다.
 */
export function FloorMap({
  map,
  zones,
  robots,
  selectable = false,
  selectedZoneIds = [],
  onToggleZone,
  polygon = [],
  onAddPoint,
  highlightRobotId,
  className = "",
  fitHeight = "70vh",
}: {
  map: MapVersion;
  zones: Zone[];
  robots: MapRobot[];
  selectable?: boolean;
  selectedZoneIds?: string[];
  onToggleZone?: (zoneId: string) => void;
  polygon?: [number, number][];
  onAddPoint?: (p: [number, number]) => void;
  highlightRobotId?: string;
  className?: string;
  /** 100% 보기에서 지도가 차지할 최대 세로 크기(CSS 길이). */
  fitHeight?: string;
}) {
  const W = map.widthPx;
  const H = map.heightPx;
  const [scale, setScale] = useState(1);
  const [center, setCenter] = useState<[number, number]>([W / 2, H / 2]);
  const [showForbidden, setShowForbidden] = useState(true);
  const [dragging, setDragging] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);

  // 지도가 바뀌면 보기 초기화(렌더 중 상태 조정 패턴)
  const [viewKey, setViewKey] = useState(`${map.id}:${W}x${H}`);
  const currentKey = `${map.id}:${W}x${H}`;
  if (viewKey !== currentKey) {
    setViewKey(currentKey);
    setScale(1);
    setCenter([W / 2, H / 2]);
  }

  const vw = W / scale;
  const vh = H / scale;
  const clampCenter = (cx: number, cy: number, sc: number): [number, number] => {
    const hw = W / sc / 2;
    const hh = H / sc / 2;
    return [Math.min(Math.max(cx, hw), W - hw), Math.min(Math.max(cy, hh), H - hh)];
  };
  const vx = center[0] - vw / 2;
  const vy = center[1] - vh / 2;

  // 휠: 커서 아래 지점이 고정되도록 확대·축소(브라우저 스크롤은 막는다 — passive:false 로 직접 등록)
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * vw + vx;
      const py = ((e.clientY - rect.top) / rect.height) * vh + vy;
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
      if (next === scale) return;
      // 커서 지점 고정: 새 뷰에서 커서 위치 비율이 같도록 중심 이동
      const fx = (e.clientX - rect.left) / rect.width;
      const fy = (e.clientY - rect.top) / rect.height;
      const nvw = W / next;
      const nvh = H / next;
      setCenter(clampCenter(px - (fx - 0.5) * nvw, py - (fy - 0.5) * nvh, next));
      setScale(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const toMap = (clientX: number, clientY: number): [number, number] => {
    const el = svgRef.current!;
    const rect = el.getBoundingClientRect();
    return [((clientX - rect.left) / rect.width) * vw + vx, ((clientY - rect.top) / rect.height) * vh + vy];
  };
  const zoomBy = (factor: number) => {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    setScale(next);
    setCenter((c) => clampCenter(c[0], c[1], next));
  };
  const reset = () => {
    setScale(1);
    setCenter([W / 2, H / 2]);
  };
  const fontBase = Math.max(W, H) / 60; // 지도 크기에 비례한 글자 크기(화면에서 확대해도 같이 커진다)
  const f = (k: number) => Math.round(fontBase * k);

  return (
    <div className={`relative ${className}`}>
      <div className="mx-auto" style={{ aspectRatio: `${W} / ${H}`, maxHeight: fitHeight, maxWidth: "100%" }}>
        <svg
          ref={svgRef}
          viewBox={`${vx} ${vy} ${vw} ${vh}`}
          className={`w-full h-full bg-slate-50 border border-gray-200 rounded-xl select-none ${dragging ? "cursor-grabbing" : scale > 1 ? "cursor-grab" : ""}`}
          style={{ display: "block", touchAction: "none" }}
          role="img"
          aria-label="층 지도"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            drag.current = { x: e.clientX, y: e.clientY, cx: center[0], cy: center[1], moved: false };
            if (scale > 1) setDragging(true);
            (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const dx = ((e.clientX - d.x) / rect.width) * vw;
            const dy = ((e.clientY - d.y) / rect.height) * vh;
            if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
            if (scale > 1) setCenter(clampCenter(d.cx - dx, d.cy - dy, scale));
          }}
          onPointerUp={(e) => {
            const d = drag.current;
            drag.current = null;
            setDragging(false);
            if (!d || d.moved) return;
            if (!selectable || !onAddPoint) return;
            const [mx, my] = toMap(e.clientX, e.clientY);
            onAddPoint([Math.round(mx), Math.round(my)]);
          }}
          onPointerCancel={() => {
            drag.current = null;
            setDragging(false);
          }}
          onDoubleClick={() => zoomBy(1.6)}
        >
          <rect x={0} y={0} width={W} height={H} fill="#f8fafc" />
          {map.imageUrl ? (
            <image href={map.imageUrl} x={0} y={0} width={W} height={H} preserveAspectRatio="none" />
          ) : (
            <rect x={40} y={40} width={W - 80} height={H - 80} fill="none" stroke="#cbd5e1" strokeWidth={3} />
          )}
          <defs>
            <pattern id="forbidden-hatch" width={f(0.6)} height={f(0.6)} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1={0} y1={0} x2={0} y2={f(0.6)} stroke="#ef4444" strokeWidth={f(0.12)} opacity={0.45} />
            </pattern>
          </defs>
          {zones.map((z) => {
            const sel = selectedZoneIds.includes(z.id);
            const pts = z.polygon.map((p) => p.join(",")).join(" ");
            const cx = z.polygon.reduce((s, p) => s + p[0], 0) / z.polygon.length;
            const cy = z.polygon.reduce((s, p) => s + p[1], 0) / z.polygon.length;
            return (
              <g
                key={z.id}
                onClick={(e) => {
                  if (!selectable || !onToggleZone) return;
                  e.stopPropagation();
                  onToggleZone(z.id);
                }}
                className={selectable ? "cursor-pointer" : ""}
              >
                <polygon points={pts} fill={sel ? "rgba(191,219,254,0.8)" : map.imageUrl ? "rgba(226,232,240,0.35)" : "#e2e8f0"} stroke={sel ? "#1d4ed8" : "#94a3b8"} strokeWidth={sel ? f(0.25) : f(0.12)} />
                <text x={cx} y={cy} textAnchor="middle" fontSize={f(1.5)} fill="#334155">
                  {z.name}
                </text>
                <text x={cx} y={cy + f(1.7)} textAnchor="middle" fontSize={f(1.1)} fill="#64748b">
                  {z.areaM2}㎡
                </text>
              </g>
            );
          })}
          {/* 금지 구역은 구역 위에 그린다(샘플 지도의 구역 채움에 가려지지 않도록) */}
          {showForbidden &&
            (map.forbidden ?? []).map((poly, i) => <polygon key={`fb-${i}`} points={poly.map((p) => p.join(",")).join(" ")} fill="url(#forbidden-hatch)" stroke="#f87171" strokeWidth={f(0.08)} opacity={0.8} />)}
          {(map.points ?? []).map((p, i) => {
            const st = POINT_STYLE[p.type] ?? POINT_STYLE.OTHER;
            const r = f(1.1);
            return (
              <g key={`pt-${i}`} transform={`translate(${p.x} ${p.y})`}>
                <title>{`${st.label}: ${p.name}`}</title>
                <rect x={-r} y={-r} width={r * 2} height={r * 2} rx={f(0.3)} fill="#fff" stroke={st.color} strokeWidth={f(0.18)} />
                <text y={f(0.45)} textAnchor="middle" fontSize={f(1.2)} fill={st.color}>
                  {st.glyph}
                </text>
                <text y={r + f(1.1)} textAnchor="middle" fontSize={f(0.9)} fill={st.color} fontWeight={600}>
                  {p.name}
                </text>
                {p.yawDeg !== null && <polygon points={`${r + f(0.1)},0 ${r + f(0.8)},-${f(0.35)} ${r + f(0.8)},${f(0.35)}`} fill={st.color} transform={`rotate(${-p.yawDeg})`} opacity={0.9} />}
              </g>
            );
          })}
          {polygon.length > 0 && (
            <g>
              <polygon points={polygon.map((p) => p.join(",")).join(" ")} fill="rgba(37,99,235,0.15)" stroke="#2563eb" strokeWidth={f(0.18)} strokeDasharray={`${f(0.6)} ${f(0.35)}`} />
              {polygon.map((p, i) => (
                <circle key={i} cx={p[0]} cy={p[1]} r={f(0.45)} fill="#2563eb" />
              ))}
            </g>
          )}
          {robots.map((r) => {
            if (!r.pose) return null;
            const color = FILL[r.common];
            const { x, y, headingDeg } = r.pose;
            const hl = r.id === highlightRobotId;
            const R = f(1.5);
            const body = (
              <g transform={`translate(${x} ${y})`}>
                {hl && <circle r={R * 1.7} fill="none" stroke={color} strokeWidth={f(0.18)} opacity={0.5} />}
                <circle r={R} fill={r.poseIsLastKnown ? "#fff" : color} stroke={color} strokeWidth={f(0.22)} strokeDasharray={r.poseIsLastKnown ? `${f(0.45)} ${f(0.35)}` : undefined} />
                <polygon points={`0,-${R * 1.55} ${R * 0.4},-${R * 0.85} -${R * 0.4},-${R * 0.85}`} fill={color} transform={`rotate(${headingDeg})`} />
                <text y={f(0.35)} textAnchor="middle" fontSize={f(1.05)} fontWeight={700} fill={r.poseIsLastKnown ? color : "#fff"}>
                  {r.batteryPct === null ? "?" : Math.round(r.batteryPct)}
                </text>
                <text y={R + f(1.3)} textAnchor="middle" fontSize={f(1.15)} fill="#0f172a">
                  {r.name}
                </text>
                <text y={R + f(2.3)} textAnchor="middle" fontSize={f(0.9)} fill={color}>
                  {STATUS_LABEL[r.common]}
                  {r.poseIsLastKnown ? " · 마지막 위치" : ""}
                  {r.progressPct !== null ? ` ${Math.round(r.progressPct)}%` : ""}
                </text>
              </g>
            );
            return selectable ? (
              <g key={r.id}>{body}</g>
            ) : (
              <Link key={r.id} href={`/robots/${r.id}`} onClick={(e) => { if (drag.current?.moved) e.preventDefault(); }}>
                {body}
              </Link>
            );
          })}
        </svg>
      </div>
      {/* 확대·축소 도구 */}
      <div className="absolute right-2 top-2 flex flex-col gap-1 no-print">
        <button type="button" className="h-7 w-7 rounded-md bg-white/95 border text-slate-700 shadow-sm hover:bg-slate-50 text-sm" onClick={() => zoomBy(1.4)} title="확대">+</button>
        <button type="button" className="h-7 w-7 rounded-md bg-white/95 border text-slate-700 shadow-sm hover:bg-slate-50 text-sm" onClick={() => zoomBy(1 / 1.4)} title="축소">−</button>
        <button type="button" className="h-7 rounded-md bg-white/95 border text-slate-700 shadow-sm hover:bg-slate-50 text-[10px] px-1" onClick={reset} title="전체 보기">100%</button>
      </div>
      <div className="absolute left-2 top-2 rounded-md bg-white/90 border px-1.5 py-0.5 text-[11px] text-slate-600 no-print">{Math.round(scale * 100)}%</div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md px-1 py-1 text-[11px] text-gray-600">
        <span>{map.imageUrl ? `제조사 지도(${map.vendor ?? ""} ${map.vendorMapName ?? ""})` : "샘플 지도"}</span>
        <span>원 안 숫자=배터리% · 삼각형=진행 방향 · 점선 원=마지막 보고 위치</span>
        {(map.points ?? []).length > 0 && (
          <span>
            {Array.from(new Set((map.points ?? []).map((p) => p.type))).map((t) => (
              <span key={t} className="mr-2" style={{ color: POINT_STYLE[t].color }}>
                {POINT_STYLE[t].glyph} {POINT_STYLE[t].label}
              </span>
            ))}
          </span>
        )}
        {(map.forbidden ?? []).length > 0 && (
          <label className="inline-flex items-center gap-1 ml-auto cursor-pointer no-print">
            <input type="checkbox" checked={showForbidden} onChange={(e) => setShowForbidden(e.target.checked)} /> 금지 구역 표시
          </label>
        )}
        <span className="text-slate-400">휠 확대 · 드래그 이동 · 더블클릭 확대</span>
      </div>
    </div>
  );
}
