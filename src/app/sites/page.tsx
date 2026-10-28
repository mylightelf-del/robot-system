import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/session";
import { getDashboard, STATUS_KEYS } from "@/lib/services/dashboard";
import { STATUS_LABEL, STATUS_STYLE } from "@/lib/domain/status";
import { Card, Empty, PageTitle } from "@/components/ui";
import { AccessDenied } from "@/components/AccessDenied";

export default async function SitesPage() {
  const user = await getCurrentUser();
  if (!user.active) return <AccessDenied reason="비활성화된 사용자입니다." />;
  const dash = await getDashboard(user);
  return (
    <>
      <PageTitle title="사업장 관제" subtitle="사업장을 선택하면 층별 지도와 로봇 위치를 볼 수 있습니다." />
      {dash.sites.length === 0 ? (
        <Empty>접근 가능한 사업장이 없습니다.</Empty>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {dash.sites.map((s) => (
            <Link key={s.siteId} href={`/sites/${s.siteId}`} className="block">
              <Card className="h-full hover:border-navy transition-colors">
                <div className="font-semibold text-navy">{s.siteName}</div>
                <div className="text-sm text-gray-600 mt-1">로봇 {s.robotCount}대 · 당일 {s.todayRuns}건 · 미조치 장애 {s.openIncidents}건</div>
                <div className="flex flex-wrap gap-1 mt-2">
                  {STATUS_KEYS.filter((k) => s.byStatus[k] > 0).map((k) => (
                    <span key={k} className={`rounded px-1.5 py-0.5 text-xs border ${STATUS_STYLE[k].cls}`}>
                      {STATUS_STYLE[k].icon} {STATUS_LABEL[k]} {s.byStatus[k]}
                    </span>
                  ))}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
