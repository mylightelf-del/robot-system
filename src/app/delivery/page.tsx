import { getCurrentUser } from "@/lib/auth/session";
import { getDeliveryView } from "@/lib/services/delivery";
import { AppError } from "@/lib/util/errors";
import { AccessDenied } from "@/components/AccessDenied";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Card, Empty, Notice, PageTitle, Stat } from "@/components/ui";
import { DeliverySyncButton, RecipientsEditor, RobotSiteSelect } from "@/components/DeliveryPanels";
import { formatDateTime, formatDurationMin, formatTime, nowIso, relativeFromNow } from "@/lib/util/time";

const STATUS_KO: Record<string, string> = { Await: "대기", OnTheWay: "이동 중", Arrived: "도착", Complete: "완료", Cancel: "취소" };
const STATUS_TONE: Record<string, string> = { Await: "bg-gray-100 text-gray-700", OnTheWay: "bg-blue-50 text-blue-700", Arrived: "bg-amber-50 text-amber-800", Complete: "bg-emerald-50 text-emerald-700", Cancel: "bg-gray-100 text-gray-500" };
const MOVE_KO: Record<string, string> = { Idle: "출발지 대기", Moving: "이동 중", Approaching: "접근 중", Arrive: "도착", Stuck: "장애물", Pause: "일시정지", Avoid: "로봇 회피", Error: "이상" };
const COMPLETE_KO: Record<string, string> = { TIMEOUT: "시간 초과", MENUAL: "로봇 화면", MANUAL: "로봇 화면", REMOTE: "원격", QRCODE: "QR", TRAY_EMPTY: "빈 트레이 감지" };

/** 배송 — 배송로봇 상태·배송 기록·도착 알림 수신자(docs/23). 청소 화면과 분리. */
export default async function DeliveryPage({ searchParams }: { searchParams: Promise<{ site?: string }> }) {
  const user = await getCurrentUser();
  const sp = await searchParams;
  let v;
  try {
    v = await getDeliveryView(user, { siteId: sp.site || undefined });
  } catch (e) {
    return <AccessDenied reason={e instanceof AppError ? e.message : "접근할 수 없습니다."} />;
  }
  const now = nowIso();
  const siteName = (id: string | null) => (id ? (v.sites.find((s) => s.id === id)?.name ?? id) : "(미지정)");
  const robotName = (id: string) => v.robots.find((r) => r.id === id)?.name ?? id;
  const today = v.legs.filter((l) => now.slice(0, 10) === l.firstSeenAt.slice(0, 10));
  const arrivedOpen = v.legs.filter((l) => l.arrivedAt && !l.completedAt && !l.cancelledAt);
  const waits = v.legs.filter((l) => l.arrivedAt && l.completedAt).map((l) => (new Date(l.completedAt!).getTime() - new Date(l.arrivedAt!).getTime()) / 60000);
  const avgWait = waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : null;
  const destinationsBySite: Record<string, string[]> = {};
  for (const r of v.robots) if (r.siteId) destinationsBySite[r.siteId] = Array.from(new Set([...(destinationsBySite[r.siteId] ?? []), ...r.destinations.map((d) => d.name)]));

  return (
    <>
      <AutoRefresh seconds={20} />
      <PageTitle title="배송" subtitle="배송로봇 상태 · 배송 기록 · 도착 알림(조회 전용 — 배송 지시는 로봇 화면에서)" right={v.admin ? <DeliverySyncButton /> : null} />
      {v.mode === "unconfigured" && <div className="mb-3"><Notice tone="warn">배송로봇 에이전트 연동이 꺼져 있습니다(PUDU_AGENT_MODE). 기록은 볼 수 있지만 새 도착 알림은 오지 않습니다.</Notice></div>}
      {v.mode === "mock" && <div className="mb-3"><Notice>모의(mock) 모드 — 에이전트 없이 시험 데이터로 동작합니다. 알림은 채널 설정에 따라 모의 발송될 수 있습니다.</Notice></div>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Stat label="배송로봇" value={`${v.robots.length}대`} />
        <Stat label="오늘 배송 구간" value={`${today.length}건`} />
        <Stat label="도착 후 미수령" value={`${arrivedOpen.length}건`} tone={arrivedOpen.length ? "warn" : "default"} />
        <Stat label="평균 수령 대기(7일)" value={avgWait === null ? "없음" : formatDurationMin(Math.round(avgWait))} />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <Card title="배송로봇" className="lg:col-span-1">
          {v.robots.length === 0 ? (
            <Empty>등록된 배송로봇이 없습니다. 에이전트 연결 후 자동으로 나타납니다.</Empty>
          ) : (
            <ul className="divide-y text-sm">
              {v.robots.map((r) => {
                const s = (r.lastState ?? {}) as { robotState?: string; moveState?: string; robotPower?: number; chargeStage?: string };
                const stale = !r.lastSeenAt || new Date(now).getTime() - new Date(r.lastSeenAt).getTime() > 5 * 60_000;
                return (
                  <li key={r.id} className="py-2">
                    <div className="flex items-center gap-2">
                      <b>{r.name}</b>
                      <span className={`text-xs rounded-full px-2 ${stale ? "bg-gray-100 text-gray-500" : s.robotState === "BUSY" ? "bg-blue-50 text-blue-700" : "bg-emerald-50 text-emerald-700"}`}>{stale ? "미수신" : s.robotState === "BUSY" ? "배송 중" : "대기"}</span>
                      {typeof s.robotPower === "number" && <span className="text-xs text-gray-600">배터리 {s.robotPower}%</span>}
                    </div>
                    <div className="text-xs text-gray-500">
                      {s.moveState ? `${MOVE_KO[s.moveState] ?? s.moveState} · ` : ""}마지막 수신 {r.lastSeenAt ? relativeFromNow(r.lastSeenAt, now) : "없음"} · 매장 {r.shopName || "-"}
                    </div>
                    <div className="text-xs mt-1">사업장: {v.admin ? <RobotSiteSelect robotId={r.id} siteId={r.siteId} sites={v.sites.map((s) => ({ id: s.id, name: s.name }))} /> : siteName(r.siteId)}</div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="배송 기록 (최근 7일)" className="lg:col-span-2 min-w-0">
          {v.legs.length === 0 ? (
            <Empty>배송 기록이 없습니다.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="data">
                <thead><tr><th>시작</th><th>로봇</th><th>목적지</th><th>상태</th><th>도착</th><th>완료</th><th>수령 대기</th><th>알림</th></tr></thead>
                <tbody>
                  {v.legs.map((l) => {
                    const wait = l.arrivedAt ? ((l.completedAt ? new Date(l.completedAt) : new Date(now)).getTime() - new Date(l.arrivedAt).getTime()) / 60000 : null;
                    return (
                      <tr key={l.id}>
                        <td className="whitespace-nowrap">{formatDateTime(l.firstSeenAt)}</td>
                        <td>{robotName(l.robotId)}</td>
                        <td><b>{l.destination}</b><div className="text-[11px] text-gray-500">트레이 {l.trayIndex + 1}{l.source === "manual" ? " · 로봇 화면" : l.source === "remote" ? " · 원격" : ""}</div></td>
                        <td><span className={`whitespace-nowrap text-xs rounded-full px-2 py-0.5 ${STATUS_TONE[l.status] ?? ""}`}>{STATUS_KO[l.status] ?? l.status}</span></td>
                        <td className="whitespace-nowrap">{l.arrivedAt ? formatTime(l.arrivedAt) : "-"}</td>
                        <td className="whitespace-nowrap">{l.completedAt ? `${formatTime(l.completedAt)}${l.completeType ? ` (${COMPLETE_KO[l.completeType] ?? l.completeType})` : ""}` : l.cancelledAt ? `취소 ${formatTime(l.cancelledAt)}` : "-"}</td>
                        <td className={wait !== null && !l.completedAt && !l.cancelledAt ? "text-amber-700" : ""}>{wait === null ? "-" : formatDurationMin(Math.max(0, Math.round(wait)))}</td>
                        <td className="text-xs max-w-[260px]">{l.notifiedAt ? <span title={l.notifyResult ?? ""}>{formatTime(l.notifiedAt)} · {l.notifyResult}</span> : <span className="text-gray-400">{l.arrivedAt ? (l.notifyResult ?? "보내지 않음") : "도착 전"}</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-gray-500 mt-2">로봇이 목적지에 도착하면 그 목적지의 수신자에게 바로 알리고, {v.remindMinutes ? `${v.remindMinutes}분 안에 로봇 화면에서 확인(완료)이 없으면 한 번 더 알립니다.` : "재알림은 꺼져 있습니다."}</p>
        </Card>
      </div>

      {v.admin ? (
        <Card title="도착 알림 수신자 (목적지별)" className="mt-4">
          {v.sites.length === 0 ? (
            <Empty>사업장이 없습니다.</Empty>
          ) : (
            <RecipientsEditor sites={v.sites.map((s) => ({ id: s.id, name: s.name }))} users={v.users} rows={v.recipients.map((r) => ({ id: r.id, siteId: r.siteId, destination: r.destination, userIds: r.userIds, channels: r.channels, enabled: r.enabled }))} destinationsBySite={destinationsBySite} />
          )}
          <p className="text-xs text-gray-500 mt-2">앱 푸시는 Wide Bot 앱에 로그인한 직원만, 카카오톡은 내 계정에서 카카오를 연결한 직원만 받습니다. 메일은 계정 메일 주소로 갑니다.</p>
        </Card>
      ) : null}
    </>
  );
}
