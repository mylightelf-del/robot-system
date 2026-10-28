import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/session";
import { getReport, listVersions } from "@/lib/services/reports";
import { listUsers } from "@/lib/db/repo";
import { canConfirmReports, canEditReports, isCustomer } from "@/lib/auth/authz";
import { AppError } from "@/lib/util/errors";
import { Notice, PageTitle } from "@/components/ui";
import { AccessDenied } from "@/components/AccessDenied";
import { ReportStatusBadge, SeverityBadge } from "@/components/StatusBadge";
import { CommentsEditor, ReportWorkflow } from "@/components/ReportEditor";
import { PrintButton } from "@/components/PrintButton";
import { formatDate, formatDateTime, monthLabel } from "@/lib/util/time";

export default async function ReportPage({ params }: { params: Promise<{ reportId: string }> }) {
  const { reportId } = await params;
  const user = await getCurrentUser();
  let r;
  try {
    r = await getReport(user, reportId);
  } catch (e) {
    return <AccessDenied reason={e instanceof AppError ? e.message : "접근할 수 없습니다."} />;
  }
  const a = r.aggregates;
  const customer = isCustomer(user);
  const editable = canEditReports(user) && (r.status === "DRAFT" || r.status === "REVIEW");
  const users = await listUsers();
  const userName = (id: string | null) => (id ? (users.find((u) => u.id === id)?.name ?? id) : "-");
  const frozen = r.status === "CONFIRMED" || r.status === "PUBLISHED";
  const versions = await listVersions(user, r.siteId, r.month);
  const canConfirm = await canConfirmReports(user);

  return (
    <>
      <div className="no-print">
        <PageTitle
          title={`${monthLabel(r.month)} 월간 보고서 — ${r.siteName}`}
          subtitle={
            <>
              v{r.version} <ReportStatusBadge status={r.status} /> · 집계 기준 {formatDateTime(a.generatedAt)} · 작성 {userName(r.createdBy)}
              {r.confirmedAt ? ` · 확정 ${formatDateTime(r.confirmedAt)} (${userName(r.confirmedBy)})` : ""}
            </>
          }
          right={
            <div className="flex flex-wrap gap-2 items-center">
              {versions.length > 1 && (
                <span className="text-xs text-gray-600">
                  버전:{" "}
                  {versions.map((v) => (
                    <Link key={v.id} href={`/reports/${v.id}`} className={`underline mr-1 ${v.id === r.id ? "font-bold" : ""}`}>
                      v{v.version}
                    </Link>
                  ))}
                </span>
              )}
              <PrintButton />
              <Link href="/reports" className="text-sm underline">목록</Link>
            </div>
          }
        />
        {frozen && <div className="mb-3"><Notice tone="info">확정본입니다. 집계값과 의견은 확정 시점 스냅샷으로 고정되어 있으며 재집계로 변경되지 않습니다.{!customer && r.lateRuns > 0 ? ` 집계 이후 수신된 실적 ${r.lateRuns}건은 새 버전에서 반영할 수 있습니다.` : ""}</Notice></div>}
        {!customer && (
          <div className="mb-4">
            <ReportWorkflow reportId={r.id} status={r.status} canEdit={canEditReports(user)} canConfirm={canConfirm} lateRuns={r.lateRuns} isLatest={r.isLatestVersion} />
          </div>
        )}
      </div>

      {/* ---- 1쪽 ---- */}
      <section className="print-page bg-white border rounded-lg p-5 mb-4">
        <div className="flex justify-between items-start border-b pb-2 mb-3">
          <div>
            <div className="text-xs text-gray-500">청소로봇 운영 월간 보고서 (샘플 양식)</div>
            <h2 className="text-xl font-bold text-navy">{r.siteName} · {monthLabel(r.month)}</h2>
          </div>
          <div className="text-right text-xs text-gray-500">
            v{r.version} · {r.status === "PUBLISHED" ? "확정본" : r.status === "CONFIRMED" ? "확정(미공개)" : "초안 — 확정 전"}
            <br />집계 {formatDateTime(a.generatedAt)}
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm mb-4">
          <div><div className="text-xs text-gray-500">운영 대수</div><div className="text-lg font-bold">{a.robotCount}대</div></div>
          <div><div className="text-xs text-gray-500">계획 완료율</div><div className="text-lg font-bold">{a.completionRatePct === null ? "해당 없음" : `${a.completionRatePct}%`}</div><div className="text-xs text-gray-500">{a.plannedCompleted}/{a.validPlanned}회</div></div>
          <div><div className="text-xs text-gray-500">총 작업</div><div className="text-lg font-bold">{a.totalRuns}건</div><div className="text-xs text-gray-500">즉시·원격 {a.adhocRuns}건 별도</div></div>
          <div><div className="text-xs text-gray-500">누적 청소 면적</div><div className="text-lg font-bold">{a.cumulativeAreaM2.toLocaleString()}㎡</div><div className="text-xs text-gray-500">반복 구역 포함</div></div>
          <div><div className="text-xs text-gray-500">총 작업 시간</div><div className="text-lg font-bold">{Math.round(a.totalDurationMin / 60)}시간 {a.totalDurationMin % 60}분</div></div>
          <div><div className="text-xs text-gray-500">물 사용량</div><div className="text-lg font-bold">{a.waterL === null ? "미제공" : `${a.waterL}L`}</div></div>
          <div><div className="text-xs text-gray-500">세제 사용량</div><div className="text-lg font-bold">{a.detergentMl === null ? "미제공" : `${a.detergentMl}mL`}</div></div>
          <div><div className="text-xs text-gray-500">장애 건수</div><div className="text-lg font-bold">{a.incidents.length}건</div></div>
        </div>
        <h3 className="font-semibold text-navy mb-1">종합 의견</h3>
        <div className="print:hidden">
          <CommentsEditor reportId={r.id} comments={r.comments} editable={editable} />
        </div>
        <div className="hidden print:block text-sm whitespace-pre-wrap">{r.comments.overallOpinion || "(없음)"}</div>
        {a.unsupportedMetrics.length > 0 && (
          <div className="mt-3 text-xs text-gray-500">
            <div className="font-medium">지표 주석</div>
            <ul className="list-disc ml-4">{a.unsupportedMetrics.map((m) => <li key={m}>{m}</li>)}</ul>
          </div>
        )}
      </section>

      {/* ---- 2쪽 ---- */}
      <section className="print-page bg-white border rounded-lg p-5 mb-4">
        <h3 className="font-semibold text-navy mb-2">계획 대비 수행</h3>
        <table className="data mb-4">
          <tbody>
            <tr><td>유효 계획 회차</td><td className="text-right">{a.validPlanned}</td><td>정상 완료</td><td className="text-right">{a.plannedCompleted}</td></tr>
            <tr><td>미실행</td><td className="text-right">{a.missed}</td><td>취소 / 제외일</td><td className="text-right">{a.cancelled} / {a.excluded}</td></tr>
            <tr><td>즉시·원격 지시 작업(별도)</td><td className="text-right">{a.adhocRuns}</td><td>데이터 미수신 일자</td><td className="text-right">{a.dataGapDays.length ? a.dataGapDays.join(", ") : "없음"}</td></tr>
          </tbody>
        </table>
        <h3 className="font-semibold text-navy mb-1">층별 실적</h3>
        <table className="data mb-4">
          <thead><tr><th>층</th><th className="text-right">작업 건수</th><th className="text-right">누적 면적</th><th className="text-right">작업 시간</th></tr></thead>
          <tbody>{a.byFloor.map((f) => <tr key={f.floorId}><td>{f.floorName}</td><td className="text-right">{f.runs}</td><td className="text-right">{f.areaM2.toLocaleString()}㎡</td><td className="text-right">{f.durationMin}분</td></tr>)}</tbody>
        </table>
        <h3 className="font-semibold text-navy mb-1">구역별 실적</h3>
        <table className="data mb-4">
          <thead><tr><th>층</th><th>구역</th><th className="text-right">작업 건수</th><th className="text-right">배분 면적(근사)</th></tr></thead>
          <tbody>{a.byZone.map((z) => <tr key={z.zoneId}><td>{z.floorName}</td><td>{z.zoneName}</td><td className="text-right">{z.runs}</td><td className="text-right">{z.areaM2.toLocaleString()}㎡</td></tr>)}</tbody>
        </table>
        <h3 className="font-semibold text-navy mb-1">로봇별 실적</h3>
        <table className="data mb-4">
          <thead><tr><th>로봇</th><th>모델</th><th className="text-right">작업</th><th className="text-right">정상 완료</th><th className="text-right">누적 면적</th></tr></thead>
          <tbody>{a.byRobot.map((b) => <tr key={b.robotId}><td>{b.name}</td><td>{b.model}</td><td className="text-right">{b.runs}</td><td className="text-right">{b.completed}</td><td className="text-right">{b.areaM2.toLocaleString()}㎡</td></tr>)}</tbody>
        </table>
        <h3 className="font-semibold text-navy mb-1">미완료 사유</h3>
        <div className="text-sm whitespace-pre-wrap">{r.comments.incompleteReasons || <span className="text-gray-400">(작성 전)</span>}</div>
      </section>

      {/* ---- 3쪽 ---- */}
      <section className="print-page bg-white border rounded-lg p-5 mb-4">
        <h3 className="font-semibold text-navy mb-1">주요 장애 · 운영 영향 · 조치</h3>
        {a.incidents.length === 0 ? (
          <p className="text-sm text-gray-500 mb-4">이 달에 기록된 장애가 없습니다.</p>
        ) : (
          <table className="data mb-4">
            <thead><tr><th>발생</th><th>등급</th><th>내용</th><th>조치</th><th>복구</th></tr></thead>
            <tbody>
              {a.incidents.map((i) => (
                <tr key={i.id}>
                  <td className="whitespace-nowrap">{formatDateTime(i.occurredAt)}</td>
                  <td><SeverityBadge severity={i.severity} /></td>
                  <td>{i.customerMessage}</td>
                  <td className="text-xs">{i.actionSummary}</td>
                  <td className="whitespace-nowrap text-xs">{i.resolvedAt ? formatDateTime(i.resolvedAt) : "미복구"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <h3 className="font-semibold text-navy mb-1">점검 · 소모품 기록</h3>
        <table className="data">
          <thead><tr><th>항목</th><th className="text-right">완료 / 예정</th></tr></thead>
          <tbody>{a.inspections.map((x) => <tr key={x.item}><td>{x.item}</td><td className="text-right">{x.done} / {x.total}</td></tr>)}</tbody>
        </table>
      </section>

      {/* ---- 4쪽 ---- */}
      <section className="print-page bg-white border rounded-lg p-5 mb-4">
        <h3 className="font-semibold text-navy mb-1">개선 사항</h3>
        <div className="text-sm whitespace-pre-wrap mb-4">{r.comments.improvements || <span className="text-gray-400">(작성 전)</span>}</div>
        <h3 className="font-semibold text-navy mb-1">집중 관리 구역</h3>
        <div className="text-sm whitespace-pre-wrap mb-4">{r.comments.focusZones || <span className="text-gray-400">(작성 전)</span>}</div>
        <h3 className="font-semibold text-navy mb-1">차월 계획</h3>
        <div className="text-sm whitespace-pre-wrap mb-4">{r.comments.nextMonthPlan || <span className="text-gray-400">(작성 전)</span>}</div>
        <div className="text-xs text-gray-500 border-t pt-2">
          실적 포함 기준: {formatDate(a.includesRunsReceivedUntil)}까지 수신분 · 시간대 Asia/Seoul · 샘플 데이터
        </div>
      </section>
    </>
  );
}
