"use client";

import Link from "next/link";
import type { CommonStatus, MapVersion, Zone } from "@/lib/domain/types";
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

/**
 * 층 지도(샘플). 실제 지도 이미지는 제조사 API(지도 이미지·모서리 좌표)로 교체한다.
 * - 구역 선택 모드(selectable): 구역 클릭으로 선택, 빈 곳 클릭으로 사용자 정의 영역 점 추가.
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
}) {
  const W = map.widthPx;
  const H = map.heightPx;
  return (
    <div className={`relative ${className}`}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto bg-slate-50 border border-gray-200 rounded"
        role="img"
        aria-label="층 지도(샘플)"
        onClick={(e) => {
          if (!selectable || !onAddPoint) return;
          const svg = e.currentTarget;
          const pt = svg.createSVGPoint();
          pt.x = e.clientX;
          pt.y = e.clientY;
          const ctm = svg.getScreenCTM();
          if (!ctm) return;
          const p = pt.matrixTransform(ctm.inverse());
          onAddPoint([Math.round(p.x), Math.round(p.y)]);
        }}
      >
        <rect x={0} y={0} width={W} height={H} fill="#f8fafc" />
        <rect x={40} y={40} width={W - 80} height={H - 80} fill="none" stroke="#cbd5e1" strokeWidth={3} />
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
              <polygon points={pts} fill={sel ? "#bfdbfe" : "#e2e8f0"} stroke={sel ? "#1d4ed8" : "#94a3b8"} strokeWidth={sel ? 4 : 2} />
              <text x={cx} y={cy} textAnchor="middle" fontSize={26} fill="#334155">
                {z.name}
              </text>
              <text x={cx} y={cy + 30} textAnchor="middle" fontSize={20} fill="#64748b">
                {z.areaM2}㎡
              </text>
            </g>
          );
        })}
        {polygon.length > 0 && (
          <g>
            <polygon points={polygon.map((p) => p.join(",")).join(" ")} fill="rgba(37,99,235,0.15)" stroke="#2563eb" strokeWidth={3} strokeDasharray="10 6" />
            {polygon.map((p, i) => (
              <circle key={i} cx={p[0]} cy={p[1]} r={8} fill="#2563eb" />
            ))}
          </g>
        )}
        {robots.map((r) => {
          if (!r.pose) return null;
          const color = FILL[r.common];
          const { x, y, headingDeg } = r.pose;
          const hl = r.id === highlightRobotId;
          const body = (
            <g transform={`translate(${x} ${y})`}>
              {hl && <circle r={44} fill="none" stroke={color} strokeWidth={3} opacity={0.5} />}
              <circle r={26} fill={r.poseIsLastKnown ? "#fff" : color} stroke={color} strokeWidth={4} strokeDasharray={r.poseIsLastKnown ? "8 6" : undefined} />
              <polygon points="0,-40 10,-22 -10,-22" fill={color} transform={`rotate(${headingDeg})`} />
              <text y={6} textAnchor="middle" fontSize={18} fontWeight={700} fill={r.poseIsLastKnown ? color : "#fff"}>
                {r.batteryPct === null ? "?" : Math.round(r.batteryPct)}
              </text>
              <text y={50} textAnchor="middle" fontSize={20} fill="#0f172a">
                {r.name}
              </text>
              <text y={70} textAnchor="middle" fontSize={16} fill={color}>
                {STATUS_LABEL[r.common]}
                {r.poseIsLastKnown ? " · 마지막 위치" : ""}
                {r.progressPct !== null ? ` ${Math.round(r.progressPct)}%` : ""}
              </text>
            </g>
          );
          return selectable ? (
            <g key={r.id}>{body}</g>
          ) : (
            <Link key={r.id} href={`/robots/${r.id}`}>
              {body}
            </Link>
          );
        })}
      </svg>
      <div className="absolute left-2 bottom-2 bg-white/90 rounded px-2 py-1 text-[11px] text-gray-600 border">
        샘플 지도 · 원 안 숫자=배터리% · 삼각형=진행 방향 · 점선 원=마지막 보고 위치(오프라인)
      </div>
    </div>
  );
}
