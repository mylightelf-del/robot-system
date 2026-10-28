import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/session";
import { listRobots, listSites } from "@/lib/services/robots";
import { AppError } from "@/lib/util/errors";
import { Card, Empty, PageTitle } from "@/components/ui";
import { AccessDenied } from "@/components/AccessDenied";
import { Battery, StatusBadge } from "@/components/StatusBadge";
import { formatDateTime, nowIso, relativeFromNow } from "@/lib/util/time";
import { VENDOR_LABEL } from "@/lib/domain/commands";
import { SiteFilter } from "@/components/SiteFilter";

export default async function RobotsPage({ searchParams }: { searchParams: Promise<{ site?: string }> }) {
  const { site } = await searchParams;
  const user = await getCurrentUser();
  let rows;
  let sites;
  try {
    sites = await listSites(user);
    rows = await listRobots(user, site || undefined);
  } catch (e) {
    return <AccessDenied reason={e instanceof AppError ? e.message : "접근할 수 없습니다."} />;
  }
  const now = nowIso();
  return (
    <>
      <PageTitle title="로봇 목록" subtitle={`${rows.length}대`} right={<SiteFilter sites={sites} current={site ?? ""} basePath="/robots" />} />
      <Card>
        {rows.length === 0 ? (
          <Empty>표시할 로봇이 없습니다.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>관리번호</th>
                  <th>이름</th>
                  <th>제조사·모델</th>
                  <th>사업장 / 층</th>
                  <th>상태</th>
                  <th>배터리</th>
                  <th>진행</th>
                  <th>마지막 수신</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.robot.id}>
                    <td className="font-mono text-xs">{r.robot.id}</td>
                    <td>
                      <Link href={`/robots/${r.robot.id}`} className="text-navy font-medium hover:underline">
                        {r.robot.name}
                      </Link>
                    </td>
                    <td>
                      {VENDOR_LABEL[r.robot.vendor]} {r.robot.model}
                    </td>
                    <td>
                      <Link href={`/sites/${r.site.id}?floor=${r.floor.id}`} className="hover:underline">
                        {r.site.name} / {r.floor.name}
                      </Link>
                    </td>
                    <td>
                      <StatusBadge status={r.status.common} />
                    </td>
                    <td>
                      <Battery pct={r.status.batteryPct} />
                    </td>
                    <td>{r.status.progressPct === null ? <span className="text-gray-400">-</span> : `${Math.round(r.status.progressPct)}%`}</td>
                    <td className={r.status.lastReceivedAt ? "" : "text-purple-700"} title={formatDateTime(r.status.lastReceivedAt, r.site.timezone)}>
                      {relativeFromNow(r.status.lastReceivedAt, now)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
