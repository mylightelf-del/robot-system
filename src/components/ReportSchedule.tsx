import Link from "next/link";
import type { ScheduleRow, ScheduleState } from "@/lib/services/reports";
import { periodText } from "@/lib/reports/schedule";
import { REPORT_STATUS_LABEL } from "@/lib/domain/status";
import { Badge } from "./ui";
import { CreateScheduledDraftButton } from "./ReportEditor";

const STATE_LABEL: Record<ScheduleState, string> = {
  UPCOMING: "예정",
  IN_PROGRESS: "기간 진행 중",
  NEEDS_DRAFT: "작성 필요",
  ...REPORT_STATUS_LABEL,
};
const STATE_CLS: Record<ScheduleState, string> = {
  UPCOMING: "bg-white text-gray-500 border border-gray-200",
  IN_PROGRESS: "bg-slate-100 text-slate-700",
  NEEDS_DRAFT: "bg-red-100 text-red-800",
  DRAFT: "bg-gray-100 text-gray-700",
  REVIEW: "bg-amber-100 text-amber-800",
  CONFIRMED: "bg-blue-100 text-blue-800",
  PUBLISHED: "bg-emerald-100 text-emerald-800",
};

export function ScheduleStateBadge({ state }: { state: ScheduleState }) {
  return <Badge className={STATE_CLS[state]}>{STATE_LABEL[state]}</Badge>;
}

function md(k: string): string {
  return `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))}`;
}

/** 설치일 기준 보고서 일정표. 작성 필요·진행 중 일정은 바로 초안을 만들 수 있다. */
export function ReportScheduleTable({ siteId, rows, canEdit, showSite }: { siteId: string; rows: (ScheduleRow & { siteName?: string; siteId?: string })[]; canEdit: boolean; showSite?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="data">
        <thead>
          <tr>
            {showSite && <th>사업장</th>}
            <th>보고서</th>
            <th>대상 기간</th>
            <th>작성일</th>
            <th>상태</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.siteId ?? siteId}-${r.key}`}>
              {showSite && <td className="whitespace-nowrap">{r.siteName}</td>}
              <td className="whitespace-nowrap font-medium">{r.title}</td>
              <td className="whitespace-nowrap">{periodText(r)}</td>
              <td className="whitespace-nowrap text-xs text-gray-600">{md(r.draftOn)}</td>
              <td className="whitespace-nowrap">
                <ScheduleStateBadge state={r.state} />
                {r.version && r.version > 1 ? <span className="text-xs text-gray-500"> v{r.version}</span> : null}
              </td>
              <td className="whitespace-nowrap">
                {r.reportId ? (
                  <Link href={`/reports/${r.reportId}`} className="text-navy text-xs underline">
                    열기
                  </Link>
                ) : canEdit && (r.state === "NEEDS_DRAFT" || r.state === "IN_PROGRESS") ? (
                  <CreateScheduledDraftButton siteId={r.siteId ?? siteId} periodKey={r.key} label={r.state === "IN_PROGRESS" ? "미리 작성" : "초안 만들기"} />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
