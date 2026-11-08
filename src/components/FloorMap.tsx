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
const MAX_SCALE = 12;

type Box = { x: number; y: number; w: number; h: number };
const hit = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const hitsAny = (b: Box, list: Box[]) => list.some((o) => hit(b, o));
/** 글자 폭 추정(한글·기호 1, 영문·숫자 0.6). */
const textW = (s: string, fs: number) => Array.from(s).reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 1 : 0.62), 0) * fs;

/**
 * 층 지도. 제조사 지도를 가져온 층은 지도 이미지(imageUrl) 위에, 아니면 샘플 틀 위에 구역·로봇·지점을 그린다. 좌표는 모두 px(지도 이미지 기준).
 * - 프레임: 카드 너비 전체, 높이는 지도 비율대로(최대 fitHeight). 가로로 넓은 지도는 프레임이 꼭 맞고, 세로로 긴 지도는 좌우가 여백이 되며 『폭 맞춤』으로 너비를 채워 볼 수 있다. 확대하면 프레임을 꽉 채운다.
 * - 보기: 마우스 휠로 커서 기준 확대·축소, 드래그로 이동, 더블클릭, 버튼(+/−/100%).
 * - 글자·아이콘은 화면 기준 크기를 유지한다(확대해도 커지지 않아 가까운 지점이 떨어져 보인다). 겹치는 이름표는 자리를 옮기고 선으로 잇는다.
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
  fitHeight = "clamp(320px, 85vh, 1000px)",
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
  /** 지도 프레임 최대 높이(CSS 길이). 너비는 카드 전체, 높이는 지도 비율대로 늘어나되 이 값을 넘지 않는다(세로로 긴 지도는 여기서 잘리고 좌우가 여백). */
  fitHeight?: string;
}) {
  const W = map.widthPx;
  const H = map.heightPx;
  const [scale, setScale] = useState(1);
  const [center, setCenter] = useState<[number, number]>([W / 2, H / 2]);
  const [showForbidden, setShowForbidden] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [frame, setFrame] = useState<{ w: number; h: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
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

  // 프레임(카드 너비 × 지정 높이) 실제 px 측정 → 지도 비율과 달라도 프레임을 다 쓴다
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 0 && r.height > 0) setFrame({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 기준 상자(100% 보기): 프레임 비율로 지도를 감싸는 상자. 지도보다 넓거나 높은 쪽은 여백.
  const frameW = frame?.w ?? 800;
  const frameH = frame?.h ?? Math.round((800 * H) / W);
  const fa = frameW / frameH;
  const bw = W / H >= fa ? W : H * fa;
  const bh = W / H >= fa ? W / fa : H;
  const bx0 = (W - bw) / 2;
  const by0 = (H - bh) / 2;
  const vw = bw / scale;
  const vh = bh / scale;
  const clampCenter = (cx: number, cy: number, sc: number): [number, number] => {
    const hw = bw / sc / 2;
    const hh = bh / sc / 2;
    return [Math.min(Math.max(cx, bx0 + hw), bx0 + bw - hw), Math.min(Math.max(cy, by0 + hh), by0 + bh - hh)];
  };
  const [ccx, ccy] = clampCenter(center[0], center[1], scale);
  const vx = ccx - vw / 2;
  const vy = ccy - vh / 2;

  // 휠: 커서 아래 지점이 고정되도록 확대·축소(브라우저 스크롤은 막는다 — passive:false 로 직접 등록)
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const fx = (e.clientX - rect.left) / rect.width;
      const fy = (e.clientY - rect.top) / rect.height;
      const px = fx * vw + vx;
      const py = fy * vh + vy;
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
      if (next === scale) return;
      const nvw = bw / next;
      const nvh = bh / next;
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
  // 폭 맞춤: 지도 너비가 프레임을 꽉 채우도록(세로로 긴 지도용). 위쪽부터 보여 주고 드래그로 내려 본다.
  const fitWidthScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, bw / W));
  const fitWidth = () => {
    setScale(fitWidthScale);
    setCenter(clampCenter(W / 2, bh / fitWidthScale / 2 + by0, fitWidthScale));
  };

  // 화면 px → 지도 단위(확대해도 글자·아이콘은 화면 크기 유지)
  const px = (n: number) => (n * vw) / frameW;
  const inView = (x: number, y: number, pad: number) => x >= vx - pad && x <= vx + vw + pad && y >= vy - pad && y <= vy + vh + pad;

  // ---- 이름표 배치(겹침 회피) ----
  const obstacles: Box[] = [];
  // 구역 이름(고정): 로봇·지점 이름표가 피해 간다
  const zoneLabels = zones.map((z) => {
    const cx = z.polygon.reduce((s, p) => s + p[0], 0) / z.polygon.length;
    const cy = z.polygon.reduce((s, p) => s + p[1], 0) / z.polygon.length;
    const fs1 = px(14);
    const fs2 = px(11);
    const w = Math.max(textW(z.name, fs1), textW(`${z.areaM2}㎡`, fs2));
    const box: Box = { x: cx - w / 2, y: cy - fs1, w, h: fs1 + fs2 * 1.6 };
    obstacles.push(box);
    return { z, cx, cy, fs1, fs2 };
  });
  // 로봇 표식(고정)
  const R = px(14);
  const placedRobots = robots.filter((r) => r.pose).map((r) => {
    const { x, y } = r.pose!;
    obstacles.push({ x: x - R, y: y - R, w: 2 * R, h: 2 * R });
    return r;
  });
  const base: Box = { x: bx0, y: by0, w: bw, h: bh };
  const inside = (b: Box) => b.x >= base.x && b.y >= base.y && b.x + b.w <= base.x + base.w && b.y + b.h <= base.y + base.h;
  const place = (anchor: Box, candidates: [number, number][]): { box: Box; moved: boolean } => {
    for (let i = 0; i < candidates.length; i++) {
      const [dx, dy] = candidates[i];
      const b = { x: anchor.x + dx, y: anchor.y + dy, w: anchor.w, h: anchor.h };
      if (!hitsAny(b, obstacles) && (i === 0 || inside(b))) {
        obstacles.push(b);
        return { box: b, moved: i > 0 };
      }
    }
    obstacles.push(anchor);
    return { box: anchor, moved: false };
  };
  const gap = px(4);
  // 로봇 이름표: 원 아래가 기본, 겹치면 위·오른쪽·왼쪽·아래아래 순
  const robotLabels = placedRobots.map((r) => {
    const { x, y } = r.pose!;
    const fs1 = px(12);
    const fs2 = px(10);
    const line2 = `${STATUS_LABEL[r.common]}${r.poseIsLastKnown ? " · 마지막 위치" : ""}${r.progressPct !== null ? ` ${Math.round(r.progressPct)}%` : ""}`;
    const w = Math.max(textW(r.name, fs1), textW(line2, fs2)) + px(4);
    const h = fs1 + fs2 * 1.5;
    const anchor: Box = { x: x - w / 2, y: y + R + gap, w, h };
    const d = R + gap;
    const { box, moved } = place(anchor, [
      [0, 0],
      [0, -(2 * d + h)],
      [w / 2 + d, -(d + h / 2)],
      [-(w / 2 + d), -(d + h / 2)],
      [0, h + gap],
      [w / 2 + d, 0],
      [-(w / 2 + d), 0],
      [0, 2 * (h + gap)],
    ]);
    return { r, box, moved, fs1, fs2, line2 };
  });
  // 지점: 아이콘+이름을 한 덩어리로, 겹치면 오른쪽·왼쪽·아래·위로 옮기고 실제 위치와 선으로 잇는다
  const pr = px(11);
  const pointLabels = (map.points ?? []).map((p) => {
    const st = POINT_STYLE[p.type] ?? POINT_STYLE.OTHER;
    const fs = px(10);
    const w = Math.max(2 * pr, textW(p.name, fs)) + px(4);
    const h = 2 * pr + gap + fs * 1.2;
    const anchor: Box = { x: p.x - w / 2, y: p.y - pr, w, h };
    const d = pr + gap * 2;
    const { box, moved } = place(anchor, [
      [0, 0],
      [w / 2 + d, 0],
      [-(w / 2 + d), 0],
      [0, h + gap],
      [0, -(h + gap)],
      [w / 2 + d, h],
      [-(w / 2 + d), h],
      [w + 2 * d, 0],
      [-(w + 2 * d), 0],
      [0, 2 * (h + gap)],
    ]);
    return { p, st, box, moved, fs };
  });

  const sw = px(1.5);

  return (
    <div className={`relative ${className}`}>
      <div ref={wrapRef} className="w-full" style={{ aspectRatio: `${W} / ${H}`, maxHeight: fitHeight }}>
        <svg
          ref={svgRef}
          viewBox={`${vx} ${vy} ${vw} ${vh}`}
          preserveAspectRatio="xMidYMid meet"
          className={`w-full h-full bg-slate-100 border border-gray-200 rounded-xl select-none ${dragging ? "cursor-grabbing" : scale > 1 ? "cursor-grab" : ""}`}
          style={{ display: "block", touchAction: "none" }}
          role="img"
          aria-label="층 지도"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            drag.current = { x: e.clientX, y: e.clientY, cx: ccx, cy: ccy, moved: false };
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
            if (mx < 0 || my < 0 || mx > W || my > H) return;
            onAddPoint([Math.round(mx), Math.round(my)]);
          }}
          onPointerCancel={() => {
            drag.current = null;
            setDragging(false);
          }}
          onDoubleClick={() => zoomBy(1.6)}
        >
          <rect x={0} y={0} width={W} height={H} fill="#f8fafc" stroke="#cbd5e1" strokeWidth={sw} />
          {map.imageUrl ? (
            <image href={map.imageUrl} x={0} y={0} width={W} height={H} preserveAspectRatio="none" />
          ) : (
            <rect x={40} y={40} width={W - 80} height={H - 80} fill="none" stroke="#cbd5e1" strokeWidth={sw * 2} />
          )}
          <defs>
            <pattern id="forbidden-hatch" width={px(8)} height={px(8)} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1={0} y1={0} x2={0} y2={px(8)} stroke="#ef4444" strokeWidth={px(1.5)} opacity={0.45} />
            </pattern>
          </defs>
          {zoneLabels.map(({ z, cx, cy, fs1, fs2 }) => {
            const sel = selectedZoneIds.includes(z.id);
            const pts = z.polygon.map((p) => p.join(",")).join(" ");
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
                <polygon points={pts} fill={sel ? "rgba(191,219,254,0.8)" : map.imageUrl ? "rgba(226,232,240,0.35)" : "#e2e8f0"} stroke={sel ? "#1d4ed8" : "#94a3b8"} strokeWidth={sel ? sw * 2 : sw} />
                <text x={cx} y={cy} textAnchor="middle" fontSize={fs1} fill="#334155" stroke="#fff" strokeWidth={fs1 / 5} paintOrder="stroke">
                  {z.name}
                </text>
                <text x={cx} y={cy + fs2 * 1.5} textAnchor="middle" fontSize={fs2} fill="#64748b" stroke="#fff" strokeWidth={fs2 / 5} paintOrder="stroke">
                  {z.areaM2}㎡
                </text>
              </g>
            );
          })}
          {/* 금지 구역은 구역 위에 그린다(샘플 지도의 구역 채움에 가려지지 않도록) */}
          {showForbidden &&
            (map.forbidden ?? []).map((poly, i) => <polygon key={`fb-${i}`} points={poly.map((p) => p.join(",")).join(" ")} fill="url(#forbidden-hatch)" stroke="#f87171" strokeWidth={px(1)} opacity={0.8} />)}
          {pointLabels.map(({ p, st, box, moved, fs }, i) => {
            if (!inView(p.x, p.y, Math.max(box.w, box.h) * 2)) return null;
            const mx = box.x + box.w / 2; // 아이콘 중심
            const my = box.y + pr;
            return (
              <g key={`pt-${i}`}>
                <title>{`${st.label}: ${p.name}`}</title>
                {moved && (
                  <>
                    <line x1={p.x} y1={p.y} x2={mx} y2={my} stroke={st.color} strokeWidth={px(1)} strokeDasharray={`${px(3)} ${px(2)}`} />
                    <circle cx={p.x} cy={p.y} r={px(2.5)} fill={st.color} />
                  </>
                )}
                <g transform={`translate(${mx} ${my})`}>
                  <rect x={-pr} y={-pr} width={pr * 2} height={pr * 2} rx={px(3)} fill="#fff" stroke={st.color} strokeWidth={px(1.5)} />
                  <text y={px(4.5)} textAnchor="middle" fontSize={px(12)} fill={st.color}>
                    {st.glyph}
                  </text>
                  {p.yawDeg !== null && <polygon points={`${pr + px(1)},0 ${pr + px(8)},-${px(3.5)} ${pr + px(8)},${px(3.5)}`} fill={st.color} transform={`rotate(${-p.yawDeg})`} opacity={0.9} />}
                  <text y={pr + gap + fs} textAnchor="middle" fontSize={fs} fill={st.color} fontWeight={600} stroke="#fff" strokeWidth={fs / 5} paintOrder="stroke">
                    {p.name}
                  </text>
                </g>
              </g>
            );
          })}
          {polygon.length > 0 && (
            <g>
              <polygon points={polygon.map((p) => p.join(",")).join(" ")} fill="rgba(37,99,235,0.15)" stroke="#2563eb" strokeWidth={px(1.5)} strokeDasharray={`${px(6)} ${px(3)}`} />
              {polygon.map((p, i) => (
                <circle key={i} cx={p[0]} cy={p[1]} r={px(4)} fill="#2563eb" />
              ))}
            </g>
          )}
          {robotLabels.map(({ r, box, moved, fs1, fs2, line2 }) => {
            const color = FILL[r.common];
            const { x, y, headingDeg } = r.pose!;
            const hl = r.id === highlightRobotId;
            const lx = box.x + box.w / 2;
            const body = (
              <g>
                {moved && <line x1={x} y1={y} x2={lx} y2={box.y + box.h / 2} stroke={color} strokeWidth={px(1)} strokeDasharray={`${px(3)} ${px(2)}`} opacity={0.8} />}
                <g transform={`translate(${x} ${y})`}>
                  {hl && <circle r={R * 1.7} fill="none" stroke={color} strokeWidth={px(2)} opacity={0.5} />}
                  <circle r={R} fill={r.poseIsLastKnown ? "#fff" : color} stroke={color} strokeWidth={px(2.5)} strokeDasharray={r.poseIsLastKnown ? `${px(4)} ${px(3)}` : undefined} />
                  <polygon points={`0,-${R * 1.55} ${R * 0.4},-${R * 0.85} -${R * 0.4},-${R * 0.85}`} fill={color} transform={`rotate(${headingDeg})`} />
                  <text y={px(4)} textAnchor="middle" fontSize={px(11)} fontWeight={700} fill={r.poseIsLastKnown ? color : "#fff"}>
                    {r.batteryPct === null ? "?" : Math.round(r.batteryPct)}
                  </text>
                </g>
                <text x={lx} y={box.y + fs1} textAnchor="middle" fontSize={fs1} fill="#0f172a" fontWeight={600} stroke="#fff" strokeWidth={fs1 / 5} paintOrder="stroke">
                  {r.name}
                </text>
                <text x={lx} y={box.y + fs1 + fs2 * 1.2} textAnchor="middle" fontSize={fs2} fill={color} stroke="#fff" strokeWidth={fs2 / 5} paintOrder="stroke">
                  {line2}
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
        {fitWidthScale > 1.15 && (
          <button type="button" className="h-7 rounded-md bg-white/95 border text-slate-700 shadow-sm hover:bg-slate-50 text-[10px] px-1" onClick={fitWidth} title="지도 너비를 프레임에 맞춤(세로로 긴 지도)">폭 맞춤</button>
        )}
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
            <span className="text-slate-400">점선=실제 위치에서 옮긴 이름표</span>
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
