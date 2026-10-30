"use client";

import { useState } from "react";
import type { Severity } from "@/lib/domain/types";
import { ackIncidentAction, addIncidentActionAction, assignIncidentAction, cancelIncidentActionAction, dismissIncidentsAction, resolveIncidentAction, restoreIncidentAction, revertIncidentAction, simulateIncidentAction } from "@/app/actions";
import { ActionButton, btn, ResultLine, useAction } from "./ActionButton";

/** 한 단계 되돌리기(사유 입력). */
function RevertButton({ incidentId, label, run, pending }: { incidentId: string; label: string; run: ReturnType<typeof useAction>["run"]; pending: boolean }) {
  return (
    <button
      type="button"
      className={`${btn.small} border-amber-300 bg-amber-50 text-amber-900`}
      disabled={pending}
      onClick={() => {
        const reason = window.prompt(`${label} — 사유를 입력하세요(감사 기록에 남습니다).`, "잘못 처리함");
        if (reason === null) return;
        run(() => revertIncidentAction(incidentId, reason));
      }}
    >
      ↶ {label}
    </button>
  );
}

export function IncidentActions({ incidentId, status, assignees, revertLabel }: { incidentId: string; status: string; assignees: { id: string; name: string }[]; revertLabel: string | null }) {
  const { pending, result, run } = useAction();
  const [note, setNote] = useState("");
  const [internal, setInternal] = useState(true);
  const [assignee, setAssignee] = useState(assignees[0]?.id ?? "");
  if (status === "RESOLVED")
    return (
      <div className="space-y-1 text-xs">
        <span className="text-gray-500 mr-2">복구 완료</span>
        {revertLabel && <RevertButton incidentId={incidentId} label={revertLabel} run={run} pending={pending} />}
        <ResultLine result={result} />
      </div>
    );
  return (
    <div className="space-y-2 text-xs">
      {revertLabel && (
        <div>
          <RevertButton incidentId={incidentId} label={revertLabel} run={run} pending={pending} />
        </div>
      )}
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

/** 조치 기록 하나 취소(잘못 쓴 메모). */
export function CancelActionButton({ actionId }: { actionId: string }) {
  const { pending, result, run } = useAction();
  return (
    <span className="inline-flex items-center gap-1 no-print">
      <button
        type="button"
        className="text-[11px] text-red-700 underline disabled:opacity-50"
        disabled={pending}
        onClick={() => {
          const reason = window.prompt("이 조치 기록을 취소할까요? 사유를 입력하세요(감사 기록에 남습니다).", "잘못 입력함");
          if (reason === null) return;
          run(() => cancelIncidentActionAction(actionId, reason));
        }}
      >
        취소
      </button>
      <ResultLine result={result} />
    </span>
  );
}

/** 선택한 알림 삭제: 목록의 체크박스(name="dismiss")를 모아 지운다. */
export function DismissSelected() {
  const { pending, result, run } = useAction();
  const [reason, setReason] = useState("");
  const selected = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[name="dismiss"]:checked')).map((el) => el.value);
  return (
    <div className="flex flex-wrap gap-2 items-center text-xs">
      <label className="flex items-center gap-1">
        <input
          type="checkbox"
          onChange={(e) => document.querySelectorAll<HTMLInputElement>('input[name="dismiss"]').forEach((el) => (el.checked = e.target.checked))}
        />
        전체 선택
      </label>
      <input className="border rounded px-2 py-1 w-64" placeholder="삭제 사유(예: 정상 동작 중 경고, 시험 중 발생)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button
        type="button"
        className={btn.danger}
        disabled={pending || !reason.trim()}
        onClick={() => {
          const ids = selected();
          if (!ids.length) return window.alert("삭제할 알림을 체크하세요.");
          if (!window.confirm(`알림 ${ids.length}건을 삭제할까요? 목록·대시보드·보고서에서 빠지고, 본사 관리자가 복원할 수 있습니다.`)) return;
          run(() => dismissIncidentsAction(ids, reason));
        }}
      >
        선택한 알림 삭제
      </button>
      <ResultLine result={result} />
    </div>
  );
}

export function RestoreIncidentButton({ incidentId }: { incidentId: string }) {
  const { pending, result, run } = useAction();
  return (
    <span className="inline-flex flex-col">
      <button type="button" className={btn.small} disabled={pending} onClick={() => run(() => restoreIncidentAction(incidentId))}>
        복원
      </button>
      <ResultLine result={result} />
    </span>
  );
}
