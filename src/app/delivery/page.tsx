import { getCurrentUser } from "@/lib/auth/session";
import { getDeliveryHealth, getDeliveryStats, getDeliveryView, listDeliveryPresets } from "@/lib/services/delivery";
import { AppError } from "@/lib/util/errors";
import { AccessDenied } from "@/components/AccessDenied";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Card, Empty, Notice, PageTitle, Stat } from "@/components/ui";
import { DeliverySyncButton, DispatchPanel, RecipientsEditor, RobotSiteSelect } from "@/components/DeliveryPanels";
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
  const health = await getDeliveryHealth(user);
  const stats = await getDeliveryStats(user, { siteId: sp.site || undefined, days: 30 });
  const presets = await listDeliveryPresets(user, v.sites.map((s) => s.id));
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
      <PageTitle title="배송" subtitle="배송로봇 상태 · 배송 보내기 · 배송 기록 · 도착 알림" right={v.admin ? <DeliverySyncButton /> : null} />
      {v.mode === "unconfigured" && <div className="mb-3"><Notice tone="warn">배송로봇 에이전트 연동이 꺼져 있습니다(PUDU_AGENT_MODE). 기록은 볼 수 있지만 새 도착 알림은 오지 않습니다.</Notice></div>}
      {v.mode === "mock" && <div className="mb-3"><Notice>모의(mock) 모드 — 에이전트 없이 시험 데이터로 동작합니다. 알림은 채널 설정에 따라 모의 발송될 수 있습니다.</Notice></div>}

      {v.admin && v.mode !== "unconfigured" && (() => {
        const stepOk = (s: { lastOkAt: string | null; lastError: string | null } | null) => !!s && !!s.lastOkAt && !s.lastError;
        const steps = [
          { label: "에이전트·PUDU 클라우드", ok: stepOk(health.catalog), detail: health.catalog ? (health.catalog.lastError ?? `정상 · ${relativeFromNow(health.catalog.lastOkAt, now)}`) : "아직 실행 기록 없음" },
          { label: "로봇 응답(상태 조회)", ok: stepOk(health.state), detail: health.state ? (health.state.lastError ? `${health.state.lastError}${health.state.lastOkAt ? ` · 마지막 성공 ${relativeFromNow(health.state.lastOkAt, now)}` : " · 한 번도 성공 못 함"}` : `정상 · ${relativeFromNow(health.state.lastOkAt, now)}`) : "아직 실행 기록 없음" },
          { label: "알림 수신(에이전트 → Wide Bot)", ok: health.eventsTotal > 0, detail: health.lastEventAt ? `마지막 ${relativeFromNow(health.lastEventAt, now)} · 24시간 ${health.events24h}건 · 누적 ${health.eventsTotal}건` : "아직 받은 알림 없음(배송·이동이 있어야 옴)" },
        ];
        const allOk = steps.every((x) => x.ok);
        return (
          <Card title="연결 상태" className="mb-4" right={<span className={`text-xs rounded-full px-2 py-0.5 ${allOk ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>{allOk ? "정상" : "확인 필요"}</span>}>
            <ol className="space-y-1 text-sm">
              {steps.map((x, i) => (
                <li key={x.label} className="flex gap-2">
                  <span className={x.ok ? "text-emerald-600" : "text-amber-600"}>{x.ok ? "●" : "○"}</span>
                  <span className="min-w-0"><b>{i + 1}. {x.label}</b> <span className="text-xs text-gray-600 break-all">{x.detail}</span></span>
                </li>
              ))}
            </ol>
            {!steps[1].ok && <p className="text-xs text-gray-500 mt-2">「로봇 응답」이 실패하면(10004 timeout) 로봇 전원·네트워크를 먼저 확인하고, 그래도 같으면 대리점에 장치의 API 권한을 확인합니다. 반복 확인은 1분마다 자동으로 합니다.</p>}
          </Card>
        );
      })()}

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
                    const wait = l.arrivedAt ? ((l.completedAt ? new Date(l.completedAt) : l.cancelledAt ? new Date(l.cancelledAt) : new Date(now)).getTime() - new Date(l.arrivedAt).getTime()) / 60000 : null;
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
          <p className="text-xs text-gray-500 mt-2">도착하면 수신자(지시할 때 고른 사람 → 목적지 수신자 → 기본 수신자)에게 바로 알리고, {v.remindMinutes ? `${v.remindMinutes}분 안에 로봇 화면에서 확인(완료)이 없으면 한 번 더 알립니다(수령 알림만 재알림).` : "재알림은 꺼져 있습니다."} 배송이 취소되면 그 수신자에게, 로봇이 {v.stuckMinutes}분 넘게 막히거나 운행 오류로 멈추면 기본 수신자(*)에게 알립니다.</p>
        </Card>
      </div>

      <div className="grid lg:grid-cols-3 gap-4 mt-4">
        <Card title="배송 보내기 · 호출" className="lg:col-span-2">
          <DispatchPanel presets={presets.map((p) => ({ id: p.id, siteId: p.siteId, name: p.name, trays: p.trays, sort: p.sort, executeTask: p.executeTask }))} robots={v.dispatchable.map((r) => ({ id: r.id, name: r.name, siteId: r.siteId!, destinations: r.destinations.map((d) => d.name), busy: (r.lastState as { robotState?: string } | null)?.robotState === "BUSY" }))} users={v.users.map((u) => ({ id: u.id, name: u.name }))} />
          {v.robots.some((r) => r.siteId && !v.dispatchable.some((x) => x.id === r.id)) && <p className="text-xs text-amber-700 mt-2">사업장의 원격 제어가 꺼져 있으면 지시할 수 없습니다(관리 설정 → 원격 제어).</p>}
        </Card>
        <Card title="최근 지시">
          {v.orders.length === 0 ? (
            <Empty>보낸 지시가 없습니다.</Empty>
          ) : (
            <ul className="divide-y text-xs">
              {v.orders.map((o) => (
                <li key={o.id} className="py-1.5">
                  <div className="flex items-center gap-1">
                    <span className="text-gray-500">{formatDateTime(o.requestedAt)}</span>
                    <b>{o.kind === "DELIVERY" ? "배송" : o.kind === "CALL" ? "호출" : "호출 취소"}</b>
                    <span className={o.status === "ACCEPTED" ? "text-emerald-700" : "text-red-700"}>{o.status === "ACCEPTED" ? "접수" : "실패"}</span>
                  </div>
                  <div>{robotName(o.robotId)} · {o.trays.map((t) => t.destination).join(" → ")}{o.kind === "DELIVERY" && !o.executeTask ? " · 출발은 현장에서" : ""}</div>
                  {o.status === "FAILED" && <div className="text-red-700">{o.message}</div>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title={`배송 통계 (최근 ${stats.days}일)`} className="mt-4">
        {stats.total === 0 ? (
          <Empty>통계를 낼 배송 기록이 없습니다.</Empty>
        ) : (
          <div className="grid lg:grid-cols-3 gap-4 text-sm">
            <div className="space-y-1">
              <div>배송 구간 <b>{stats.total}</b>건 · 완료 {stats.completed} · 취소 {stats.cancelled}</div>
              <div>평균 이동 시간 <b>{stats.avgTravelMin === null ? "없음" : `${stats.avgTravelMin}분`}</b> · 평균 수령 대기 <b>{stats.avgWaitMin === null ? "없음" : `${stats.avgWaitMin}분`}</b></div>
              <div className="text-xs text-gray-600">완료 방식: {Object.entries(stats.completeTypes).map(([k, n]) => `${COMPLETE_KO[k] ?? k} ${n}`).join(" · ") || "없음"}</div>
              <div className="mt-2 text-xs font-medium">시간대별</div>
              <div className="flex items-end gap-px h-16">
                {stats.hourly.map((n, h) => {
                  const max = Math.max(1, ...stats.hourly);
                  return <div key={h} title={`${h}시 ${n}건`} className="flex-1 bg-blue-400/80 rounded-t" style={{ height: `${(n / max) * 100}%`, minHeight: n ? 2 : 0 }} />;
                })}
              </div>
              <div className="flex justify-between text-[10px] text-gray-500"><span>0시</span><span>12시</span><span>23시</span></div>
            </div>
            <div>
              <div className="text-xs font-medium mb-1">일별</div>
              <div className="flex items-end gap-px h-24">
                {stats.daily.map((d) => {
                  const max = Math.max(1, ...stats.daily.map((x) => x.count));
                  return <div key={d.date} title={`${d.date} ${d.count}건`} className="flex-1 bg-emerald-400/80 rounded-t" style={{ height: `${(d.count / max) * 100}%`, minHeight: d.count ? 2 : 0 }} />;
                })}
              </div>
              <div className="flex justify-between text-[10px] text-gray-500"><span>{stats.daily[0]?.date.slice(5)}</span><span>{stats.daily[stats.daily.length - 1]?.date.slice(5)}</span></div>
            </div>
            <div className="overflow-x-auto">
              <table className="data">
                <thead><tr><th>목적지</th><th className="text-right">건</th><th className="text-right">이동</th><th className="text-right">수령 대기</th><th className="text-right">취소</th></tr></thead>
                <tbody>
                  {stats.destinations.slice(0, 15).map((d) => (
                    <tr key={d.destination}><td>{d.destination}</td><td className="text-right">{d.count}</td><td className="text-right">{d.avgTravelMin === null ? "-" : `${d.avgTravelMin}분`}</td><td className="text-right">{d.avgWaitMin === null ? "-" : `${d.avgWaitMin}분`}</td><td className="text-right">{d.cancels || "-"}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Card>

      {v.admin ? (
        <Card title="도착 알림 수신자 (목적지별)" className="mt-4">
          {v.sites.length === 0 ? (
            <Empty>사업장이 없습니다.</Empty>
          ) : (
            <RecipientsEditor sites={v.sites.map((s) => ({ id: s.id, name: s.name }))} users={v.users} rows={v.recipients.map((r) => ({ id: r.id, siteId: r.siteId, destination: r.destination, userIds: r.userIds, channels: r.channels, enabled: r.enabled }))} destinationsBySite={destinationsBySite} />
          )}
          <p className="text-xs text-gray-500 mt-2">「* 기본 수신자」는 목적지 설정이 없는 배송과 로봇 막힘·오류 알림을 받습니다. 앱 푸시는 Wide Bot 앱에 로그인한 직원만, 카카오톡은 내 계정에서 카카오를 연결한 직원만 받습니다. 메일은 계정 메일 주소로 갑니다.</p>
        </Card>
      ) : null}
    </>
  );
}
