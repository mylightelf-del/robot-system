"use client";

import { useState } from "react";
import type { ReportComments, ReportStatus } from "@/lib/domain/types";
import { confirmReportAction, createDraftAction, publishReportAction, recomputeDraftAction, returnToDraftAction, submitReviewAction, updateCommentsAction } from "@/app/actions";
import { ActionButton, btn, ResultLine, useAction } from "./ActionButton";

const FIELDS: { key: keyof ReportComments; label: string; page: number }[] = [
  { key: "overallOpinion", label: "종합 의견 (1쪽)", page: 1 },
  { key: "incompleteReasons", label: "미완료 사유 (2쪽)", page: 2 },
  { key: "improvements", label: "개선 사항 (4쪽)", page: 4 },
  { key: "focusZones", label: "집중 관리 구역 (4쪽)", page: 4 },
  { key: "nextMonthPlan", label: "차월 계획 (4쪽)", page: 4 },
];

export function CommentsEditor({ reportId, comments, editable }: { reportId: string; comments: ReportComments; editable: boolean }) {
  const [c, setC] = useState(comments);
  const { pending, result, run } = useAction();
  if (!editable) {
    return (
      <div className="space-y-2 text-sm">
        {FIELDS.map((f) => (
          <div key={f.key}>
            <div className="text-xs text-gray-500">{f.label}</div>
            <div className="whitespace-pre-wrap">{comments[f.key] || <span className="text-gray-400">(없음)</span>}</div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {FIELDS.map((f) => (
        <label key={f.key} className="block text-sm">
          <span className="text-xs text-gray-600">{f.label}</span>
          <textarea className="w-full border rounded px-2 py-1 mt-0.5 min-h-[64px]" value={c[f.key]} onChange={(e) => setC({ ...c, [f.key]: e.target.value })} />
        </label>
      ))}
      <button type="button" className={btn.primary} disabled={pending} onClick={() => run(() => updateCommentsAction(reportId, c))}>
        의견 저장
      </button>
      <ResultLine result={result} />
    </div>
  );
}

export function ReportWorkflow({ reportId, status, canEdit, canConfirm, lateRuns, isLatest }: { reportId: string; status: ReportStatus; canEdit: boolean; canConfirm: boolean; lateRuns: number; isLatest: boolean }) {
  return (
    <div className="flex flex-wrap gap-2 items-start">
      {canEdit && (status === "DRAFT" || status === "REVIEW") && (
        <ActionButton action={() => recomputeDraftAction(reportId)}>재집계</ActionButton>
      )}
      {canEdit && status === "DRAFT" && (
        <ActionButton variant="primary" action={() => submitReviewAction(reportId)}>검토 요청</ActionButton>
      )}
      {canConfirm && status === "REVIEW" && (
        <>
          <ActionButton action={() => returnToDraftAction(reportId, "수정 요청")}>초안으로 반려</ActionButton>
          <ActionButton variant="primary" confirmText="확정하면 집계값과 의견이 스냅샷으로 고정되어 수정할 수 없습니다. 확정할까요?" action={() => confirmReportAction(reportId)}>
            확정
          </ActionButton>
        </>
      )}
      {canConfirm && status === "CONFIRMED" && (
        <ActionButton variant="primary" action={() => publishReportAction(reportId)}>고객 공개</ActionButton>
      )}
      {!canConfirm && status === "REVIEW" && canEdit && <span className="text-xs text-gray-500 self-center">확정은 본사 관리자(또는 설정으로 허용된 현장 담당자)가 합니다.</span>}
      {(status === "CONFIRMED" || status === "PUBLISHED") && canEdit && isLatest && lateRuns > 0 && (
        <NewVersionButton reportId={reportId} lateRuns={lateRuns} />
      )}
    </div>
  );
}

function NewVersionButton({ reportId, lateRuns }: { reportId: string; lateRuns: number }) {
  const { pending, result, run } = useAction();
  const [siteId, month] = (() => {
    const m = reportId.match(/^rpt-(site-\d+)-(\d{4}-\d{2})-v\d+$/);
    return m ? [m[1], m[2]] : ["", ""];
  })();
  return (
    <span className="inline-flex flex-col">
      <button type="button" className={btn.secondary} disabled={pending || !siteId} onClick={() => run(() => createDraftAction(siteId, month))}>
        늦은 실적 {lateRuns}건 반영 — 새 버전 작성
      </button>
      <ResultLine result={result} />
      <span className="text-[11px] text-gray-500">기존 확정본은 덮어쓰지 않고 유지됩니다.</span>
    </span>
  );
}

export function NewDraftForm({ sites, defaultMonth }: { sites: { id: string; name: string }[]; defaultMonth: string }) {
  const { pending, result, run } = useAction();
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  const [month, setMonth] = useState(defaultMonth);
  return (
    <div className="flex flex-wrap gap-2 items-center text-sm">
      <select className="border rounded px-2 py-1" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
        {sites.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <input type="month" className="border rounded px-2 py-1" value={month} onChange={(e) => setMonth(e.target.value)} />
      <button type="button" className={btn.primary} disabled={pending || !siteId} onClick={() => run(() => createDraftAction(siteId, month))}>
        초안 생성(자동 집계)
      </button>
      <ResultLine result={result} />
    </div>
  );
}
