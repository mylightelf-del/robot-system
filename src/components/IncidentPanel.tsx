"use client";

import { useState } from "react";
import type { Severity } from "@/lib/domain/types";
import { ackIncidentAction, addIncidentActionAction, assignIncidentAction, resolveIncidentAction, simulateIncidentAction } from "@/app/actions";
import { ActionButton, btn, ResultLine, useAction } from "./ActionButton";

export function IncidentActions({ incidentId, status, assignees }: { incidentId: string; status: string; assignees: { id: string; name: string }[] }) {
  const { pending, result, run } = useAction();
  const [note, setNote] = useState("");
  const [internal, setInternal] = useState(true);
  const [assignee, setAssignee] = useState(assignees[0]?.id ?? "");
  if (status === "RESOLVED") return <span className="text-xs text-gray-500">복구 완료</span>;
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap gap-1 items-center">
        {status === "OPEN" && (
          <ActionButton variant="small" action={() => ackIncidentAction(incidentId)} showResult={false}>
            확인
          </ActionButton>
        )}
        <select className="border rounded px-1 py-0.5" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          {assignees.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <button type="button" className={btn.small} disabled={pending || !assignee} onClick={() => run(() => assignIncidentAction(incidentId, assignee))}>
          담당자 지정
        </button>
      </div>
      <div className="flex flex-wrap gap-1 items-center">
        <input className="border rounded px-2 py-1 flex-1 min-w-[160px]" placeholder="조치 내용" value={note} onChange={(e) => setNote(e.target.value)} />
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> 내부 메모(고객 비공개)
        </label>
        <button type="button" className={btn.small} disabled={pending || !note.trim()} onClick={() => run(() => addIncidentActionAction(incidentId, note, internal))}>
          조치 등록
        </button>
        <button
          type="button"
          className={`${btn.small} border-emerald-300 bg-emerald-50 text-emerald-800`}
          disabled={pending}
          onClick={() => {
            if (!window.confirm("복구 처리하시겠습니까? 복구 통보가 모의 발송됩니다.")) return;
            run(() => resolveIncidentAction(incidentId, note));
          }}
        >
          복구
        </button>
      </div>
      <ResultLine result={result} />
    </div>
  );
}

export function SimulateIncidentForm({ robots, codes }: { robots: { id: string; name: string; siteName: string }[]; codes: { code: string; severity: Severity; label: string }[] }) {
  const { pending, result, run } = useAction();
  const [robotId, setRobotId] = useState(robots[0]?.id ?? "");
  const [codeIdx, setCodeIdx] = useState(0);
  const [eventId, setEventId] = useState("");
  const c = codes[codeIdx];
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap gap-2 items-center">
        <select className="border rounded px-2 py-1" value={robotId} onChange={(e) => setRobotId(e.target.value)}>
          {robots.map((r) => (
            <option key={r.id} value={r.id}>
              {r.siteName} · {r.name}
            </option>
          ))}
        </select>
        <select className="border rounded px-2 py-1" value={codeIdx} onChange={(e) => setCodeIdx(Number(e.target.value))}>
          {codes.map((x, i) => (
            <option key={x.code} value={i}>
              {x.label} ({x.severity})
            </option>
          ))}
        </select>
        <input className="border rounded px-2 py-1 w-44" placeholder="제조사 이벤트 ID(중복 테스트)" value={eventId} onChange={(e) => setEventId(e.target.value)} />
        <button type="button" className={btn.secondary} disabled={pending || !robotId} onClick={() => run(() => simulateIncidentAction(robotId, c.code, c.severity, eventId.trim() || null))}>
          장애 발생 시뮬레이션
        </button>
      </div>
      <ResultLine result={result} />
      <p className="text-xs text-gray-500">Webhook 수신을 대신하는 시뮬레이션입니다. 같은 이벤트 ID 를 두 번 보내면 중복으로 무시됩니다. 알림은 수신자 설정(등급·시간대·중복 억제)에 따라 모의 발송 또는 억제로 기록됩니다.</p>
    </div>
  );
}
