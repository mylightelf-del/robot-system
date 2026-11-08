import Link from "next/link";
import { listUsers } from "@/lib/db/repo";
import { getCurrentUser } from "@/lib/auth/session";
import { describeCode, escalationMinutesBySite, incidentGuide, incidentPhotosFor, incidentStats, listAssignableUsers, listIncidents, SIMULATABLE_CODES } from "@/lib/services/incidents";
import { CodeChip } from "@/components/CodeChip";
import { IncidentPhotos } from "@/components/IncidentPhotos";
import { listRobots, listSites } from "@/lib/services/robots";
import { canAdmin, canHandleIncidents, isCustomer } from "@/lib/auth/authz";
import { AppError } from "@/lib/util/errors";
import { Card, Empty, PageTitle, SimTag } from "@/components/ui";
import { AccessDenied } from "@/components/AccessDenied";
import { SiteFilter } from "@/components/SiteFilter";
import { CancelActionButton, DismissSelected, IncidentActions, RestoreIncidentButton, SimulateIncidentForm } from "@/components/IncidentPanel";
import { IncidentStatusBadge, SeverityBadge } from "@/components/StatusBadge";
import { formatDateTime, formatDurationMin, nowIso, relativeFromNow } from "@/lib/util/time";

export default async function IncidentsPage({ searchParams }: { searchParams: Promise<{ site?: string; all?: string; dismissed?: string }> }) {
  const { site, all } = await searchParams;
  const dismissedView = (await searchParams).dismissed === "1";
  const user = await getCurrentUser();
  let rows, sites, robots;
  try {
    sites = await listSites(user);
    rows = await listIncidents(user, { siteId: site || undefined, includeResolved: all === "1", dismissed: dismissedView });
    robots = await listRobots(user, site || undefined);
  } catch (e) {
    return <AccessDenied reason={e instanceof AppError ? e.message : "접근할 수 없습니다."} />;
  }
  const customer = isCustomer(user);
  const handler = canHandleIncidents(user);
  const assignees = handler ? await listAssignableUsers() : [];
  const userNames = new Map((handler ? await listUsers() : []).map((u) => [u.id, u.name]));
  const escalation = await escalationMinutesBySite(sites.map((s) => s.id));
  const now = nowIso();
  const escalate = (siteId: string) => escalation[siteId] ?? 60;
  const photos = await incidentPhotosFor(user, rows.map((r) => r.id));
  const stats = handler && !dismissedView ? await incidentStats(user, { siteId: site || undefined, days: 90 }) : null;
  const fmtMin = (m: number) => formatDurationMin(m);

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
            {handler && (
              <Link href={`/incidents?${site ? `site=${site}&` : ""}${dismissedView ? "" : "dismissed=1"}`} className="text-xs text-navy underline">
                {dismissedView ? "장애 목록으로" : "삭제한 알림 보기"}
              </Link>
            )}
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

      {stats && stats.total > 0 && (
        <div className="mb-4">
          <Card title={`반복 장애 분석 (최근 ${stats.days}일 · ${stats.total}건, 복구 ${stats.resolved}건${stats.mttrMin !== null ? ` · 평균 조치 ${fmtMin(stats.mttrMin)}` : ""})`}>
            <div className="grid lg:grid-cols-3 gap-4 text-sm">
              <div className="overflow-x-auto">
                <div className="text-xs font-medium mb-1">코드별 Top</div>
                <table className="data">
                  <thead><tr><th>코드</th><th className="text-right">건</th><th className="text-right">로봇</th><th className="text-right">평균 조치</th></tr></thead>
                  <tbody>
                    {stats.byCode.map((c) => (
                      <tr key={c.code}>
                        <td>{(() => { const dc = describeCode(c.code, c.message); return <CodeChip code={c.code} summary={dc.summary} steps={dc.steps} vendor={dc.vendor} />; })()}<div className="text-xs text-gray-500">{c.message}{c.vendorHint ? " · 반복 시 대리점" : ""}</div></td>
                        <td className="text-right">{c.count}</td>
                        <td className="text-right">{c.robots}</td>
                        <td className="text-right whitespace-nowrap">{c.mttrMin === null ? "-" : fmtMin(c.mttrMin)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="overflow-x-auto">
                <div className="text-xs font-medium mb-1">로봇별 Top</div>
                <table className="data">
                  <thead><tr><th>로봇</th><th className="text-right">건</th><th>주요 코드</th><th>최근</th></tr></thead>
                  <tbody>
                    {stats.byRobot.map((r) => (
                      <tr key={r.robotId}>
                        <td><Link href={`/robots/${r.robotId}`} className="text-navy hover:underline">{r.robotName}</Link><div className="text-xs text-gray-500">{r.siteName}</div></td>
                        <td className="text-right">{r.count}</td>
                        <td className="font-mono text-xs">{r.topCode}</td>
                        <td className="text-xs whitespace-nowrap">{relativeFromNow(r.lastAt, now)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="overflow-x-auto">
                <div className="text-xs font-medium mb-1">같은 로봇·같은 코드 반복(7일 안)</div>
                {stats.recurrences.length === 0 ? (
                  <div className="text-xs text-gray-500">반복 장애가 없습니다.</div>
                ) : (
                  <table className="data">
                    <thead><tr><th>로봇</th><th>코드</th><th className="text-right">횟수</th><th className="text-right">평균 간격</th></tr></thead>
                    <tbody>
                      {stats.recurrences.map((r) => (
                        <tr key={`${r.robotId}-${r.code}`}>
                          <td><Link href={`/robots/${r.robotId}`} className="text-navy hover:underline">{r.robotName}</Link></td>
                          <td>{(() => { const dc = describeCode(r.code); return <CodeChip code={r.code} summary={dc.summary} steps={dc.steps} vendor={dc.vendor} />; })()}</td>
                          <td className="text-right">{r.count}</td>
                          <td className="text-right whitespace-nowrap">{r.avgGapHours === null ? "묶음" : r.avgGapHours >= 24 ? `${Math.round(r.avgGapHours / 24)}일` : `${r.avgGapHours}시간`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <p className="text-xs text-gray-500 mt-1">반복 장애는 현장 조치로 해결되지 않는 원인(지도·배치·부품)일 수 있습니다. 대리점에 코드와 횟수를 알려 점검을 요청하세요.</p>
              </div>
            </div>
          </Card>
        </div>
      )}

      <Card
        title={dismissedView ? "삭제한 알림" : `장애 목록 (${rows.length}건)`}
        right={handler && !dismissedView && rows.length > 0 ? <DismissSelected /> : undefined}
      >
        {rows.length === 0 ? (
          <Empty>{dismissedView ? "삭제한 알림이 없습니다." : "표시할 장애가 없습니다."}</Empty>
        ) : (
          <ul className="divide-y">
            {rows.map((i) => {
              const overdue = i.status !== "RESOLVED" && i.minutesOpen >= escalate(i.siteId) && (i.status === "OPEN" || i.status === "ACKED");
              return (
                <li key={i.id} className="py-3 grid lg:grid-cols-[1fr_320px] gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {handler && !dismissedView && <input type="checkbox" name="dismiss" value={i.id} aria-label="삭제 선택" className="no-print" />}
                      <SeverityBadge severity={i.severity} />
                      <IncidentStatusBadge status={i.status} />
                      {!customer && (() => { const dc = describeCode(i.code, i.message); return <CodeChip code={i.code} summary={dc.summary} steps={handler ? dc.steps : []} vendor={handler && dc.vendor} className="text-gray-500" />; })()}
                      <span className="text-xs text-gray-500" title={formatDateTime(i.occurredAt)}>
                        {relativeFromNow(i.occurredAt, now)} 발생
                      </span>
                      {i.occurrences > 1 && (
                        <span className="text-xs bg-amber-100 text-amber-900 rounded px-1.5" title={i.lastOccurredAt ? `최근 ${formatDateTime(i.lastOccurredAt)}` : undefined}>
                          반복 {i.occurrences}회{i.lastOccurredAt ? ` · 최근 ${relativeFromNow(i.lastOccurredAt, now)}` : ""}
                        </span>
                      )}
                      {overdue && <span className="text-xs bg-red-100 text-red-800 rounded px-1.5">미조치 {formatDurationMin(i.minutesOpen)} — 확대 통보 기준({formatDurationMin(escalate(i.siteId))}) 초과</span>}
                      {!overdue && i.status !== "RESOLVED" && !dismissedView && <span className="text-xs text-gray-600">경과 {formatDurationMin(i.minutesOpen)}</span>}
                    </div>
                    <div className="mt-1 text-sm">
                      <Link href={`/robots/${i.robotId}`} className="font-medium text-navy hover:underline">{i.robotName}</Link>
                      <span className="text-gray-500 text-xs"> · {i.siteName}</span>
                    </div>
                    <div className="text-sm text-gray-800">{i.message}</div>
                    {i.rawMessage && <div className="text-xs text-gray-500 font-mono mt-0.5">원문: {i.rawMessage}</div>}
                    {handler && i.status !== "RESOLVED" && !dismissedView && (() => {
                      const g = incidentGuide(i.code);
                      return (
                        <div className="mt-1 text-xs bg-sky-50 border border-sky-100 rounded px-2 py-1 text-sky-900 no-print">
                          <span className="font-medium">현장 조치 안내:</span> {g.field.join(" → ")}
                          {g.vendor ? <span className="text-gray-600"> · 반복되면 대리점 문의</span> : null}
                        </div>
                      );
                    })()}
                    {i.assigneeName && <div className="text-xs text-gray-600 mt-0.5">담당: {i.assigneeName}</div>}
                    {i.actions.length > 0 && (
                      <ul className="mt-1 text-xs text-gray-700 space-y-0.5">
                        {i.actions.map((a) => (
                          <li key={a.id}>
                            <span className="text-gray-500">{formatDateTime(a.at)}</span> {a.internal ? <span className="text-amber-700">[내부]</span> : null} {a.note}{" "}
                            {handler && !dismissedView && i.status !== "RESOLVED" && <CancelActionButton actionId={a.id} />}
                          </li>
                        ))}
                      </ul>
                    )}
                    <IncidentPhotos incidentId={i.id} photos={(photos.get(i.id) ?? []).map((p) => ({ id: p.id, caption: p.caption, internal: p.internal, createdAt: p.createdAt }))} canEdit={handler && !dismissedView} />
                    {i.resolvedAt && <div className="text-xs text-emerald-700 mt-0.5">복구 {formatDateTime(i.resolvedAt)} (소요 {formatDurationMin(i.minutesOpen)})</div>}
                    {i.dismissedAt && <div className="text-xs text-gray-600 mt-0.5">삭제 {formatDateTime(i.dismissedAt)} — 사유: {i.dismissReason}</div>}
                    {!customer && i.notifications.length > 0 && (
                      <details className="text-xs mt-1">
                        <summary className="cursor-pointer text-gray-600">
                          알림 {i.notifications.length}건 (발송 {i.notifications.filter((n) => n.status === "SENT").length} · 모의 {i.notifications.filter((n) => n.status === "MOCK_SENT").length} · 억제 {i.notifications.filter((n) => n.status === "SUPPRESSED").length} · 실패 {i.notifications.filter((n) => n.status === "FAILED").length})
                        </summary>
                        <ul className="mt-0.5 space-y-0.5">
                          {i.notifications.map((n) => (
                            <li key={n.id}>
                              <span className="text-gray-500">{formatDateTime(n.at)}</span> {n.channel === "EMAIL" ? "이메일" : "카카오톡"} → {n.recipient.startsWith("user:") ? (userNames.get(n.recipient.slice(5)) ?? n.recipient) : n.recipient}{" "}
                              <span className={n.status === "SENT" ? "text-emerald-700 font-medium" : n.status === "MOCK_SENT" ? "text-sky-700" : n.status === "SUPPRESSED" ? "text-gray-500" : "text-red-700"}>
                                {n.status === "SENT" ? "발송" : n.status === "MOCK_SENT" ? "모의 발송" : n.status === "SUPPRESSED" ? "억제" : "실패"}
                              </span>{" "}
                              <span className="text-gray-500">— {n.reason}</span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                  <div className="no-print">
                    {dismissedView ? (
                      canAdmin(user) ? <RestoreIncidentButton incidentId={i.id} /> : <span className="text-xs text-gray-400">복원은 본사 관리자</span>
                    ) : handler ? (
                      <IncidentActions incidentId={i.id} status={i.status} assignees={assignees} revertLabel={i.revertLabel} />
                    ) : (
                      <span className="text-xs text-gray-400">조회 전용</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
