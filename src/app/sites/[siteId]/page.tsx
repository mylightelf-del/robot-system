import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/session";
import { getSiteView } from "@/lib/services/robots";
import { listIncidents } from "@/lib/services/incidents";
import { AppError } from "@/lib/util/errors";
import { Card, Empty, Notice, PageTitle } from "@/components/ui";
import { AccessDenied } from "@/components/AccessDenied";
import { FloorMap } from "@/components/FloorMap";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Battery, IncidentStatusBadge, SeverityBadge, StatusBadge } from "@/components/StatusBadge";
import { formatDateTime, relativeFromNow } from "@/lib/util/time";
import { MODEL_LABEL, VENDOR_LABEL } from "@/lib/domain/commands";

export default async function SitePage({ params, searchParams }: { params: Promise<{ siteId: string }>; searchParams: Promise<{ floor?: string }> }) {
  const { siteId } = await params;
  const { floor } = await searchParams;
  const user = await getCurrentUser();
  let view;
  try {
    view = await getSiteView(user, siteId, floor);
  } catch (e) {
    return <AccessDenied reason={e instanceof AppError ? e.message : "접근할 수 없습니다."} />;
  }
  const incidents = (await listIncidents(user, { siteId })).slice(0, 5);
  const tz = view.site.timezone;

  return (
    <>
      <AutoRefresh seconds={5} />
      <PageTitle
        title={view.site.name}
        subtitle={`${view.site.address} · 시간대 ${tz} · 기준 ${formatDateTime(view.now, tz)}`}
        right={
          <div className="flex gap-1">
            {view.floors.map((f) => (
              <Link
                key={f.id}
                href={`/sites/${siteId}?floor=${f.id}`}
                className={`px-3 py-1 rounded text-sm border ${f.id === view.selectedFloor.id ? "bg-navy text-white border-navy" : "bg-white border-gray-300 text-gray-700"}`}
              >
                {f.name}
              </Link>
            ))}
          </div>
        }
      />

      {!view.map.corners && (
        <div className="mb-3">
          <Notice tone="warn">이 층의 현재 지도(v{view.map.version})는 모서리 좌표가 없는 구형 지도입니다. 영역 지정 명령은 좌표 변환 검증 없이 전송되지 않도록 차단됩니다.</Notice>
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-4">
        <Card title={`${view.selectedFloor.name} 지도 (v${view.map.version})`} className="lg:col-span-2" right={<span className="text-xs text-gray-500">{view.zones.length}개 구역 · {view.robots.length}대</span>}>
          <FloorMap
            map={view.map}
            zones={view.zones}
            robots={view.robots.map((r) => ({
              id: r.robot.id,
              name: r.robot.name,
              common: r.status.common,
              pose: r.status.pose,
              poseIsLastKnown: r.status.poseIsLastKnown,
              batteryPct: r.status.batteryPct,
              progressPct: r.status.progressPct,
            }))}
          />
          {view.robots.some((r) => !r.status.pose) && (
            <p className="text-xs text-purple-700 mt-2">위치 데이터가 없는 로봇은 지도에 표시되지 않습니다(상태 불명 · 데이터 미수신).</p>
          )}
        </Card>

        <div className="space-y-4">
          <Card title="이 층의 로봇">
            {view.robots.length === 0 ? (
              <Empty>이 층에 배치된 로봇이 없습니다.</Empty>
            ) : (
              <ul className="divide-y text-sm">
                {view.robots.map((r) => (
                  <li key={r.robot.id} className="py-2">
                    <div className="flex items-center justify-between gap-2">
                      <Link href={`/robots/${r.robot.id}`} className="font-medium text-navy hover:underline">
                        {r.robot.name}
                      </Link>
                      <StatusBadge status={r.status.common} />
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {VENDOR_LABEL[r.robot.vendor]} {MODEL_LABEL[r.robot.model]} · {r.robot.id}
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs">
                      <Battery pct={r.status.batteryPct} />
                      {r.status.progressPct !== null && <span>진행 {Math.round(r.status.progressPct)}%</span>}
                      <span className={r.status.lastReceivedAt ? "text-gray-500" : "text-purple-700"}>마지막 수신 {relativeFromNow(r.status.lastReceivedAt, view.now)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="이 사업장의 미조치 장애" right={<Link href={`/incidents?site=${siteId}`} className="text-xs text-navy hover:underline">전체</Link>}>
            {incidents.length === 0 ? (
              <Empty>미조치 장애가 없습니다.</Empty>
            ) : (
              <ul className="divide-y text-sm">
                {incidents.map((i) => (
                  <li key={i.id} className="py-2">
                    <div className="flex gap-1 flex-wrap items-center">
                      <SeverityBadge severity={i.severity} />
                      <IncidentStatusBadge status={i.status} />
                      <span className="text-xs text-gray-500">{relativeFromNow(i.occurredAt, view.now)}</span>
                    </div>
                    <div className="mt-0.5">
                      <span className="font-medium">{i.robotName}</span> — {i.message}
                    </div>
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
