import type { CommandState, CommonStatus, IncidentStatus, ReportStatus, Severity } from "@/lib/domain/types";
import { COMMAND_STATE_LABEL, COMMAND_STATE_STYLE, INCIDENT_STATUS_LABEL, REPORT_STATUS_LABEL, SEVERITY_LABEL, SEVERITY_STYLE, STATUS_LABEL, STATUS_STYLE } from "@/lib/domain/status";
import { Badge } from "./ui";

export function StatusBadge({ status }: { status: CommonStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <Badge className={`${s.cls} border`}>
      <span aria-hidden>{s.icon}</span>
      {STATUS_LABEL[status]}
    </Badge>
  );
}

export function CommandStateBadge({ state }: { state: CommandState }) {
  return <Badge className={COMMAND_STATE_STYLE[state]}>{COMMAND_STATE_LABEL[state]}</Badge>;
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge className={SEVERITY_STYLE[severity]}>{SEVERITY_LABEL[severity]}</Badge>;
}

export function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  const cls: Record<IncidentStatus, string> = {
    OPEN: "bg-red-100 text-red-800",
    ACKED: "bg-amber-100 text-amber-800",
    ASSIGNED: "bg-sky-100 text-sky-800",
    IN_PROGRESS: "bg-blue-100 text-blue-800",
    RESOLVED: "bg-emerald-100 text-emerald-800",
  };
  return <Badge className={cls[status]}>{INCIDENT_STATUS_LABEL[status]}</Badge>;
}

export function ReportStatusBadge({ status }: { status: ReportStatus }) {
  const cls: Record<ReportStatus, string> = {
    DRAFT: "bg-gray-100 text-gray-700",
    REVIEW: "bg-amber-100 text-amber-800",
    CONFIRMED: "bg-blue-100 text-blue-800",
    PUBLISHED: "bg-emerald-100 text-emerald-800",
  };
  return <Badge className={cls[status]}>{REPORT_STATUS_LABEL[status]}</Badge>;
}

export function Battery({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-purple-700 text-xs">배터리 미수신</span>;
  const tone = pct < 20 ? "text-red-700" : pct < 40 ? "text-amber-700" : "text-gray-800";
  return (
    <span className={`inline-flex items-center gap-1 text-sm ${tone}`}>
      <span className="inline-block w-8 h-3 border border-current rounded-sm relative">
        <span className="absolute inset-y-0 left-0 bg-current opacity-60" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
      </span>
      {Math.round(pct)}%
    </span>
  );
}
