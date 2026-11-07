import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/session";
import { getDashboard, getTodo, LOW_CONSUMABLE_PCT, STATUS_KEYS } from "@/lib/services/dashboard";
import { listIncidents } from "@/lib/services/incidents";
import { listRobots } from "@/lib/services/robots";
import { STATUS_LABEL, STATUS_STYLE } from "@/lib/domain/status";
import { Card, Empty, PageTitle, Stat } from "@/components/ui";
import { IncidentStatusBadge, SeverityBadge, StatusBadge } from "@/components/StatusBadge";
import { formatDateTime, relativeFromNow } from "@/lib/util/time";
import { AccessDenied } from "@/components/AccessDenied";
import { AutoRefresh } from "@/components/AutoRefresh";

const fmtMin = (min: number) => (min >= 60 ? `${Math.floor(min / 60)}시간 ${Math.round(min % 60)}분` : `${Math.round(min)}분`);
/** 전주 대비 문구. */
function weekDelta(cur: number | null, prev: number | null, unit: string): string {
  if (cur === null || prev === null) return "";
  if (prev === 0) return cur === 0 ? "전주와 같음" : `전주 0${unit}`;
  const pct = Math.round(((cur - prev) / prev) * 100);
  return `전주 ${prev.toLocaleString()}${unit} (${pct >= 0 ? "+" : ""}${pct}%)`;
}

function TodoBlock({ title, count, href, tone, children }: { title: string; count: number; href: string; tone: "bad" | "warn"; children: React.ReactNode }) {
  const cls = count === 0 ? "text-slate-300" : tone === "bad" ? "text-red-600" : "text-amber-600";
  const edge = count === 0 ? "border-l-slate-200" : tone === "bad" ? "border-l-red-400" : "border-l-amber-400";
  return (
    <div className={`border border-l-4 rounded-xl p-2.5 min-w-0 bg-slate-50/60 ${edge}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{title}</span>
        <Link href={href} className={`text-lg font-bold ${cls} hover:underline`}>{count}</Link>
      </div>
      {count > 0 && <ul className="mt-1 space-y-0.5 text-xs break-words">{children}</ul>}
    </div>
  );
}

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user.active) return <AccessDenied reason="비활성화된 사용자입니다. 접근이 차단되었습니다." />;
  const dash = await getDashboard(user);
  const todo = await getTodo(user);
  const incidents = (await listIncidents(user)).slice(0, 8);
  const stale = (await listRobots(user)).filter((r) => r.status.common === "OFFLINE" || r.status.common === "UNKNOWN");
  const t = dash.totals;
  const todoCount = todo.missedRuns.length + todo.unacknowledgedIncidents + todo.lowConsumables.length + todo.staleRobots.length;
  const w = dash.week;
  const pw = dash.prevWeek;

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

      <Card title={`오늘 할 일 ${todoCount ? `(${todoCount})` : ""}`} className="mb-4">
        {todoCount === 0 ? (
          <div className="text-sm text-gray-600">처리할 일이 없습니다. 오늘 예정 회차 {todo.plannedToday.total}건 중 {todo.plannedToday.remaining}건이 남아 있습니다.</div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
            <TodoBlock title="예정 작업 미실행(24시간)" count={todo.missedRuns.length} href="/tasks" tone="bad">
              {todo.missedRuns.slice(0, 4).map((m) => (
                <li key={m.id}><Link href={`/robots/${m.robotId}`} className="text-navy hover:underline">{m.robotName}</Link> · {m.taskName} <span className="text-gray-500">{formatDateTime(m.plannedAt)}</span></li>
              ))}
            </TodoBlock>
            <TodoBlock title="미확인 장애" count={todo.unacknowledgedIncidents} href="/incidents" tone="bad">
              <li className="text-gray-600">장애·조치 화면에서 확인 처리하세요.</li>
            </TodoBlock>
            <TodoBlock title={`소모품 ${LOW_CONSUMABLE_PCT}% 미만`} count={todo.lowConsumables.length} href="/robots" tone="warn">
              {todo.lowConsumables.slice(0, 4).map((c) => (
                <li key={`${c.robotId}-${c.name}`}><Link href={`/robots/${c.robotId}`} className="text-navy hover:underline">{c.robotName}</Link> · {c.name} <span className="text-amber-700">{c.remainingPct}%</span></li>
              ))}
            </TodoBlock>
            <TodoBlock title="상태 미수신 로봇" count={todo.staleRobots.length} href="/robots" tone="warn">
              {todo.staleRobots.slice(0, 4).map((r) => (
                <li key={r.robotId}><Link href={`/robots/${r.robotId}`} className="text-navy hover:underline">{r.robotName}</Link> <span className="text-gray-500">{r.siteName} · {relativeFromNow(r.lastReceivedAt, dash.now)}</span></li>
              ))}
            </TodoBlock>
          </div>
        )}
        <div className="text-xs text-gray-500 mt-2">오늘 예정 회차 {todo.plannedToday.total}건 · 아직 시각이 안 된 회차 {todo.plannedToday.remaining}건</div>
      </Card>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
        <Stat label="최근 7일 작업" value={`${w.runs.toLocaleString()}건`} hint={weekDelta(w.runs, pw.runs, "건")} />
        <Stat label="최근 7일 청소 면적" value={`${w.areaM2.toLocaleString()}㎡`} hint={weekDelta(w.areaM2, pw.areaM2, "㎡")} />
        <Stat label="최근 7일 완료율" value={w.completionRatePct === null ? "해당 없음" : `${w.completionRatePct}%`} hint={weekDelta(w.completionRatePct, pw.completionRatePct, "%")} tone={w.completionRatePct !== null && w.completionRatePct < 80 ? "warn" : "default"} />
        <Stat label="생산성(㎡/시간)" value={w.productivityM2PerHour === null ? "-" : w.productivityM2PerHour.toLocaleString()} hint={weekDelta(w.productivityM2PerHour, pw.productivityM2PerHour, "")} />
        <Stat label="장애 평균 조치 시간" value={dash.mttrMin30d === null ? "해당 없음" : fmtMin(dash.mttrMin30d)} hint={`최근 30일 복구 기준 · 7일 장애 ${w.incidents}건(전주 ${pw.incidents})`} />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <Card title="사업장별 현황" className="lg:col-span-2 min-w-0">
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
                    <th>7일 완료율</th>
                    <th>7일 생산성</th>
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
                      <td className="whitespace-nowrap">{s.week.completionRatePct === null ? <span className="text-gray-400">-</span> : `${s.week.completionRatePct}%`}<div className="text-xs text-gray-500">{weekDelta(s.week.completionRatePct, s.prevWeek.completionRatePct, "%") || "전주 없음"}</div></td>
                      <td className="whitespace-nowrap">{s.week.productivityM2PerHour === null ? <span className="text-gray-400">-</span> : `${s.week.productivityM2PerHour.toLocaleString()}㎡/h`}<div className="text-xs text-gray-500">{s.week.runs}건 · {s.week.areaM2.toLocaleString()}㎡</div></td>
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

        <div className="space-y-4 min-w-0">
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
