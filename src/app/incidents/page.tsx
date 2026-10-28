import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/session";
import { listIncidents, SIMULATABLE_CODES } from "@/lib/services/incidents";
import { listRobots, listSites } from "@/lib/services/robots";
import { getStore } from "@/lib/store/store";
import { canHandleIncidents, isCustomer } from "@/lib/auth/authz";
import { AppError } from "@/lib/util/errors";
import { Card, Empty, PageTitle, SimTag } from "@/components/ui";
import { AccessDenied } from "@/components/AccessDenied";
import { SiteFilter } from "@/components/SiteFilter";
import { IncidentActions, SimulateIncidentForm } from "@/components/IncidentPanel";
import { IncidentStatusBadge, SeverityBadge } from "@/components/StatusBadge";
import { formatDateTime, nowIso, relativeFromNow } from "@/lib/util/time";

export default async function IncidentsPage({ searchParams }: { searchParams: Promise<{ site?: string; all?: string }> }) {
  const { site, all } = await searchParams;
  const user = await getCurrentUser();
  let rows, sites, robots;
  try {
    sites = listSites(user);
    rows = listIncidents(user, { siteId: site || undefined, includeResolved: all === "1" });
    robots = listRobots(user, site || undefined);
  } catch (e) {
    return <AccessDenied reason={e instanceof AppError ? e.message : "접근할 수 없습니다."} />;
  }
  const customer = isCustomer(user);
  const handler = canHandleIncidents(user);
  const store = getStore();
  const assignees = store.users.filter((u) => u.active && (u.role === "HQ_ADMIN" || u.role === "SITE_MANAGER")).map((u) => ({ id: u.id, name: u.name }));
  const now = nowIso();
  const escalate = (siteId: string) => store.notificationSettings.find((n) => n.siteId === siteId)?.escalateAfterMinutes ?? 60;

  return (
    <>
      <PageTitle
        title="장애·조치"
        subtitle={customer ? "고객 화면에는 요약 메시지와 외부 공개 조치만 표시됩니다." : "발생 → 확인 → 담당자 지정 → 조치 등록 → 복구. 알림 발송 상태를 함께 표시합니다."}
        right={
          <div className="flex flex-wrap gap-2 items-center">
            <SiteFilter sites={sites} current={site ?? ""} basePath="/incidents" extra={all === "1" ? "all=1" : ""} />
            <Link href={`/incidents?${site ? `site=${site}&` : ""}${all === "1" ? "" : "all=1"}`} className="text-xs text-navy underline">
              {all === "1" ? "미조치만" : "복구 포함 전체"}
            </Link>
          </div>
        }
      />

      {handler && (
        <div className="mb-4">
          <Card title="장애 발생 시뮬레이션" right={<SimTag />}>
            <SimulateIncidentForm robots={robots.map((r) => ({ id: r.robot.id, name: r.robot.name, siteName: r.site.name }))} codes={SIMULATABLE_CODES} />
          </Card>
        </div>
      )}

      <Card>
        {rows.length === 0 ? (
          <Empty>표시할 장애가 없습니다.</Empty>
        ) : (
          <ul className="divide-y">
            {rows.map((i) => {
              const overdue = i.status !== "RESOLVED" && i.minutesOpen >= escalate(i.siteId) && (i.status === "OPEN" || i.status === "ACKED");
              return (
                <li key={i.id} className="py-3 grid lg:grid-cols-[1fr_320px] gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <SeverityBadge severity={i.severity} />
                      <IncidentStatusBadge status={i.status} />
                      <span className="font-mono text-xs text-gray-500">{i.code}</span>
                      <span className="text-xs text-gray-500" title={formatDateTime(i.occurredAt)}>
                        {relativeFromNow(i.occurredAt, now)} 발생
                      </span>
                      {overdue && <span className="text-xs bg-red-100 text-red-800 rounded px-1.5">미조치 {i.minutesOpen}분 — 확대 통보 기준({escalate(i.siteId)}분) 초과</span>}
                    </div>
                    <div className="mt-1 text-sm">
                      <Link href={`/robots/${i.robotId}`} className="font-medium text-navy hover:underline">{i.robotName}</Link>
                      <span className="text-gray-500 text-xs"> · {i.siteName}</span>
                    </div>
                    <div className="text-sm text-gray-800">{i.message}</div>
                    {i.rawMessage && <div className="text-xs text-gray-500 font-mono mt-0.5">원문: {i.rawMessage}</div>}
                    {i.assigneeName && <div className="text-xs text-gray-600 mt-0.5">담당: {i.assigneeName}</div>}
                    {i.actions.length > 0 && (
                      <ul className="mt-1 text-xs text-gray-700 space-y-0.5">
                        {i.actions.map((a) => (
                          <li key={a.id}>
                            <span className="text-gray-500">{formatDateTime(a.at)}</span> {a.internal ? <span className="text-amber-700">[내부]</span> : null} {a.note}
                          </li>
                        ))}
                      </ul>
                    )}
                    {i.resolvedAt && <div className="text-xs text-emerald-700 mt-0.5">복구 {formatDateTime(i.resolvedAt)} (소요 {i.minutesOpen}분)</div>}
                    {!customer && i.notifications.length > 0 && (
                      <details className="text-xs mt-1">
                        <summary className="cursor-pointer text-gray-600">알림 발송 {i.notifications.length}건 (모의)</summary>
                        <ul className="mt-0.5 space-y-0.5">
                          {i.notifications.map((n) => (
                            <li key={n.id}>
                              <span className="text-gray-500">{formatDateTime(n.at)}</span> {n.channel === "EMAIL" ? "이메일" : "알림톡"} → {n.recipient}{" "}
                              <span className={n.status === "MOCK_SENT" ? "text-emerald-700" : n.status === "SUPPRESSED" ? "text-gray-500" : "text-red-700"}>
                                {n.status === "MOCK_SENT" ? "모의 발송" : n.status === "SUPPRESSED" ? "억제" : "실패"}
                              </span>{" "}
                              <span className="text-gray-500">— {n.reason}</span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                  <div className="no-print">{handler ? <IncidentActions incidentId={i.id} status={i.status} assignees={assignees} /> : <span className="text-xs text-gray-400">조회 전용</span>}</div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
