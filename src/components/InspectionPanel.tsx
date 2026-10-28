"use client";

import { useState } from "react";
import type { Inspection } from "@/lib/domain/types";
import { addManualInspectionAction, completeInspectionAction } from "@/app/actions";
import { ActionButton, btn, ResultLine, useAction } from "./ActionButton";
import { formatDate } from "@/lib/util/time";

export function InspectionPanel({ robotId, inspections, canEdit, tz }: { robotId: string; inspections: Inspection[]; canEdit: boolean; tz: string }) {
  const [item, setItem] = useState("");
  const { pending, result, run } = useAction();
  return (
    <div className="space-y-2">
      {inspections.length === 0 ? (
        <p className="text-sm text-gray-500">점검 기록이 없습니다.</p>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>항목</th>
              <th>예정일</th>
              <th>완료</th>
              {canEdit && <th></th>}
            </tr>
          </thead>
          <tbody>
            {inspections.map((i) => (
              <tr key={i.id}>
                <td>{i.item}</td>
                <td>{formatDate(i.dueAt, tz)}</td>
                <td>{i.doneAt ? <span className="text-emerald-700">{formatDate(i.doneAt, tz)} · {i.note}</span> : <span className="text-amber-700">미완료</span>}</td>
                {canEdit && (
                  <td>
                    {!i.doneAt && (
                      <ActionButton variant="small" action={() => completeInspectionAction(i.id, "수기 기록")} showResult={false}>
                        완료 기록
                      </ActionButton>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canEdit && (
        <div className="flex gap-2 items-center">
          <input className="border rounded px-2 py-1 text-sm" placeholder="수기 점검 항목 (예: 오수 처리)" value={item} onChange={(e) => setItem(e.target.value)} />
          <button type="button" className={btn.small} disabled={pending || !item.trim()} onClick={() => run(() => addManualInspectionAction(robotId, item.trim()))}>
            수기 기록 추가
          </button>
        </div>
      )}
      <ResultLine result={result} />
      <p className="text-xs text-gray-500">API 로 제공되지 않는 점검(물 보충·오수 처리·브러시 청소 등)은 수기 기록으로 관리합니다.</p>
    </div>
  );
}
