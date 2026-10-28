"use client";

import { useState } from "react";
import type { CleanMode, Zone } from "@/lib/domain/types";
import { cancelPlannedAction, createScheduleAction, createTaskAction, toggleScheduleAction } from "@/app/actions";
import { ActionButton, btn, ResultLine, useAction } from "./ActionButton";

const DOW = ["일", "월", "화", "수", "목", "금", "토"];

export function ScheduleToggle({ scheduleId, enabled, disabled }: { scheduleId: string; enabled: boolean; disabled: boolean }) {
  return (
    <ActionButton variant="small" disabled={disabled} action={() => toggleScheduleAction(scheduleId, !enabled)} showResult={false}>
      {enabled ? "비활성화" : "활성화"}
    </ActionButton>
  );
}

export function CancelPlannedButton({ plannedId }: { plannedId: string }) {
  const { pending, result, run } = useAction();
  return (
    <span className="inline-flex flex-col">
      <button
        type="button"
        className={btn.small}
        disabled={pending}
        onClick={() => {
          const reason = window.prompt("취소 사유를 입력하세요 (계획 변경 이력에 남습니다)");
          if (reason === null) return;
          run(() => cancelPlannedAction(plannedId, reason));
        }}
      >
        취소
      </button>
      <ResultLine result={result} />
    </span>
  );
}

export function NewTaskForm({ robots, zones }: { robots: { id: string; name: string; floorId: string; model: string; siteName: string }[]; zones: Zone[] }) {
  const { pending, result, run } = useAction();
  const [robotId, setRobotId] = useState(robots[0]?.id ?? "");
  const [name, setName] = useState("");
  const [zoneIds, setZoneIds] = useState<string[]>([]);
  const [mode, setMode] = useState<CleanMode>("SWEEP");
  const robot = robots.find((r) => r.id === robotId);
  const floorZones = zones.filter((z) => z.floorId === robot?.floorId);
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap gap-2">
        <select className="border rounded px-2 py-1" value={robotId} onChange={(e) => { setRobotId(e.target.value); setZoneIds([]); }}>
          {robots.map((r) => (
            <option key={r.id} value={r.id}>
              {r.siteName} · {r.name} ({r.model})
            </option>
          ))}
        </select>
        <input className="border rounded px-2 py-1 flex-1 min-w-[160px]" placeholder="작업 이름" value={name} onChange={(e) => setName(e.target.value)} />
        <select className="border rounded px-2 py-1" value={mode} onChange={(e) => setMode(e.target.value as CleanMode)}>
          <option value="SWEEP">SWEEP</option>
          <option value="SWEEP_SCRUB" disabled={robot?.model === "L4"}>SWEEP_SCRUB{robot?.model === "L4" ? " (L 시리즈 불가)" : ""}</option>
        </select>
      </div>
      <div className="flex flex-wrap gap-2">
        {floorZones.map((z) => (
          <label key={z.id} className="flex items-center gap-1 border rounded px-2 py-0.5">
            <input type="checkbox" checked={zoneIds.includes(z.id)} onChange={(e) => setZoneIds((s) => (e.target.checked ? [...s, z.id] : s.filter((x) => x !== z.id)))} />
            {z.name}
          </label>
        ))}
      </div>
      <button type="button" className={btn.primary} disabled={pending} onClick={() => run(() => createTaskAction({ robotId, name, zoneIds, mode }))}>
        작업 등록 (샘플)
      </button>
      <ResultLine result={result} />
      <p className="text-xs text-gray-500">제조사 쪽 등록(CenoBots Favorite 등)은 3단계에서 API 로 연결합니다. 지금은 시스템 내부 등록만 됩니다.</p>
    </div>
  );
}

export function NewScheduleForm({ tasks }: { tasks: { id: string; name: string; robotName: string }[] }) {
  const { pending, result, run } = useAction();
  const [taskId, setTaskId] = useState(tasks[0]?.id ?? "");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [time, setTime] = useState("22:00");
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap gap-2 items-center">
        <select className="border rounded px-2 py-1 max-w-[260px]" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.robotName} · {t.name}
            </option>
          ))}
        </select>
        <input type="time" className="border rounded px-2 py-1" value={time} onChange={(e) => setTime(e.target.value)} />
        <div className="flex gap-1">
          {DOW.map((d, i) => (
            <label key={i} className={`px-2 py-0.5 border rounded cursor-pointer ${days.includes(i) ? "bg-navy text-white border-navy" : ""}`}>
              <input type="checkbox" className="hidden" checked={days.includes(i)} onChange={(e) => setDays((s) => (e.target.checked ? [...s, i] : s.filter((x) => x !== i)))} />
              {d}
            </label>
          ))}
        </div>
        <button type="button" className={btn.primary} disabled={pending || !taskId} onClick={() => run(() => createScheduleAction({ taskId, daysOfWeek: days, time }))}>
          예약 추가
        </button>
      </div>
      <ResultLine result={result} />
      <p className="text-xs text-gray-500">시각은 사업장 시간대(Asia/Seoul) 기준입니다. 실행 주체는 로봇별로 하나(제조사 예약 또는 자체 실행기)만 사용합니다.</p>
    </div>
  );
}
