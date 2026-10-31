import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/session";
import { getAdminData, getVendorStatus } from "@/lib/services/admin";
import { PuduPanel } from "@/components/VendorPanel";
import { NewSiteForm, SiteCard } from "@/components/SitePanels";
import { AppError } from "@/lib/util/errors";
import { Card, KV, PageTitle } from "@/components/ui";
import { AccessDenied } from "@/components/AccessDenied";
import { RelocateForm } from "@/components/AdminPanels";
import { AdvancedGate } from "@/components/AdvancedGate";
import { VENDOR_LABEL } from "@/lib/domain/commands";
import { formatDateTime } from "@/lib/util/time";

/** 고급 설정(본사 관리자): 사업장·층·구역·로봇 배치, 지도 가져오기, 제조사 연결. 잠금(이해 확인) 뒤에만 바꿀 수 있다. */
export default async function AdvancedAdminPage() {
  const user = await getCurrentUser();
  let d;
  try {
    d = await getAdminData(user);
  } catch (e) {
    return <AccessDenied reason={e instanceof AppError ? e.message : "접근할 수 없습니다."} />;
  }
  const vendor = await getVendorStatus(user);
  const floors = d.floors.map((f) => ({ id: f.id, siteId: f.siteId, name: f.name, siteName: d.sites.find((s) => s.id === f.siteId)?.name ?? f.siteId }));

  return (
    <>
      <PageTitle title="고급 설정" subtitle="사업장·층·구역·로봇 배치 · 지도 가져오기 · 제조사 연결(PUDU)" right={<Link href="/admin" className="text-sm underline">관리 설정으로</Link>} />
      <AdvancedGate>
        <div className="space-y-4">
        <Card title="사업장 · 층 · 구역 · 로봇 배치">
          <div className="mb-3"><NewSiteForm /></div>
          <div className="grid md:grid-cols-2 gap-4">
            {d.sites.map((s) => (
              <SiteCard
                key={s.id}
                site={{
                  id: s.id,
                  name: s.name,
                  address: s.address,
                  timezone: s.timezone,
                  isSample: s.isSample,
                  installedOn: s.installedOn ?? null,
                  hasPuduRobot: d.robots.some((r) => r.siteId === s.id && r.vendor === "PUDU" && r.vendorMeta?.source === "api"),
                  floors: d.floors
                    .filter((f) => f.siteId === s.id)
                    .map((f) => {
                      const mv = d.mapVersions.find((m) => m.id === f.currentMapVersionId);
                      return {
                        id: f.id,
                        name: f.name,
                        map: mv ? { id: mv.id, version: mv.version, vendor: mv.vendor ?? null, vendorMapName: mv.vendorMapName ?? null, imageUrl: mv.imageUrl ?? null, widthPx: mv.widthPx, heightPx: mv.heightPx, hasCorners: !!mv.corners } : null,
                        zones: d.zones.filter((z) => z.floorId === f.id).length,
                        robots: d.robots.filter((r) => r.floorId === f.id).map((r) => `${r.name}[${VENDOR_LABEL[r.vendor]} ${r.model}]`),
                      };
                    }),
                }}
              />
            ))}
          </div>
          <p className="text-xs text-gray-500 mt-2">사업장·층은 여기서 만들고, PUDU 로봇을 배치한 층은 『PUDU 지도 가져오기』로 실제 지도(이미지·구역)를 연결합니다. 로봇·층·실적이 있는 항목은 삭제할 수 없습니다(이력 보존).</p>
          <div className="mt-3 border-t pt-3">
            <div className="text-sm font-medium mb-1">로봇 배치 변경(이 시스템의 사업장·층)</div>
            <RelocateForm robots={d.robots.map((r) => ({ id: r.id, name: r.name, siteId: r.siteId }))} floors={floors} />
          </div>
        </Card>

        <Card title="제조사 연결 — PUDU Cloud API">
          <PuduPanel live={vendor.modes.PUDU === "live"} keyConfigured={vendor.pudu.keyConfigured} cluster={vendor.pudu.cluster} clusterLabel={vendor.pudu.clusterLabel} callbackUrl={vendor.pudu.callbackUrl} callbackConfigured={vendor.pudu.callbackConfigured} callbackPublic={vendor.pudu.callbackPublic} lastCallbackAt={vendor.pudu.lastCallbackAt} callbacksLast24h={vendor.pudu.callbacksLast24h} shopIds={vendor.pudu.shopIds} floors={floors} />
          <div className="mt-3 grid md:grid-cols-2 gap-3 text-xs">
            <div className="border rounded p-2">
              <div className="font-medium mb-1">동기화 상태</div>
              {vendor.sync.length === 0 ? <div className="text-gray-500">아직 실행 기록 없음</div> : (
                <table className="data">
                  <thead><tr><th>작업</th><th>마지막 실행</th><th>마지막 성공</th><th>결과</th></tr></thead>
                  <tbody>{vendor.sync.map((s) => <tr key={s.id}><td>{s.id}</td><td>{formatDateTime(s.lastRunAt)}</td><td>{formatDateTime(s.lastOkAt)}</td><td className={s.lastError ? "text-red-700" : "text-emerald-700"}>{s.lastError ?? JSON.stringify(s.stats)}</td></tr>)}</tbody>
                </table>
              )}
            </div>
            <div className="border rounded p-2">
              <div className="font-medium mb-1">최근 콜백 이벤트 (미처리 {vendor.pendingEvents}건)</div>
              {vendor.recentEvents.length === 0 ? <div className="text-gray-500">수신 기록 없음</div> : (
                <ul className="space-y-0.5">{vendor.recentEvents.map((e) => <li key={e.id}><span className="text-gray-500">{formatDateTime(e.receivedAt)}</span> {e.eventType} {e.vendorRobotId ?? ""} {e.processedAt ? (e.processError ? <span className="text-red-700">오류: {e.processError}</span> : <span className="text-emerald-700">처리됨</span>) : <span className="text-amber-700">대기</span>}</li>)}</ul>
              )}
            </div>
          </div>
        </Card>

        <Card title="제조사 연결 목록">
          <div className="grid md:grid-cols-2 gap-3">
            {d.vendorConnections.map((v) => (
              <div key={v.id} className="border rounded p-3 text-sm">
                <KV
                  items={[
                    { k: "연결", v: <>{v.label} <span className={`text-xs rounded px-1 ${v.status === "SAMPLE" ? "bg-amber-50 text-amber-800" : "bg-gray-100 text-gray-600"}`}>{v.status === "SAMPLE" ? "샘플" : "미설정"}</span></> },
                    { k: "제조사", v: VENDOR_LABEL[v.vendor] },
                    { k: "지역", v: v.region ?? "-" },
                    { k: "키", v: <span className="text-gray-500">서버 비밀 설정(환경변수)에서만 관리 · 화면 입력 없음</span> },
                    { k: "비고", v: v.notes },
                  ]}
                />
              </div>
            ))}
          </div>
        </Card>

        </div>
      </AdvancedGate>
    </>
  );
}
