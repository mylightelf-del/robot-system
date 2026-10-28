import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/session";
import { getDashboard, STATUS_KEYS } from "@/lib/services/dashboard";
import { listIncidents } from "@/lib/services/incidents";
import { listRobots } from "@/lib/services/robots";
import { STATUS_LABEL, STATUS_STYLE } from "@/lib/domain/status";
import { Card, Empty, PageTitle, Stat } from "@/components/ui";
import { IncidentStatusBadge, SeverityBadge, StatusBadge } from "@/components/StatusBadge";
import { formatDateTime, relativeFromNow } from "@/lib/util/time";
import { AccessDenied } from "@/components/AccessDenied";
import { AutoRefresh } from "@/components/AutoRefresh";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user.active) return <AccessDenied reason="비활성화된 사용자입니다. 접근이 차단되었습니다." />;
  const dash = await getDashboard(user);
  const incidents = (await listIncidents(user)).slice(0, 8);
  const stale = (await listRobots(user)).filter((r) => r.status.common === "OFFLINE" || r.status.common === "UNKNOWN");
  const t = dash.totals;

  return (
    <>
      <AutoRefresh seconds={10} />
      <PageTitle title="종합 대시보드" subtitle={`접근 가능 사업장 ${dash.sites.length}곳 · 기준 시각 ${formatDateTime(dash.now)}`} />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
        <Stat label="로봇 대수" value={t.robotCount} />
        <Stat label="청소 중" value={t.byStatus.CLEANING} tone="good" />
        <Stat label="충전·대기" value={t.byStatus.CHARGING + t.byStatus.IDLE} hint={`충전 ${t.byStatus.CHARGING} · 대기 ${t.byStatus.IDLE}`} />
        <Stat label="오류" value={t.byStatus.ERROR} tone={t.byStatus.ERROR ? "bad" : "default"} />
        <Stat label="통신 끊김·불명" value={t.byStatus.OFFLINE + t.byStatus.UNKNOWN} tone={t.byStatus.OFFLINE + t.byStatus.UNKNOWN ? "warn" : "default"} hint={`마지막 수신 ${dash.staleThresholdMinutes}분 초과 ${t.staleRobots}대`} />
        <Stat label="미조치 장애" value={t.openIncidents} tone={t.unacknowledgedIncidents ? "bad" : t.openIncidents ? "warn" : "default"} hint={`미확인 ${t.unacknowledgedIncidents}건`} />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <Card title="사업장별 현황" className="lg:col-span-2">
          {dash.sites.length === 0 ? (
            <Empty>접근 가능한 사업장이 없습니다.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="data min-w-[640px]">
                <thead>
                  <tr>
                    <th>사업장</th>
                    <th>대수</th>
                    <th>상태</th>
                    <th>당일 실적</th>
                    <th>미조치 장애</th>
                  </tr>
                </thead>
                <tbody>
                  {dash.sites.map((s) => (
                    <tr key={s.siteId}>
                      <td>
                        <Link href={`/sites/${s.siteId}`} className="text-navy font-medium hover:underline">
                          {s.siteName}
                        </Link>
                      </td>
                      <td>{s.robotCount}</td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          {STATUS_KEYS.filter((k) => s.byStatus[k] > 0).map((k) => (
                            <span key={k} className={`rounded px-1.5 py-0.5 text-xs border ${STATUS_STYLE[k].cls}`}>
                              {STATUS_STYLE[k].icon} {STATUS_LABEL[k]} {s.byStatus[k]}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="whitespace-nowrap">
                        {s.todayRuns}건 · {s.todayAreaM2.toLocaleString()}㎡
                        <div className="text-xs text-gray-500">정상 완료 {s.todayCompleted}건</div>
                      </td>
                      <td>
                        {s.openIncidents ? (
                          <span className={s.unacknowledgedIncidents ? "text-red-700 font-semibold" : "text-amber-700"}>
                            {s.openIncidents}건{s.unacknowledgedIncidents ? ` (미확인 ${s.unacknowledgedIncidents})` : ""}
                          </span>
                        ) : (
                          <span className="text-gray-400">없음</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card title="미조치 장애" right={<Link href="/incidents" className="text-xs text-navy hover:underline">전체 보기</Link>}>
            {incidents.length === 0 ? (
              <Empty>미조치 장애가 없습니다.</Empty>
            ) : (
              <ul className="divide-y text-sm">
                {incidents.map((i) => (
                  <li key={i.id} className="py-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <SeverityBadge severity={i.severity} />
                      <IncidentStatusBadge status={i.status} />
                      <span className="text-xs text-gray-500">{relativeFromNow(i.occurredAt, dash.now)}</span>
                    </div>
                    <div className="mt-0.5">
                      <Link href={`/robots/${i.robotId}`} className="font-medium text-navy hover:underline">
                        {i.robotName}
                      </Link>{" "}
                      <span className="text-gray-500 text-xs">{i.siteName}</span>
                    </div>
                    <div className="text-gray-700">{i.message}</div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="통신 끊김 · 상태 불명">
            {stale.length === 0 ? (
              <Empty>해당 로봇이 없습니다.</Empty>
            ) : (
              <ul className="divide-y text-sm">
                {stale.map((r) => (
                  <li key={r.robot.id} className="py-2 flex items-center justify-between gap-2">
                    <div>
                      <Link href={`/robots/${r.robot.id}`} className="font-medium text-navy hover:underline">
                        {r.robot.name}
                      </Link>
                      <div className="text-xs text-gray-500">
                        {r.site.name} · 마지막 수신 {relativeFromNow(r.status.lastReceivedAt, dash.now)}
                      </div>
                    </div>
                    <StatusBadge status={r.status.common} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
