import Link from "next/link";
import type { ReactNode } from "react";
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
import { formatDate, formatDateTime, formatTime, localDateKey } from "@/lib/util/time";
import { commentLabels, periodText } from "@/lib/reports/schedule";
import type { ReportAggregates } from "@/lib/domain/types";

function Page({ children }: { children: ReactNode }) {
  return <section className="print-page bg-white border rounded-lg p-5 mb-4">{children}</section>;
}
function H({ children }: { children: ReactNode }) {
  return <h3 className="font-semibold text-navy mb-1">{children}</h3>;
}
function Text({ value }: { value: string }) {
  return <div className="text-sm whitespace-pre-wrap mb-4">{value || <span className="text-gray-400">(작성 전)</span>}</div>;
}
const hm = (min: number) => `${Math.floor(min / 60)}시간 ${min % 60}분`;
const md = (k: string) => `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))}`;

function SummaryStats({ a }: { a: ReportAggregates }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm mb-4">
      <div><div className="text-xs text-gray-500">운영 대수</div><div className="text-lg font-bold">{a.robotCount}대</div></div>
      <div><div className="text-xs text-gray-500">계획 완료율</div><div className="text-lg font-bold">{a.completionRatePct === null ? "해당 없음" : `${a.completionRatePct}%`}</div><div className="text-xs text-gray-500">{a.plannedCompleted}/{a.validPlanned}회</div></div>
      <div><div className="text-xs text-gray-500">총 작업</div><div className="text-lg font-bold">{a.totalRuns}건</div><div className="text-xs text-gray-500">즉시·원격 {a.adhocRuns}건 별도</div></div>
      <div><div className="text-xs text-gray-500">누적 청소 면적</div><div className="text-lg font-bold">{a.cumulativeAreaM2.toLocaleString()}㎡</div><div className="text-xs text-gray-500">반복 구역 포함</div></div>
      <div><div className="text-xs text-gray-500">총 작업 시간</div><div className="text-lg font-bold">{hm(a.totalDurationMin)}</div></div>
      <div><div className="text-xs text-gray-500">물 사용량</div><div className="text-lg font-bold">{a.waterL === null ? "미제공" : `${a.waterL}L`}</div></div>
      <div><div className="text-xs text-gray-500">세제 사용량</div><div className="text-lg font-bold">{a.detergentMl === null ? "미제공" : `${a.detergentMl}mL`}</div></div>
      <div><div className="text-xs text-gray-500">장애 건수</div><div className="text-lg font-bold">{a.incidents.length}건</div></div>
    </div>
  );
}

function PlanTable({ a }: { a: ReportAggregates }) {
  return (
    <table className="data mb-4">
      <tbody>
        <tr><td>유효 계획 회차</td><td className="text-right">{a.validPlanned}</td><td>정상 완료</td><td className="text-right">{a.plannedCompleted}</td></tr>
        <tr><td>미실행</td><td className="text-right">{a.missed}</td><td>취소 / 제외일</td><td className="text-right">{a.cancelled} / {a.excluded}</td></tr>
        <tr><td>즉시·원격 지시 작업(별도)</td><td className="text-right">{a.adhocRuns}</td><td>데이터 미수신 일자</td><td className="text-right">{a.dataGapDays.length ? a.dataGapDays.join(", ") : "없음"}</td></tr>
      </tbody>
    </table>
  );
}

function RunListTable({ a }: { a: ReportAggregates }) {
  const list = a.runList ?? [];
  if (list.length === 0) return <p className="text-sm text-gray-500 mb-4">이 기간에 수신된 작업이 없습니다.</p>;
  return (
    <table className="data mb-4">
      <thead><tr><th>시작</th><th>로봇</th><th>층</th><th>구분</th><th>결과</th><th className="text-right">면적</th><th className="text-right">시간</th></tr></thead>
      <tbody>
        {list.map((r, i) => (
          <tr key={i}>
            <td className="whitespace-nowrap">{formatTime(r.startedAt)}</td>
            <td>{r.robotName}</td>
            <td>{r.floorName}</td>
            <td className="text-xs">{r.origin === "PLANNED" ? "계획" : r.origin === "REMOTE" ? "원격" : "즉시"}</td>
            <td>{r.result}</td>
            <td className="text-right">{r.areaM2.toLocaleString()}㎡</td>
            <td className="text-right">{r.durationMin}분</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ByDayTable({ a }: { a: ReportAggregates }) {
  if (!a.byDay?.length) return null;
  return (
    <>
      <H>일자별 실적</H>
      <table className="data mb-4">
        <thead><tr><th>날짜</th><th className="text-right">작업</th><th className="text-right">정상 완료</th><th className="text-right">누적 면적</th><th className="text-right">작업 시간</th></tr></thead>
        <tbody>
          {a.byDay.map((d) => (
            <tr key={d.date} className={d.runs === 0 ? "text-gray-400" : ""}>
              <td>{md(d.date)}</td><td className="text-right">{d.runs}</td><td className="text-right">{d.completed}</td><td className="text-right">{d.areaM2.toLocaleString()}㎡</td><td className="text-right">{d.durationMin}분</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function FloorZoneRobotTables({ a }: { a: ReportAggregates }) {
  return (
    <>
      <H>층별 실적</H>
      <table className="data mb-4">
        <thead><tr><th>층</th><th className="text-right">작업 건수</th><th className="text-right">누적 면적</th><th className="text-right">작업 시간</th></tr></thead>
        <tbody>{a.byFloor.map((f) => <tr key={f.floorId}><td>{f.floorName}</td><td className="text-right">{f.runs}</td><td className="text-right">{f.areaM2.toLocaleString()}㎡</td><td className="text-right">{f.durationMin}분</td></tr>)}</tbody>
      </table>
      {a.byZone.length > 0 && (
        <>
          <H>구역별 실적</H>
          <table className="data mb-4">
            <thead><tr><th>층</th><th>구역</th><th className="text-right">작업 건수</th><th className="text-right">배분 면적(근사)</th></tr></thead>
            <tbody>{a.byZone.map((z) => <tr key={z.zoneId}><td>{z.floorName}</td><td>{z.zoneName}</td><td className="text-right">{z.runs}</td><td className="text-right">{z.areaM2.toLocaleString()}㎡</td></tr>)}</tbody>
          </table>
        </>
      )}
      <H>로봇별 실적</H>
      {a.byRobot.length === 0 ? (
        <p className="text-sm text-gray-500 mb-4">작업 실적이 없습니다.</p>
      ) : (
        <table className="data mb-4">
          <thead><tr><th>로봇</th><th>모델</th><th className="text-right">작업</th><th className="text-right">정상 완료</th><th className="text-right">누적 면적</th></tr></thead>
          <tbody>{a.byRobot.map((b) => <tr key={b.robotId}><td>{b.name}</td><td>{b.model}</td><td className="text-right">{b.runs}</td><td className="text-right">{b.completed}</td><td className="text-right">{b.areaM2.toLocaleString()}㎡</td></tr>)}</tbody>
        </table>
      )}
    </>
  );
}

function IncidentsInspections({ a }: { a: ReportAggregates }) {
  return (
    <>
      <H>주요 장애 · 운영 영향 · 조치</H>
      {a.incidents.length === 0 ? (
        <p className="text-sm text-gray-500 mb-4">이 기간에 기록된 장애가 없습니다.</p>
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
      <H>점검 · 소모품 기록</H>
      {a.inspections.length === 0 ? (
        <p className="text-sm text-gray-500">이 기간에 예정된 점검이 없습니다.</p>
      ) : (
        <table className="data">
          <thead><tr><th>항목</th><th className="text-right">완료 / 예정</th></tr></thead>
          <tbody>{a.inspections.map((x) => <tr key={x.item}><td>{x.item}</td><td className="text-right">{x.done} / {x.total}</td></tr>)}</tbody>
        </table>
      )}
    </>
  );
}

function InstallationTables({ a }: { a: ReportAggregates }) {
  const ins = a.installation;
  if (!ins) return <p className="text-sm text-gray-500">설치 현황 데이터가 없습니다.</p>;
  return (
    <>
      <H>설치 로봇 ({ins.robots.length}대)</H>
      <table className="data mb-4">
        <thead><tr><th>로봇</th><th>모델</th><th>배치 층</th></tr></thead>
        <tbody>{ins.robots.map((r) => <tr key={r.name}><td>{r.name}</td><td>{r.model}</td><td>{r.floorName}</td></tr>)}</tbody>
      </table>
      <H>층 · 지도 · 구역</H>
      <table className="data mb-4">
        <thead><tr><th>층</th><th>지도</th><th className="text-right">구역 수</th></tr></thead>
        <tbody>{ins.floors.map((f) => <tr key={f.name}><td>{f.name}</td><td>{f.mapVersion === null ? f.mapSource : `${f.mapSource} v${f.mapVersion}`}</td><td className="text-right">{f.zones}</td></tr>)}</tbody>
      </table>
      <H>등록 작업 ({ins.tasks.length}건)</H>
      {ins.tasks.length === 0 ? (
        <p className="text-sm text-gray-500 mb-4">등록된 작업이 없습니다.</p>
      ) : (
        <table className="data mb-4">
          <thead><tr><th>작업</th><th>로봇</th><th className="text-right">구역 수</th></tr></thead>
          <tbody>{ins.tasks.map((t, i) => <tr key={i}><td>{t.name}</td><td>{t.robotName}</td><td className="text-right">{t.zones}</td></tr>)}</tbody>
        </table>
      )}
      <H>정기 예약 ({ins.schedules.length}건)</H>
      {ins.schedules.length === 0 ? (
        <p className="text-sm text-gray-500 mb-4">등록된 예약이 없습니다.</p>
      ) : (
        <table className="data mb-4">
          <thead><tr><th>작업</th><th>요일</th><th>시각</th><th>사용</th></tr></thead>
          <tbody>{ins.schedules.map((s, i) => <tr key={i}><td>{s.taskName}</td><td>{s.days}</td><td>{s.time}</td><td>{s.enabled ? "사용" : "중지"}</td></tr>)}</tbody>
        </table>
      )}
    </>
  );
}

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
  const userName = (id: string | null) => (id === "system" ? "자동 작성" : id ? (users.find((u) => u.id === id)?.name ?? id) : "-");
  const frozen = r.status === "CONFIRMED" || r.status === "PUBLISHED";
  const versions = await listVersions(user, r.siteId, r);
  const canConfirm = await canConfirmReports(user);
  const labels = commentLabels(r.kind);
  const period = periodText(r);

  return (
    <>
      <div className="no-print">
        <PageTitle
          title={`${r.title} — ${r.siteName}`}
          subtitle={
            <>
              {period} · v{r.version} <ReportStatusBadge status={r.status} /> · 집계 기준 {formatDateTime(a.generatedAt)} · 작성 {userName(r.createdBy)}
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
              <Link href={`/reports?site=${r.siteId}`} className="text-sm underline">목록</Link>
            </div>
          }
        />
        {frozen && <div className="mb-3"><Notice tone="info">확정본입니다. 집계값과 의견은 확정 시점 스냅샷으로 고정되어 있으며 재집계로 변경되지 않습니다.{!customer && r.lateRuns > 0 ? ` 집계 이후 수신된 실적 ${r.lateRuns}건은 새 버전에서 반영할 수 있습니다.` : ""}</Notice></div>}
        {!frozen && !customer && localDateKey(a.generatedAt) <= r.periodEnd && <div className="mb-3"><Notice tone="warn">대상 기간이 끝나기 전에 집계한 초안입니다. 기간이 끝난 뒤 재집계하세요.</Notice></div>}
        {!customer && (
          <div className="mb-4">
            <ReportWorkflow reportId={r.id} status={r.status} canEdit={canEditReports(user)} canConfirm={canConfirm} lateRuns={r.lateRuns} isLatest={r.isLatestVersion} />
          </div>
        )}
      </div>

      {/* ---- 1쪽: 요약 + 종합 의견 ---- */}
      <Page>
        <div className="flex justify-between items-start border-b pb-2 mb-3">
          <div>
            <div className="text-xs text-gray-500">청소로봇 운영 보고서</div>
            <h2 className="text-xl font-bold text-navy">{r.siteName} · {r.title}</h2>
            <div className="text-sm text-gray-600">대상 기간 {period}{a.installation ? ` · 설치일 ${a.installation.installedOn}` : ""}</div>
          </div>
          <div className="text-right text-xs text-gray-500">
            v{r.version} · {r.status === "PUBLISHED" ? "확정본" : r.status === "CONFIRMED" ? "확정(미공개)" : "초안 — 확정 전"}
            <br />집계 {formatDateTime(a.generatedAt)}
          </div>
        </div>
        <SummaryStats a={a} />
        <H>{labels.overallOpinion}</H>
        <div className="print:hidden">
          <CommentsEditor reportId={r.id} kind={r.kind} comments={r.comments} editable={editable} />
        </div>
        <div className="hidden print:block text-sm whitespace-pre-wrap">{r.comments.overallOpinion || "(없음)"}</div>
        {a.unsupportedMetrics.length > 0 && (
          <div className="mt-3 text-xs text-gray-500">
            <div className="font-medium">지표 주석</div>
            <ul className="list-disc ml-4">{a.unsupportedMetrics.map((m) => <li key={m}>{m}</li>)}</ul>
          </div>
        )}
      </Page>

      {r.kind === "INSTALLATION" ? (
        <>
          <Page>
            <InstallationTables a={a} />
          </Page>
          <Page>
            <H>설치일 작업(시험 운전 포함)</H>
            <RunListTable a={a} />
            <IncidentsInspections a={a} />
          </Page>
        </>
      ) : r.kind === "DAILY" ? (
        <>
          <Page>
            <H>작업 목록</H>
            <RunListTable a={a} />
            <H>계획 대비 수행</H>
            <PlanTable a={a} />
            <H>{labels.incompleteReasons}</H>
            <Text value={r.comments.incompleteReasons} />
          </Page>
          <Page>
            <IncidentsInspections a={a} />
          </Page>
        </>
      ) : (
        <>
          <Page>
            <H>계획 대비 수행</H>
            <PlanTable a={a} />
            <ByDayTable a={a} />
            <FloorZoneRobotTables a={a} />
            <H>{labels.incompleteReasons}</H>
            <Text value={r.comments.incompleteReasons} />
          </Page>
          <Page>
            <IncidentsInspections a={a} />
          </Page>
        </>
      )}

      {/* ---- 마지막 쪽: 의견 ---- */}
      <Page>
        {r.kind === "INSTALLATION" && (
          <>
            <H>{labels.incompleteReasons}</H>
            <Text value={r.comments.incompleteReasons} />
          </>
        )}
        <H>{labels.improvements}</H>
        <Text value={r.comments.improvements} />
        <H>{labels.focusZones}</H>
        <Text value={r.comments.focusZones} />
        <H>{labels.nextMonthPlan}</H>
        <Text value={r.comments.nextMonthPlan} />
        <div className="text-xs text-gray-500 border-t pt-2">
          실적 포함 기준: {formatDate(a.includesRunsReceivedUntil)}까지 수신분 · 날짜는 사업장 시간대 기준{r.siteIsSample ? " · 샘플 데이터" : ""}
        </div>
      </Page>
    </>
  );
}
