import Link from "next/link";
import type { ReactNode } from "react";
import { getCurrentUser } from "@/lib/auth/session";
import { defaultContent, effectiveAggregates, getReport, listPhotos, listVersions } from "@/lib/services/reports";
import { listUsers } from "@/lib/db/repo";
import { canConfirmReports, canEditReports, isCustomer } from "@/lib/auth/authz";
import { AppError } from "@/lib/util/errors";
import { Notice, PageTitle } from "@/components/ui";
import { AccessDenied } from "@/components/AccessDenied";
import { ReportStatusBadge, SeverityBadge } from "@/components/StatusBadge";
import { CommentsEditor, ReportWorkflow } from "@/components/ReportEditor";
import { EditableNum, PhaseEditor, PhotoPanel, WorkLogEditor } from "@/components/ReportExtras";
import { PhaseTimeline, WeeklyTimeline, ZoneMap } from "@/components/ReportVisuals";
import { PrintButton } from "@/components/PrintButton";
import { formatDate, formatDateTime, formatTime, localDateKey } from "@/lib/util/time";
import { commentLabels, periodText } from "@/lib/reports/schedule";
import { originalValue } from "@/lib/reports/adjust";
import type { ReportAdjustments, ReportAggregates, ReportContent } from "@/lib/domain/types";

function Page({ children }: { children: ReactNode }) {
  return <section className="print-page bg-white border rounded-lg p-5 mb-4">{children}</section>;
}
function H({ children }: { children: ReactNode }) {
  return <h3 className="font-semibold text-navy mb-1">{children}</h3>;
}
function Text({ value }: { value: string }) {
  return <div className="text-sm whitespace-pre-wrap mb-4">{value || <span className="text-gray-400">(작성 전)</span>}</div>;
}
const hm = (min: number) => `${Math.floor(min / 60)}시간 ${Math.round(min % 60)}분`;
const md = (k: string) => `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))}`;

/** 수치 표시기: 수정 모드면 입력칸, 아니면 값(+보정 표시 *). */
type NumFn = (k: string, v: number | null, opts?: { unit?: string; text?: (v: number) => string; step?: number; empty?: string }) => ReactNode;
function makeNum(reportId: string, base: ReportAggregates, adj: ReportAdjustments, edit: boolean, showOriginal: boolean): NumFn {
  const fn: NumFn = (k, v, opts = {}) => {
    if (edit) return <EditableNum reportId={reportId} k={k} value={v} original={originalValue(base, k) ?? null} unit={opts.unit} step={opts.step} />;
    const shown = v === null ? (opts.empty ?? "미제공") : opts.text ? opts.text(v) : `${v.toLocaleString()}${opts.unit ?? ""}`;
    return (
      <>
        {shown}
        {adj[k] && <sup className="text-amber-700" title={showOriginal ? `원래 집계 ${adj[k].original ?? "미제공"}` : "담당자 보정"}>*</sup>}
      </>
    );
  };
  return fn;
}

function Cell({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-lg font-bold">{children}</div>
      {hint && <div className="text-xs text-gray-500">{hint}</div>}
    </div>
  );
}

function SummaryStats({ a, n }: { a: ReportAggregates; n: NumFn }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm mb-4">
      <Cell label="운영 대수">{n("summary.robotCount", a.robotCount, { unit: "대" })}</Cell>
      <Cell label="계획 완료율" hint={<>{n("summary.plannedCompleted", a.plannedCompleted)}/{n("summary.validPlanned", a.validPlanned)}회</>}>
        {n("summary.completionRatePct", a.completionRatePct, { unit: "%", step: 0.1, empty: "해당 없음" })}
      </Cell>
      <Cell label="총 작업" hint={<>즉시·원격 {n("summary.adhocRuns", a.adhocRuns)}건 별도</>}>{n("summary.totalRuns", a.totalRuns, { unit: "건" })}</Cell>
      <Cell label="누적 청소 면적" hint="반복 구역 포함">{n("summary.cumulativeAreaM2", a.cumulativeAreaM2, { unit: "㎡" })}</Cell>
      <Cell label="총 작업 시간">{n("summary.totalDurationMin", a.totalDurationMin, { unit: "분", text: hm })}</Cell>
      <Cell label="물 사용량">{n("summary.waterL", a.waterL, { unit: "L", step: 0.1 })}</Cell>
      <Cell label="세제 사용량">{n("summary.detergentMl", a.detergentMl, { unit: "mL" })}</Cell>
      <Cell label="장애 건수">{a.incidents.length}건</Cell>
    </div>
  );
}

function PlanTable({ a, n }: { a: ReportAggregates; n: NumFn }) {
  return (
    <table className="data mb-4">
      <tbody>
        <tr><td>유효 계획 회차</td><td className="text-right">{n("summary.validPlanned", a.validPlanned)}</td><td>정상 완료</td><td className="text-right">{n("summary.plannedCompleted", a.plannedCompleted)}</td></tr>
        <tr><td>미실행</td><td className="text-right">{n("summary.missed", a.missed)}</td><td>취소 / 제외일</td><td className="text-right">{n("summary.cancelled", a.cancelled)} / {n("summary.excluded", a.excluded)}</td></tr>
        <tr><td>즉시·원격 지시 작업(별도)</td><td className="text-right">{n("summary.adhocRuns", a.adhocRuns)}</td><td>데이터 미수신 일자</td><td className="text-right">{a.dataGapDays.length ? a.dataGapDays.join(", ") : "없음"}</td></tr>
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

function ByDayTable({ a, n }: { a: ReportAggregates; n: NumFn }) {
  if (!a.byDay?.length) return null;
  return (
    <>
      <H>일자별 실적</H>
      <table className="data mb-4">
        <thead><tr><th>날짜</th><th className="text-right">작업</th><th className="text-right">정상 완료</th><th className="text-right">누적 면적</th><th className="text-right">작업 시간</th></tr></thead>
        <tbody>
          {a.byDay.map((d) => (
            <tr key={d.date} className={d.runs === 0 ? "text-gray-400" : ""}>
              <td>{md(d.date)}</td>
              <td className="text-right">{n(`byDay.${d.date}.runs`, d.runs)}</td>
              <td className="text-right">{n(`byDay.${d.date}.completed`, d.completed)}</td>
              <td className="text-right">{n(`byDay.${d.date}.areaM2`, d.areaM2, { unit: "㎡" })}</td>
              <td className="text-right">{n(`byDay.${d.date}.durationMin`, d.durationMin, { unit: "분" })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function FloorZoneRobotTables({ a, n }: { a: ReportAggregates; n: NumFn }) {
  return (
    <>
      <H>층별 실적</H>
      <table className="data mb-4">
        <thead><tr><th>층</th><th className="text-right">작업 건수</th><th className="text-right">누적 면적</th><th className="text-right">작업 시간</th></tr></thead>
        <tbody>
          {a.byFloor.map((f) => (
            <tr key={f.floorId}>
              <td>{f.floorName}</td>
              <td className="text-right">{n(`byFloor.${f.floorId}.runs`, f.runs)}</td>
              <td className="text-right">{n(`byFloor.${f.floorId}.areaM2`, f.areaM2, { unit: "㎡" })}</td>
              <td className="text-right">{n(`byFloor.${f.floorId}.durationMin`, f.durationMin, { unit: "분" })}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {a.byZone.length > 0 && (
        <>
          <H>구역별 실적</H>
          <table className="data mb-4">
            <thead><tr><th>층</th><th>구역</th><th className="text-right">작업 건수</th><th className="text-right">배분 면적(근사)</th></tr></thead>
            <tbody>
              {a.byZone.map((z) => (
                <tr key={z.zoneId}>
                  <td>{z.floorName}</td>
                  <td>{z.zoneName}</td>
                  <td className="text-right">{n(`byZone.${z.zoneId}.runs`, z.runs)}</td>
                  <td className="text-right">{n(`byZone.${z.zoneId}.areaM2`, z.areaM2, { unit: "㎡" })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <H>로봇별 실적</H>
      {a.byRobot.length === 0 ? (
        <p className="text-sm text-gray-500 mb-4">작업 실적이 없습니다.</p>
      ) : (
        <table className="data mb-4">
          <thead><tr><th>로봇</th><th>모델</th><th className="text-right">작업</th><th className="text-right">정상 완료</th><th className="text-right">누적 면적</th></tr></thead>
          <tbody>
            {a.byRobot.map((b) => (
              <tr key={b.robotId}>
                <td>{b.name}</td>
                <td>{b.model}</td>
                <td className="text-right">{n(`byRobot.${b.robotId}.runs`, b.runs)}</td>
                <td className="text-right">{n(`byRobot.${b.robotId}.completed`, b.completed)}</td>
                <td className="text-right">{n(`byRobot.${b.robotId}.areaM2`, b.areaM2, { unit: "㎡" })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function IncidentsInspections({ a, n }: { a: ReportAggregates; n: NumFn }) {
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
          <tbody>
            {a.inspections.map((x) => (
              <tr key={x.item}>
                <td>{x.item}</td>
                <td className="text-right">{n(`inspections.${x.item}.done`, x.done)} / {n(`inspections.${x.item}.total`, x.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function WorkLog({ reportId, rows, editable }: { reportId: string; rows: NonNullable<ReportContent["workLog"]>; editable: boolean }) {
  return (
    <>
      <H>작업 일지</H>
      {editable ? (
        <div className="print:hidden mb-4">
          <WorkLogEditor reportId={reportId} rows={rows} />
        </div>
      ) : null}
      <table className={`data mb-4 ${editable ? "hidden print:table" : ""}`}>
        <thead><tr><th className="w-24">구분</th><th className="w-32">담당</th><th>작업 내용</th></tr></thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={3} className="text-gray-400">(작성 전)</td></tr>
          ) : (
            rows.map((w, i) => (
              <tr key={i}>
                <td className="font-medium">{w.part}</td>
                <td>{w.staff}</td>
                <td className="whitespace-pre-wrap">{w.content.split("\n").filter(Boolean).map((l, j) => <div key={j}>○ {l}</div>)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </>
  );
}

/** 설치 보고서: 실적보다 "어떻게 청소할지" 계획 — 단계 일정, 지도 위 청소 범위, 주간 예약, 사진, 작업 일지. */
function InstallationBody({ r, a, editable, photos }: { r: Awaited<ReturnType<typeof getReport>>; a: ReportAggregates; editable: boolean; photos: Awaited<ReturnType<typeof listPhotos>> }) {
  const ins = a.installation;
  const labels = commentLabels(r.kind);
  const maps = ins?.maps ?? [];
  const weekly = ins?.weekly ?? [];
  const zoneCount = maps.reduce((s, m) => s + m.zones.length, 0);
  const zoneArea = maps.reduce((s, m) => s + m.zones.reduce((t, z) => t + z.areaM2, 0), 0);
  const weeklyRuns = weekly.reduce((s, w) => s + w.daysOfWeek.length, 0);
  const weeklyMin = weekly.reduce((s, w) => s + w.daysOfWeek.length * (w.durationMin ?? 0), 0);
  return (
    <>
      <Page>
        <H>현장 사진 · 청소 범위</H>
        <PhotoPanel reportId={r.id} photos={photos} editable={editable} />
        <div className="mt-3 space-y-4">
          {maps.length === 0 ? <p className="text-sm text-gray-500">등록된 지도·청소 구역이 없습니다. 관리 설정에서 제조사 지도를 가져오면 청소 범위가 표시됩니다.</p> : maps.map((m) => <ZoneMap key={m.floorId} map={m} />)}
        </div>
      </Page>
      <Page>
        <H>주간 청소 계획(예약)</H>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm mb-3">
          <div><div className="text-xs text-gray-500">설치 로봇</div><div className="text-lg font-bold">{ins?.robots.length ?? 0}대</div></div>
          <div><div className="text-xs text-gray-500">청소 구역</div><div className="text-lg font-bold">{zoneCount}개</div><div className="text-xs text-gray-500">합계 {zoneArea.toLocaleString()}㎡</div></div>
          <div><div className="text-xs text-gray-500">주간 예약</div><div className="text-lg font-bold">{weeklyRuns}회</div></div>
          <div><div className="text-xs text-gray-500">주간 예상 청소 시간</div><div className="text-lg font-bold">{weeklyMin ? hm(weeklyMin) : "미정"}</div><div className="text-xs text-gray-500">최근 실적 평균 기준</div></div>
        </div>
        <WeeklyTimeline rows={weekly} />
        <H>설치 로봇</H>
        <table className="data mt-1 mb-2">
          <thead><tr><th>로봇</th><th>모델</th><th>배치 층</th></tr></thead>
          <tbody>{(ins?.robots ?? []).map((x) => <tr key={x.name}><td>{x.name}</td><td>{x.model}</td><td>{x.floorName}</td></tr>)}</tbody>
        </table>
      </Page>
      <Page>
        <WorkLog reportId={r.id} rows={r.content.workLog ?? []} editable={editable} />
        <H>{labels.incompleteReasons}</H>
        <Text value={r.comments.incompleteReasons} />
      </Page>
    </>
  );
}

export default async function ReportPage({ params, searchParams }: { params: Promise<{ reportId: string }>; searchParams: Promise<{ edit?: string }> }) {
  const { reportId } = await params;
  const sp = await searchParams;
  const user = await getCurrentUser();
  let r;
  try {
    r = await getReport(user, reportId);
  } catch (e) {
    return <AccessDenied reason={e instanceof AppError ? e.message : "접근할 수 없습니다."} />;
  }
  const customer = isCustomer(user);
  const editable = canEditReports(user) && (r.status === "DRAFT" || r.status === "REVIEW");
  const edit = editable && sp.edit === "1";
  const a = effectiveAggregates(r);
  const adj = r.adjustments ?? {};
  const n = makeNum(r.id, r.aggregates, adj, edit, !customer); // 고객에게는 원래 집계값을 보여 주지 않는다
  const users = await listUsers();
  const userName = (id: string | null) => (id === "system" ? "자동 작성" : id ? (users.find((u) => u.id === id)?.name ?? id) : "-");
  const frozen = r.status === "CONFIRMED" || r.status === "PUBLISHED";
  const versions = await listVersions(user, r.siteId, r);
  const canConfirm = await canConfirmReports(user);
  const photos = await listPhotos(user, r.id);
  const labels = commentLabels(r.kind);
  const period = periodText(r);
  const adjustedCount = Object.keys(adj).length;
  const installation = r.kind === "INSTALLATION";
  // 이 기능 전에 만든 보고서는 단계 일정·작업 일지가 비어 있다 → 기본값으로 보여 주고, 저장하면 보고서에 들어간다
  r = { ...r, content: { ...defaultContent(r), ...r.content } };

  return (
    <>
      <div className="no-print">
        <PageTitle
          title={`${r.title} — ${r.siteName}`}
          subtitle={
            <>
              {period} · v{r.version} <ReportStatusBadge status={r.status} /> · 집계 기준 {formatDateTime(r.aggregates.generatedAt)} · 작성 {userName(r.createdBy)}
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
              {editable && !installation && (
                <Link href={edit ? `/reports/${r.id}` : `/reports/${r.id}?edit=1`} className={`inline-flex items-center rounded border px-3 py-1.5 text-sm ${edit ? "bg-amber-100 border-amber-400" : "bg-white border-gray-300"}`}>
                  {edit ? "수치 수정 끝내기" : "수치 수정"}
                </Link>
              )}
              <PrintButton />
              <a href={`/api/reports/${r.id}/export?format=pptx`} download className="inline-flex items-center rounded border border-gray-300 bg-white px-3 py-1.5 text-sm">PPT</a>
              <a href={`/api/reports/${r.id}/export?format=xlsx`} download className="inline-flex items-center rounded border border-gray-300 bg-white px-3 py-1.5 text-sm">Excel</a>
              <Link href={`/reports?site=${r.siteId}`} className="text-sm underline">목록</Link>
            </div>
          }
        />
        {frozen && <div className="mb-3"><Notice tone="info">확정본입니다. 집계값·수정한 수치·의견·사진은 확정 시점으로 고정되어 바뀌지 않습니다.{!customer && r.lateRuns > 0 ? ` 집계 이후 수신된 실적 ${r.lateRuns}건은 새 버전에서 반영할 수 있습니다.` : ""}</Notice></div>}
        {!frozen && !customer && !installation && localDateKey(r.aggregates.generatedAt) <= r.periodEnd && <div className="mb-3"><Notice tone="warn">대상 기간이 끝나기 전에 집계한 초안입니다. 기간이 끝난 뒤 재집계하세요.</Notice></div>}
        {edit && <div className="mb-3"><Notice tone="warn">수치 수정 모드: 칸을 고친 뒤 벗어나면 저장됩니다. 원래 집계값은 보존되고 감사 기록이 남습니다. 고객 화면에는 * 로 표시됩니다.</Notice></div>}
        {!customer && (
          <div className="mb-4">
            <ReportWorkflow reportId={r.id} status={r.status} canEdit={canEditReports(user)} canConfirm={canConfirm} lateRuns={r.lateRuns} isLatest={r.isLatestVersion} />
          </div>
        )}
      </div>

      {/* ---- 1쪽: 표지 요약 + 종합 의견 ---- */}
      <Page>
        <div className="flex justify-between items-start border-b pb-2 mb-3">
          <div>
            <div className="text-xs text-gray-500">청소로봇 운영 보고서</div>
            <h2 className="text-xl font-bold text-navy">{r.siteName} · {r.title}</h2>
            <div className="text-sm text-gray-600">대상 기간 {period}{a.installation ? ` · 설치일 ${a.installation.installedOn}` : ""}</div>
          </div>
          <div className="text-right text-xs text-gray-500">
            v{r.version} · {r.status === "PUBLISHED" ? "확정본" : r.status === "CONFIRMED" ? "확정(미공개)" : "초안 — 확정 전"}
            <br />집계 {formatDateTime(r.aggregates.generatedAt)}
          </div>
        </div>
        {installation ? (
          <div className="mb-4">
            <H>단계 일정</H>
            <PhaseTimeline phases={r.content.phases ?? []} />
            {editable && (
              <details className="mt-2 print:hidden">
                <summary className="text-xs text-navy cursor-pointer">단계 일정 고치기</summary>
                <div className="mt-2"><PhaseEditor reportId={r.id} phases={r.content.phases ?? []} /></div>
              </details>
            )}
          </div>
        ) : (
          <SummaryStats a={a} n={n} />
        )}
        <H>{labels.overallOpinion}</H>
        <div className="print:hidden">
          <CommentsEditor reportId={r.id} kind={r.kind} comments={r.comments} editable={editable} />
        </div>
        <div className="hidden print:block text-sm whitespace-pre-wrap">{r.comments.overallOpinion || "(없음)"}</div>
        {!installation && a.unsupportedMetrics.length > 0 && (
          <div className="mt-3 text-xs text-gray-500">
            <div className="font-medium">지표 주석</div>
            <ul className="list-disc ml-4">{a.unsupportedMetrics.map((m) => <li key={m}>{m}</li>)}</ul>
          </div>
        )}
      </Page>

      {installation ? (
        <InstallationBody r={r} a={a} editable={editable} photos={photos} />
      ) : r.kind === "DAILY" ? (
        <>
          <Page>
            <WorkLog reportId={r.id} rows={r.content.workLog ?? []} editable={editable} />
            <H>작업 목록</H>
            <RunListTable a={a} />
            <H>계획 대비 수행</H>
            <PlanTable a={a} n={n} />
            <H>{labels.incompleteReasons}</H>
            <Text value={r.comments.incompleteReasons} />
          </Page>
          <Page>
            <IncidentsInspections a={a} n={n} />
          </Page>
        </>
      ) : (
        <>
          <Page>
            <H>계획 대비 수행</H>
            <PlanTable a={a} n={n} />
            <ByDayTable a={a} n={n} />
            <FloorZoneRobotTables a={a} n={n} />
            <H>{labels.incompleteReasons}</H>
            <Text value={r.comments.incompleteReasons} />
          </Page>
          <Page>
            <IncidentsInspections a={a} n={n} />
          </Page>
        </>
      )}

      {!installation && (photos.length > 0 || editable) && (
        <Page>
          <H>현장 사진</H>
          <PhotoPanel reportId={r.id} photos={photos} editable={editable} />
        </Page>
      )}

      {/* ---- 마지막 쪽: 의견 ---- */}
      <Page>
        <H>{labels.improvements}</H>
        <Text value={r.comments.improvements} />
        <H>{labels.focusZones}</H>
        <Text value={r.comments.focusZones} />
        <H>{labels.nextMonthPlan}</H>
        <Text value={r.comments.nextMonthPlan} />
        <div className="text-xs text-gray-500 border-t pt-2">
          {adjustedCount > 0 && <div>* 표시 수치는 담당자가 현장 기록으로 확인해 보정한 값입니다({adjustedCount}건).</div>}
          실적 포함 기준: {formatDate(a.includesRunsReceivedUntil)}까지 수신분 · 날짜는 사업장 시간대 기준{r.siteIsSample ? " · 샘플 데이터" : ""}
        </div>
      </Page>
    </>
  );
}
