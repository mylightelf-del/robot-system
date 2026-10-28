import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/session";
import { listReports, listRuns } from "@/lib/services/reports";
import { listSites } from "@/lib/services/robots";
import { listPlannedRuns } from "@/lib/services/tasks";
import { canEditReports, isCustomer } from "@/lib/auth/authz";
import { AppError } from "@/lib/util/errors";
import { Card, Empty, PageTitle, Stat } from "@/components/ui";
import { AccessDenied } from "@/components/AccessDenied";
import { SiteFilter } from "@/components/SiteFilter";
import { ReportStatusBadge } from "@/components/StatusBadge";
import { NewDraftForm } from "@/components/ReportEditor";
import { formatDateTime, localMonthKey, localToUtcIso, monthLabel, nowIso, shiftMonth } from "@/lib/util/time";
import { RUN_RESULT_LABEL } from "@/lib/domain/status";

function monthRange(month: string): { fromIso: string; toIso: string } {
  const next = shiftMonth(month, 1);
  return { fromIso: localToUtcIso(`${month}-01`, "00:00"), toIso: localToUtcIso(`${next}-01`, "00:00") };
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ site?: string; month?: string }> }) {
  const sp = await searchParams;
  const user = await getCurrentUser();
  const now = nowIso();
  const thisMonth = localMonthKey(now);
  const month = sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : thisMonth;
  const site = sp.site || undefined;
  let sites, reports, runs, planned;
  try {
    sites = listSites(user);
    reports = listReports(user, site);
    const range = monthRange(month);
    runs = listRuns(user, { siteId: site, fromIso: range.fromIso, toIso: range.toIso });
    planned = listPlannedRuns(user, { siteId: site, fromIso: range.fromIso, toIso: range.toIso });
  } catch (e) {
    return <AccessDenied reason={e instanceof AppError ? e.message : "접근할 수 없습니다."} />;
  }
  const customer = isCustomer(user);
  const editor = canEditReports(user);

  // 화면 요약(계획 대비 실적) — 보고서 스냅샷과 별개로 현재 데이터 기준
  const validPlanned = planned.filter((p) => p.status !== "CANCELLED" && p.status !== "EXCLUDED" && !(p.status === "PLANNED" && p.plannedAt > now));
  const completedPlanned = validPlanned.filter((p) => p.status === "DONE" && p.runResult === "COMPLETED");
  const rate = validPlanned.length === 0 ? null : Math.round((completedPlanned.length / validPlanned.length) * 1000) / 10;
  const area = runs.reduce((s, r) => s + r.areaM2, 0);
  const adhoc = runs.filter((r) => r.origin !== "PLANNED").length;
  const monthOptions = [0, -1, -2].map((d) => shiftMonth(thisMonth, d));

  return (
    <>
      <PageTitle
        title="실적·보고서"
        subtitle={customer ? "확정·공개된 월간 보고서와 자기 사업장 실적만 표시됩니다." : "계획 대비 실적 조회와 월간 보고서 초안 → 검토 → 확정 → 고객 공개"}
        right={
          <div className="flex flex-wrap gap-2 items-center">
            <SiteFilter sites={sites} current={site ?? ""} basePath="/reports" extra={`month=${month}`} />
            <div className="flex gap-1">
              {monthOptions.map((m) => (
                <Link key={m} href={`/reports?month=${m}${site ? `&site=${site}` : ""}`} className={`px-2.5 py-1 rounded text-xs sm:text-sm border ${m === month ? "bg-navy text-white border-navy" : "bg-white border-gray-300"}`}>
                  {monthLabel(m)}
                </Link>
              ))}
            </div>
          </div>
        }
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Stat label={`${monthLabel(month)} 계획 완료율`} value={rate === null ? "해당 없음" : `${rate}%`} hint={`정상 완료 ${completedPlanned.length} / 유효 계획 ${validPlanned.length}`} />
        <Stat label="실제 작업 건수" value={runs.length} hint={`즉시·원격 지시 ${adhoc}건 별도`} />
        <Stat label="누적 청소 면적" value={`${area.toLocaleString()}㎡`} hint="반복 구역 포함(고유 면적 아님)" />
        <Stat label="취소·제외·미실행" value={`${planned.filter((p) => p.status === "CANCELLED").length} · ${planned.filter((p) => p.status === "EXCLUDED").length} · ${planned.filter((p) => p.status === "MISSED").length}`} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card title="월간 보고서" right={<span className="text-xs text-gray-500">{reports.length}건</span>}>
          {editor && (
            <div className="mb-3 border rounded p-3 bg-slate-50">
              <NewDraftForm sites={sites.map((s) => ({ id: s.id, name: s.name }))} defaultMonth={shiftMonth(thisMonth, -1)} />
            </div>
          )}
          {reports.length === 0 ? (
            <Empty>{customer ? "공개된 보고서가 없습니다." : "보고서가 없습니다. 초안을 생성하세요."}</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="data">
                <thead>
                  <tr>
                    <th>월</th>
                    <th>사업장</th>
                    <th>버전</th>
                    <th>상태</th>
                    <th>완료율</th>
                    <th>비고</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((r) => (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap">{monthLabel(r.month)}</td>
                      <td>
                        <Link href={`/reports/${r.id}`} className="text-navy font-medium hover:underline">
                          {r.siteName}
                        </Link>
                      </td>
                      <td>v{r.version}{r.isLatestVersion ? "" : <span className="text-xs text-gray-400"> (이전)</span>}</td>
                      <td><ReportStatusBadge status={r.status} /></td>
                      <td>{r.aggregates.completionRatePct === null ? "해당 없음" : `${r.aggregates.completionRatePct}%`}</td>
                      <td className="text-xs">
                        {r.confirmedAt && <div>확정 {formatDateTime(r.confirmedAt)}</div>}
                        {!customer && r.lateRuns > 0 && <div className="text-amber-700">집계 후 수신 실적 {r.lateRuns}건</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title={`${monthLabel(month)} 실적 (최근 40건)`} right={<span className="text-xs text-gray-500">총 {runs.length}건</span>}>
          {runs.length === 0 ? (
            <Empty>이 기간의 실적이 없습니다.</Empty>
          ) : (
            <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
              <table className="data">
                <thead>
                  <tr>
                    <th>시작</th>
                    <th>로봇</th>
                    <th>구분</th>
                    <th>결과</th>
                    <th>면적</th>
                    <th>시간</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.slice(0, 40).map((r) => (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap">{formatDateTime(r.startedAt)}</td>
                      <td>
                        <Link href={`/robots/${r.robotId}`} className="text-navy hover:underline">{r.robotName}</Link>
                        <div className="text-xs text-gray-500">{r.siteName} / {r.floorName}</div>
                      </td>
                      <td className="text-xs">{r.origin === "PLANNED" ? "계획" : r.origin === "REMOTE" ? "원격" : "즉시"}</td>
                      <td className={r.result === "COMPLETED" ? "text-emerald-700" : "text-amber-700"}>{RUN_RESULT_LABEL[r.result]}</td>
                      <td>{r.areaM2.toLocaleString()}㎡</td>
                      <td>{r.durationMin}분</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-gray-500 mt-2">엑셀 내보내기는 제안 기능으로, 2단계 이후 검토합니다.</p>
        </Card>
      </div>
    </>
  );
}
