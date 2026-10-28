"use client";

import { useState } from "react";
import type { CommandType, MapVersion, RegisteredTask, Vendor, Zone } from "@/lib/domain/types";
import { COMMAND_LABEL } from "@/lib/domain/status";
import { COMMAND_SEMANTICS } from "@/lib/domain/commands";
import { issueCommandAction } from "@/app/actions";
import { btn, ResultLine, useAction } from "./ActionButton";
import { FloorMap, type MapRobot } from "./FloorMap";
import { SimTag } from "./ui";

type Scenario = "NORMAL" | "LOST_RESPONSE" | "REJECTED";

/**
 * 원격 작업 지시 패널.
 * - 서버가 권한·상태·중복·충돌을 다시 검증한다. 여기서는 사용자가 가진 명령만 버튼으로 보여준다.
 * - 영역 청소는 구역 선택 또는 사용자 정의 다각형을 지도에서 지정한다(시뮬레이션).
 */
export function CommandPanel({
  robotId,
  vendor,
  model,
  allowed,
  supported,
  tasks,
  map,
  zones,
  robot,
  isSimulation,
  mapMismatch,
}: {
  robotId: string;
  vendor: Vendor;
  model: string;
  allowed: CommandType[];
  supported: CommandType[];
  tasks: RegisteredTask[];
  map: MapVersion | null;
  zones: Zone[];
  robot: MapRobot;
  isSimulation: boolean;
  mapMismatch: boolean;
}) {
  const { pending, result, run } = useAction();
  const [scenario, setScenario] = useState<Scenario>("NORMAL");
  const [taskId, setTaskId] = useState(tasks[0]?.id ?? "");
  const [areaOpen, setAreaOpen] = useState(false);
  const [zoneIds, setZoneIds] = useState<string[]>([]);
  const [polygon, setPolygon] = useState<[number, number][]>([]);
  const [mode, setMode] = useState(model === "L4" ? "SWEEP" : "SWEEP_SCRUB");
  // 클릭마다 고유 키를 만든다. 처리 중에는 버튼이 비활성화되고, 서버는 같은 키의 재전송과 처리 중 명령 충돌을 거부한다.
  const send = (type: CommandType, params: Record<string, unknown> = {}) => {
    const idempotencyKey = `${robotId}-${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    run(() => issueCommandAction({ robotId, type, params, simulation: scenario, idempotencyKey }));
  };

  if (allowed.length === 0) {
    return <p className="text-sm text-gray-600">이 계정에는 이 로봇에 대한 제어 권한이 없습니다. (고객 기본 권한은 조회만 가능합니다. 제어가 필요하면 본사에 명령별 권한 부여를 요청하세요.)</p>;
  }

  const semantics = COMMAND_SEMANTICS[vendor];
  const canArea = allowed.includes("AREA_CLEAN");
  const areaBlocked = !map || !map.corners || mapMismatch;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {isSimulation && <SimTag>샘플 어댑터 — 실제 전송 없음</SimTag>}
        <label className="flex items-center gap-1">
          시뮬레이션 시나리오
          <select className="border rounded px-1 py-0.5" value={scenario} onChange={(e) => setScenario(e.target.value as Scenario)}>
            <option value="NORMAL">정상 접수</option>
            <option value="LOST_RESPONSE">응답 유실(타임아웃)</option>
            <option value="REJECTED">제조사 거부</option>
          </select>
        </label>
      </div>

      <div className="flex flex-wrap gap-2 items-start">
        {allowed.includes("START_TASK") && (
          <div className="flex items-center gap-1">
            <select className="border rounded px-2 py-1.5 text-sm max-w-[220px]" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
              {tasks.length === 0 && <option value="">등록 작업 없음</option>}
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <button type="button" className={btn.primary} disabled={pending || !taskId} onClick={() => send("START_TASK", { taskId })}>
              {COMMAND_LABEL.START_TASK}
            </button>
          </div>
        )}
        {(["PAUSE", "RESUME", "STOP", "GO_HOME"] as CommandType[]).filter((c) => allowed.includes(c)).map((c) => (
          <button key={c} type="button" className={c === "STOP" ? btn.danger : btn.secondary} disabled={pending} onClick={() => send(c)} title={semantics[c].meaning}>
            {COMMAND_LABEL[c]}
          </button>
        ))}
        {canArea && (
          <button type="button" className={btn.secondary} disabled={pending} onClick={() => setAreaOpen((v) => !v)}>
            {COMMAND_LABEL.AREA_CLEAN} {areaOpen ? "닫기" : "지정…"}
          </button>
        )}
      </div>
      {pending && <div className="text-xs text-gray-500">전송 중… (같은 버튼 중복 클릭은 차단됩니다)</div>}
      <ResultLine result={result} />

      <details className="text-xs text-gray-600">
        <summary className="cursor-pointer">이 제조사({vendor})에서 각 명령의 의미</summary>
        <ul className="mt-1 space-y-0.5">
          {supported.map((c) => (
            <li key={c}>
              <b>{COMMAND_LABEL[c]}</b> → {semantics[c].vendorName}: {semantics[c].meaning} {semantics[c].verified ? "" : <span className="text-amber-700">(문서 미검증)</span>}
            </li>
          ))}
        </ul>
      </details>

      {canArea && areaOpen && (
        <div className="border rounded p-3 bg-slate-50 space-y-2">
          <div className="text-sm font-medium">지도 영역 지정 (시뮬레이션)</div>
          {areaBlocked ? (
            <div className="text-sm text-red-700">
              {!map ? "지도가 없습니다." : !map.corners ? "현재 지도에 모서리 좌표가 없어 영역 명령을 차단합니다." : "로봇이 보고한 지도 버전이 현재 지도와 달라 영역 명령을 차단합니다."}
            </div>
          ) : (
            <>
              <p className="text-xs text-gray-600">구역을 클릭해 선택하거나, 빈 곳을 클릭해 사용자 정의 영역의 점을 찍으세요(3점 이상). 지도 v{map!.version} 기준으로 전송되며 서버가 버전·범위를 다시 검증합니다.</p>
              <FloorMap map={map!} zones={zones} robots={[robot]} selectable selectedZoneIds={zoneIds} onToggleZone={(id) => setZoneIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))} polygon={polygon} onAddPoint={(p) => setPolygon((s) => [...s, p])} highlightRobotId={robot.id} />
              <div className="flex flex-wrap gap-2 items-center text-sm">
                <span>선택 구역 {zoneIds.length}개 · 사용자 정의 점 {polygon.length}개</span>
                <button type="button" className={btn.small} onClick={() => setPolygon([])}>
                  점 지우기
                </button>
                <button type="button" className={btn.small} onClick={() => setZoneIds([])}>
                  구역 해제
                </button>
                <label className="flex items-center gap-1">
                  모드
                  <select className="border rounded px-1 py-0.5" value={mode} onChange={(e) => setMode(e.target.value)}>
                    <option value="SWEEP">SWEEP</option>
                    <option value="SWEEP_SCRUB" disabled={model === "L4"}>
                      SWEEP_SCRUB{model === "L4" ? " (L 시리즈 불가)" : ""}
                    </option>
                  </select>
                </label>
                <button type="button" className={btn.primary} disabled={pending} onClick={() => send("AREA_CLEAN", { mapVersionId: map!.id, zoneIds, polygon: polygon.length ? polygon : null, mode })}>
                  영역 청소 전송
                </button>
                <button type="button" className={btn.small} disabled={pending} title="검증 차단 확인용: 지도 범위 밖 좌표" onClick={() => send("AREA_CLEAN", { mapVersionId: map!.id, zoneIds: [], polygon: [[-50, -50], [99999, 10], [10, 99999]], mode })}>
                  범위 밖 다각형 테스트
                </button>
                <button type="button" className={btn.small} disabled={pending} title="검증 차단 확인용: 오래된 지도 버전" onClick={() => send("AREA_CLEAN", { mapVersionId: `${map!.floorId}-map-v1`, zoneIds, polygon: null, mode })}>
                  구버전 지도 테스트
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
