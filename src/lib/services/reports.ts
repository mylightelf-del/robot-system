import { and, desc, eq, gt, gte, inArray, lt, lte, sql } from "drizzle-orm";
import type { ActualRun, ReportComments, ReportContent, ReportPhoto, ReportStatus, ReportVersion, User } from "@/lib/domain/types";
import { accessibleSiteIds, assertActive, assertSiteAccess, canConfirmReports, canEditReports, isCustomer } from "@/lib/auth/authz";
import { getDb, schema } from "@/lib/db/client";
import { getSite, listSitesByIds, type DbLike } from "@/lib/db/repo";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/util/errors";
import { localDateKey, localHourMinute, localToUtcIso, nowIso } from "@/lib/util/time";
import { applyAdjustments, isValidAdjustKey, originalValue } from "@/lib/reports/adjust";
import { newId } from "@/lib/util/random";
import { addDays, DRAFT_HOUR, isDateKey, monthAnniversary, parsePeriodKey, periodKey, reportSchedule, reportTitle, type ReportPeriod, type ScheduledReport } from "@/lib/reports/schedule";
import { audit } from "./audit";
import { computeAggregates } from "./reportAggregates";
import { loadAggregateInput } from "./reportData";

export interface ReportRow extends ReportVersion {
  title: string;
  siteName: string;
  siteIsSample: boolean;
  lateRuns: number; // 집계 이후 수신된 해당 기간 실적 건수
  isLatestVersion: boolean;
}

/** 자동 작성 주체(워커). 감사 기록·작성자 표시에 쓴다. */
export const SYSTEM_ACTOR = { id: "system", name: "시스템(자동 작성)" } as const;
/** 워커가 지난 일정을 자동으로 채우는 범위(일). 그보다 오래된 일정은 화면에서 직접 만든다. */
export const AUTO_DRAFT_LOOKBACK_DAYS = 7;

function periodRangeIso(p: Pick<ReportPeriod, "periodStart" | "periodEnd">, tz: string): { fromIso: string; toIso: string } {
  return { fromIso: localToUtcIso(p.periodStart, "00:00", tz), toIso: localToUtcIso(addDays(p.periodEnd, 1), "00:00", tz) };
}

const samePeriod = (p: Pick<ReportPeriod, "kind" | "periodStart" | "periodEnd">) =>
  and(eq(schema.reportVersions.kind, p.kind), eq(schema.reportVersions.periodStart, p.periodStart), eq(schema.reportVersions.periodEnd, p.periodEnd));

async function lateRunsFor(r: ReportVersion, db: DbLike): Promise<number> {
  const site = (await getSite(r.siteId, db))!;
  const { fromIso, toIso } = periodRangeIso(r, site.timezone);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.actualRuns)
    .where(and(eq(schema.actualRuns.siteId, r.siteId), gte(schema.actualRuns.startedAt, fromIso), lt(schema.actualRuns.startedAt, toIso), gt(schema.actualRuns.receivedAt, r.aggregates.generatedAt)));
  return row?.n ?? 0;
}

async function toRow(r: ReportVersion, db: DbLike): Promise<ReportRow> {
  const [latest] = await db
    .select({ v: sql<number>`max(${schema.reportVersions.version})::int` })
    .from(schema.reportVersions)
    .where(and(eq(schema.reportVersions.siteId, r.siteId), samePeriod(r)));
  const site = await getSite(r.siteId, db);
  return { ...r, title: reportTitle(r), siteName: site?.name ?? r.siteId, siteIsSample: site?.isSample ?? false, lateRuns: await lateRunsFor(r, db), isLatestVersion: r.version === (latest?.v ?? r.version) };
}

/** 고객은 확정·공개본만 본다. 초안·검토본은 목록에도 나오지 않는다. */
export async function listReports(user: User, siteId?: string): Promise<ReportRow[]> {
  assertActive(user);
  const db = getDb();
  const siteIds = await accessibleSiteIds(user, db);
  if (siteId) await assertSiteAccess(user, siteId, db);
  const ids = siteId ? [siteId] : siteIds;
  if (ids.length === 0) return [];
  const customer = isCustomer(user);
  const rows = await db
    .select()
    .from(schema.reportVersions)
    .where(and(inArray(schema.reportVersions.siteId, ids), customer ? eq(schema.reportVersions.status, "PUBLISHED") : undefined))
    .orderBy(desc(schema.reportVersions.periodEnd), schema.reportVersions.siteId, desc(schema.reportVersions.kind), desc(schema.reportVersions.version));
  const out: ReportRow[] = [];
  for (const r of rows) out.push(await toRow(r, db));
  return out;
}

export async function getReport(user: User, reportId: string): Promise<ReportRow> {
  assertActive(user);
  const db = getDb();
  const r = await db.query.reportVersions.findFirst({ where: eq(schema.reportVersions.id, reportId) });
  // 존재 여부를 숨기기 위해 권한 없음과 미존재를 같은 메시지로 처리
  if (!r) throw new NotFoundError("보고서를 찾을 수 없거나 접근 권한이 없습니다.");
  try {
    await assertSiteAccess(user, r.siteId, db);
  } catch {
    throw new NotFoundError("보고서를 찾을 수 없거나 접근 권한이 없습니다.");
  }
  if (isCustomer(user) && r.status !== "PUBLISHED") throw new NotFoundError("보고서를 찾을 수 없거나 접근 권한이 없습니다.");
  return toRow(r, db);
}

/** 같은 사업장·기간의 버전 목록(고객은 공개본만). */
export async function listVersions(user: User, siteId: string, period: Pick<ReportPeriod, "kind" | "periodStart" | "periodEnd">): Promise<ReportVersion[]> {
  const db = getDb();
  await assertSiteAccess(user, siteId, db);
  return db
    .select()
    .from(schema.reportVersions)
    .where(and(eq(schema.reportVersions.siteId, siteId), samePeriod(period), isCustomer(user) ? eq(schema.reportVersions.status, "PUBLISHED") : undefined))
    .orderBy(schema.reportVersions.version);
}

function emptyComments(): ReportComments {
  return { overallOpinion: "", incompleteReasons: "", improvements: "", focusZones: "", nextMonthPlan: "" };
}

/** 새 보고서의 기본 구조화 내용. 설치 보고서는 단계 일정(설치일 기준 기본값)과 작업 일지, 일간은 작업 일지. */
export function defaultContent(period: ReportPeriod): ReportContent {
  const workLog = [
    { part: "오전", staff: "", content: "" },
    { part: "오후", staff: "", content: "" },
    { part: "명일 계획", staff: "", content: "" },
  ];
  if (period.kind === "INSTALLATION") {
    const d0 = period.periodStart;
    return {
      phases: [
        { label: "제품 설치 및 맵핑", from: d0, to: d0 },
        { label: "운영 및 세부 조정", from: addDays(d0, 1), to: addDays(d0, 6) },
        { label: "안정화(주간 점검)", from: addDays(d0, 7), to: addDays(d0, 21) },
        { label: "정상 운영", from: addDays(d0, 22), to: monthAnniversary(d0, 1) },
      ],
      workLog,
    };
  }
  if (period.kind === "DAILY") return { workLog };
  return {};
}

/**
 * 버전 작성(공통). 같은 기간에 작성 중(초안·검토)인 버전이 있으면 거절한다. 확정본이 있으면 새 버전으로 만들고 기존 확정본은 그대로 둔다.
 */
async function createVersion(actor: Pick<User, "id" | "name">, siteId: string, period: ReportPeriod, db: DbLike, note?: string): Promise<ReportVersion> {
  const existing = await db.select().from(schema.reportVersions).where(and(eq(schema.reportVersions.siteId, siteId), samePeriod(period))).orderBy(desc(schema.reportVersions.version));
  const openDraft = existing.find((r) => r.status === "DRAFT" || r.status === "REVIEW");
  if (openDraft) throw new ValidationError("이미 작성 중인 초안/검토본이 있습니다. 그 버전을 이어서 작업하세요.");
  const version = existing.length ? existing[0].version + 1 : 1;
  const prev = existing[0];
  const now = nowIso();
  const input = await loadAggregateInput(siteId, db);
  const r: ReportVersion = {
    id: `rpt-${siteId}-${period.kind.toLowerCase()}-${period.periodStart}-${period.periodEnd}-v${version}`,
    siteId,
    kind: period.kind,
    seq: period.seq,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    version,
    status: "DRAFT",
    aggregates: computeAggregates(input, siteId, period, now),
    comments: prev ? { ...prev.comments } : emptyComments(),
    // 수치 보정은 새 버전에 넘기지 않는다(새 실적으로 다시 집계한 값이 기준). 단계 일정·작업 일지·사진은 이어받는다.
    adjustments: {},
    content: prev ? structuredClone(prev.content ?? {}) : defaultContent(period),
    createdAt: now,
    createdBy: actor.id,
    reviewedAt: null,
    reviewedBy: null,
    confirmedAt: null,
    confirmedBy: null,
    publishedAt: null,
  };
  await db.insert(schema.reportVersions).values(r);
  if (prev) {
    const photos = await db.select().from(schema.reportPhotos).where(eq(schema.reportPhotos.reportId, prev.id));
    for (const ph of photos) await db.insert(schema.reportPhotos).values({ ...ph, id: newId("rph"), reportId: r.id });
  }
  await audit(
    actor,
    { siteId, robotId: null, action: "REPORT:CREATE_DRAFT", params: { kind: period.kind, seq: period.seq, periodStart: period.periodStart, periodEnd: period.periodEnd, version }, result: "OK", detail: note ?? (prev ? `기존 v${prev.version} 은 유지, 새 버전 작성` : null), vendorTraceId: null },
    db,
  );
  return r;
}

function todayAt(site: { timezone: string }, now: string): string {
  return localDateKey(now, site.timezone);
}

/**
 * 일정에 있는 보고서의 초안을 만든다(자동 집계). periodKey 는 보고서 일정 화면이 넘겨준 "종류:시작~끝".
 * 기간이 시작된 일정만 만들 수 있다(진행 중인 기간은 오늘까지의 실적으로 미리 작성 → 재집계로 갱신).
 */
export async function createDraft(user: User, siteId: string, key: string): Promise<ReportVersion> {
  const db = getDb();
  await assertSiteAccess(user, siteId, db);
  if (!canEditReports(user)) throw new ForbiddenError("보고서 작성은 현장/본사 담당자만 할 수 있습니다.");
  const site = await getSite(siteId, db);
  if (!site) throw new NotFoundError("사업장을 찾을 수 없습니다.");
  if (!site.installedOn) throw new ValidationError("사업장 설치일이 등록되지 않았습니다. 관리 설정에서 설치일을 먼저 입력하세요.");
  const parsed = parsePeriodKey(key);
  if (!parsed) throw new ValidationError("보고서 기간 형식이 올바르지 않습니다.");
  const today = todayAt(site, nowIso());
  const entry = reportSchedule(site.installedOn, addDays(today, 40)).find((e) => periodKey(e) === key);
  if (!entry) throw new ValidationError("설치일 기준 보고서 일정에 없는 기간입니다.");
  if (entry.periodStart > today) throw new ValidationError("아직 시작되지 않은 기간입니다.");
  return createVersion(user, siteId, entry, db);
}

/** 확정·공개본 이후 늦게 들어온 실적을 반영하는 새 버전(같은 기간). */
export async function createNextVersion(user: User, reportId: string): Promise<ReportVersion> {
  const db = getDb();
  const r = await db.query.reportVersions.findFirst({ where: eq(schema.reportVersions.id, reportId) });
  if (!r) throw new NotFoundError();
  await assertSiteAccess(user, r.siteId, db);
  if (!canEditReports(user)) throw new ForbiddenError("보고서 작성은 현장/본사 담당자만 할 수 있습니다.");
  return createVersion(user, r.siteId, r, db);
}

/**
 * 워커: 설치일이 있는 사업장마다 초안 자동 작성일이 된 일정을 만든다(멱등).
 * - 설치 완료보고서는 설치 당일, 나머지는 기간 다음 날 DRAFT_HOUR 시(현지) 이후.
 * - 최근 AUTO_DRAFT_LOOKBACK_DAYS 일 안의 일정만 채운다(설치일을 과거로 입력해도 지난 보고서가 쏟아지지 않도록).
 * - 이미 어떤 버전이든 있으면 건너뛴다.
 */
export async function autoCreateScheduledDrafts(now: string = nowIso(), db: DbLike = getDb()): Promise<{ created: string[] }> {
  const sites = await db.select().from(schema.sites);
  const created: string[] = [];
  for (const site of sites) {
    if (!site.installedOn) continue;
    const today = todayAt(site, now);
    const hour = Number(localHourMinute(now, site.timezone).slice(0, 2));
    const due = reportSchedule(site.installedOn, today).filter(
      (e) => e.draftOn >= addDays(today, -AUTO_DRAFT_LOOKBACK_DAYS) && (e.kind === "INSTALLATION" || e.draftOn < today || hour >= DRAFT_HOUR),
    );
    for (const e of due) {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.reportVersions)
        .where(and(eq(schema.reportVersions.siteId, site.id), samePeriod(e)));
      if ((row?.n ?? 0) > 0) continue;
      const r = await createVersion(SYSTEM_ACTOR, site.id, e, db, "일정에 따라 자동 작성");
      created.push(r.id);
    }
  }
  return { created };
}

export type ScheduleState = "UPCOMING" | "IN_PROGRESS" | "NEEDS_DRAFT" | ReportStatus;

export interface ScheduleRow extends ScheduledReport {
  key: string;
  title: string;
  state: ScheduleState;
  reportId: string | null;
  version: number | null;
}

/** 사업장 보고서 일정표(담당자용): 지난 일정 + 다음 예정 일부, 각 일정의 최신 버전 상태. */
export async function getReportSchedule(user: User, siteId: string, now: string = nowIso()): Promise<{ installedOn: string | null; today: string; rows: ScheduleRow[]; others: ReportVersion[] }> {
  const db = getDb();
  await assertSiteAccess(user, siteId, db);
  if (!canEditReports(user)) throw new ForbiddenError("보고서 일정은 현장/본사 담당자만 볼 수 있습니다.");
  const site = await getSite(siteId, db);
  if (!site) throw new NotFoundError();
  const today = todayAt(site, now);
  const reports = await db.select().from(schema.reportVersions).where(eq(schema.reportVersions.siteId, siteId)).orderBy(desc(schema.reportVersions.version));
  if (!site.installedOn) return { installedOn: null, today, rows: [], others: reports };
  const all = reportSchedule(site.installedOn, addDays(today, 62));
  const past = all.filter((e) => e.periodStart <= today);
  const future = all.filter((e) => e.periodStart > today).slice(0, 2);
  const keys = new Set<string>();
  const rows: ScheduleRow[] = [...past, ...future].map((e) => {
    const key = periodKey(e);
    keys.add(key);
    const latest = reports.find((r) => periodKey(r) === key);
    const state: ScheduleState = latest ? latest.status : e.periodStart > today ? "UPCOMING" : e.draftOn > today ? "IN_PROGRESS" : "NEEDS_DRAFT";
    return { ...e, key, title: reportTitle(e), state, reportId: latest?.id ?? null, version: latest?.version ?? null };
  });
  // 설치일 변경 전 일정·달력 월 보고서 등 현재 일정에 없는 보고서(최신 버전만)
  const seen = new Set<string>();
  const others = reports.filter((r) => {
    const k = periodKey(r);
    if (keys.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { installedOn: site.installedOn, today, rows, others };
}

async function loadEditable(user: User, reportId: string, db: DbLike): Promise<ReportVersion> {
  const r = await db.query.reportVersions.findFirst({ where: eq(schema.reportVersions.id, reportId) });
  if (!r) throw new NotFoundError();
  await assertSiteAccess(user, r.siteId, db);
  if (!canEditReports(user)) throw new ForbiddenError("보고서 수정 권한이 없습니다.");
  return r;
}

/** 초안 재집계: 확정 전에만 가능. 확정본은 절대 재집계로 변경하지 않는다. */
export async function recomputeDraft(user: User, reportId: string): Promise<void> {
  const db = getDb();
  const r = await loadEditable(user, reportId, db);
  if (r.status !== "DRAFT" && r.status !== "REVIEW") throw new ValidationError("확정된 보고서는 재집계할 수 없습니다. 새 버전을 작성하세요.");
  const aggregates = computeAggregates(await loadAggregateInput(r.siteId, db), r.siteId, r, nowIso());
  // 수치 보정은 유지하되, 기록해 둔 '원래 집계'를 새 집계값으로 갱신하고 행이 사라진 보정은 지운다
  const adjustments = Object.fromEntries(
    Object.entries(r.adjustments ?? {})
      .map(([k, v]) => [k, { ...v, original: originalValue(aggregates, k) }] as const)
      .filter(([, v]) => v.original !== undefined)
      .map(([k, v]) => [k, { ...v, original: v.original ?? null }]),
  );
  await db.update(schema.reportVersions).set({ aggregates, adjustments }).where(eq(schema.reportVersions.id, reportId));
  await audit(user, { siteId: r.siteId, robotId: null, action: "REPORT:RECOMPUTE", params: { reportId }, result: "OK", detail: null, vendorTraceId: null }, db);
}

export async function updateComments(user: User, reportId: string, comments: Partial<ReportComments>): Promise<void> {
  const db = getDb();
  const r = await loadEditable(user, reportId, db);
  if (r.status !== "DRAFT" && r.status !== "REVIEW") throw new ValidationError("확정된 보고서의 의견은 수정할 수 없습니다. 새 버전을 작성하세요.");
  await db.update(schema.reportVersions).set({ comments: { ...r.comments, ...comments } }).where(eq(schema.reportVersions.id, reportId));
  await audit(user, { siteId: r.siteId, robotId: null, action: "REPORT:UPDATE_COMMENTS", params: { reportId }, result: "OK", detail: null, vendorTraceId: null }, db);
}

export async function submitForReview(user: User, reportId: string): Promise<void> {
  const db = getDb();
  const r = await loadEditable(user, reportId, db);
  if (r.status !== "DRAFT") throw new ValidationError("초안 상태에서만 검토 요청할 수 있습니다.");
  if (!r.comments.overallOpinion.trim()) throw new ValidationError("종합 의견을 작성한 뒤 검토 요청하세요.");
  await db.update(schema.reportVersions).set({ status: "REVIEW" }).where(eq(schema.reportVersions.id, reportId));
  await audit(user, { siteId: r.siteId, robotId: null, action: "REPORT:SUBMIT_REVIEW", params: { reportId }, result: "OK", detail: null, vendorTraceId: null }, db);
}

async function loadForConfirm(user: User, reportId: string, db: DbLike): Promise<ReportVersion> {
  const r = await db.query.reportVersions.findFirst({ where: eq(schema.reportVersions.id, reportId) });
  if (!r) throw new NotFoundError();
  await assertSiteAccess(user, r.siteId, db);
  if (!(await canConfirmReports(user, db))) throw new ForbiddenError("보고서 확정 권한이 없습니다(본사 관리자 또는 설정으로 허용된 현장 담당자).");
  return r;
}

export async function returnToDraft(user: User, reportId: string, reason: string): Promise<void> {
  const db = getDb();
  const r = await loadForConfirm(user, reportId, db);
  if (r.status !== "REVIEW") throw new ValidationError("검토 중인 보고서만 반려할 수 있습니다.");
  await db.update(schema.reportVersions).set({ status: "DRAFT" }).where(eq(schema.reportVersions.id, reportId));
  await audit(user, { siteId: r.siteId, robotId: null, action: "REPORT:RETURN", params: { reportId, reason }, result: "OK", detail: null, vendorTraceId: null }, db);
}

/** 확정: 집계값과 의견을 스냅샷으로 고정. 이후 재집계·수정 불가. */
export async function confirmReport(user: User, reportId: string): Promise<void> {
  const db = getDb();
  const r = await loadForConfirm(user, reportId, db);
  if (r.status !== "REVIEW") throw new ValidationError("검토 중인 보고서만 확정할 수 있습니다.");
  const now = nowIso();
  await db.update(schema.reportVersions).set({ status: "CONFIRMED", reviewedAt: now, reviewedBy: user.id, confirmedAt: now, confirmedBy: user.id }).where(eq(schema.reportVersions.id, reportId));
  await audit(user, { siteId: r.siteId, robotId: null, action: "REPORT:CONFIRM", params: { reportId, version: r.version }, result: "OK", detail: "스냅샷 고정", vendorTraceId: null }, db);
}

export async function publishReport(user: User, reportId: string): Promise<void> {
  const db = getDb();
  const r = await loadForConfirm(user, reportId, db);
  if (r.status !== "CONFIRMED") throw new ValidationError("확정된 보고서만 고객에게 공개할 수 있습니다.");
  await db.update(schema.reportVersions).set({ status: "PUBLISHED", publishedAt: nowIso() }).where(eq(schema.reportVersions.id, reportId));
  await audit(user, { siteId: r.siteId, robotId: null, action: "REPORT:PUBLISH", params: { reportId }, result: "OK", detail: null, vendorTraceId: null }, db);
}

/** 수치 보정(초안·검토 상태). value 가 null 이면 보정을 지우고 원래 집계값으로 되돌린다. 원래값·보정값·사용자를 감사 기록에 남긴다. */
export async function adjustNumber(user: User, reportId: string, key: string, value: number | null): Promise<void> {
  const db = getDb();
  const r = await loadEditable(user, reportId, db);
  if (r.status !== "DRAFT" && r.status !== "REVIEW") throw new ValidationError("확정된 보고서의 수치는 수정할 수 없습니다. 새 버전을 작성하세요.");
  if (!isValidAdjustKey(r.aggregates, key)) throw new ValidationError("수정할 수 없는 항목입니다.");
  if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1e9)) throw new ValidationError("0 이상의 숫자를 입력하세요.");
  if (key === "summary.completionRatePct" && value !== null && value > 100) throw new ValidationError("완료율은 0~100 사이입니다.");
  const original = originalValue(r.aggregates, key) ?? null;
  const adjustments = { ...(r.adjustments ?? {}) };
  if (value === null || value === original) delete adjustments[key];
  else adjustments[key] = { value, original, by: user.id, at: nowIso() };
  await db.update(schema.reportVersions).set({ adjustments }).where(eq(schema.reportVersions.id, reportId));
  await audit(user, { siteId: r.siteId, robotId: null, action: "REPORT:ADJUST", params: { reportId, key, original, value }, result: "OK", detail: value === null ? "보정 취소" : null, vendorTraceId: null }, db);
}

/** 표시·출력용 집계(보정 반영). */
export function effectiveAggregates(r: Pick<ReportVersion, "aggregates" | "adjustments">) {
  return applyAdjustments(r.aggregates, r.adjustments);
}

const MAX_TEXT = 2000;
/** 단계 일정·작업 일지 저장(초안·검토 상태). */
export async function updateContent(user: User, reportId: string, content: ReportContent): Promise<void> {
  const db = getDb();
  const r = await loadEditable(user, reportId, db);
  if (r.status !== "DRAFT" && r.status !== "REVIEW") throw new ValidationError("확정된 보고서는 수정할 수 없습니다. 새 버전을 작성하세요.");
  const next: ReportContent = { ...(r.content ?? {}) };
  if (content.phases !== undefined) {
    if (content.phases.length > 8) throw new ValidationError("단계는 8개까지입니다.");
    next.phases = content.phases.map((p) => {
      const label = String(p.label ?? "").trim().slice(0, 40);
      if (!label) throw new ValidationError("단계 이름을 입력하세요.");
      if (!isDateKey(p.from) || !isDateKey(p.to) || p.from > p.to) throw new ValidationError(`'${label}' 기간이 올바르지 않습니다.`);
      return { label, from: p.from, to: p.to };
    });
  }
  if (content.workLog !== undefined) {
    if (content.workLog.length > 20) throw new ValidationError("작업 일지는 20행까지입니다.");
    next.workLog = content.workLog.map((w) => ({ part: String(w.part ?? "").slice(0, 40), staff: String(w.staff ?? "").slice(0, 100), content: String(w.content ?? "").slice(0, MAX_TEXT) }));
  }
  await db.update(schema.reportVersions).set({ content: next }).where(eq(schema.reportVersions.id, reportId));
  await audit(user, { siteId: r.siteId, robotId: null, action: "REPORT:UPDATE_CONTENT", params: { reportId, parts: Object.keys(content) }, result: "OK", detail: null, vendorTraceId: null }, db);
}

// ---- 사진 ----
export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
export const PHOTO_MAX_COUNT = 30;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

function sniffPhotoType(buf: Buffer): string | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

/** 사진 목록(고객은 공개본만). 내용(바이트)은 /api/reports/photos/<id> 로 받는다. */
export async function listPhotos(user: User, reportId: string): Promise<ReportPhoto[]> {
  const r = await getReport(user, reportId);
  const db = getDb();
  const rows = await db
    .select({ id: schema.reportPhotos.id, reportId: schema.reportPhotos.reportId, caption: schema.reportPhotos.caption, contentType: schema.reportPhotos.contentType, sort: schema.reportPhotos.sort, createdAt: schema.reportPhotos.createdAt, createdBy: schema.reportPhotos.createdBy })
    .from(schema.reportPhotos)
    .where(eq(schema.reportPhotos.reportId, r.id))
    .orderBy(schema.reportPhotos.sort, schema.reportPhotos.createdAt);
  return rows;
}

export async function addPhoto(user: User, reportId: string, input: { caption: string; data: Buffer }): Promise<ReportPhoto> {
  const db = getDb();
  const r = await loadEditable(user, reportId, db);
  if (r.status !== "DRAFT" && r.status !== "REVIEW") throw new ValidationError("확정된 보고서에는 사진을 추가할 수 없습니다. 새 버전을 작성하세요.");
  if (input.data.length === 0) throw new ValidationError("빈 파일입니다.");
  if (input.data.length > PHOTO_MAX_BYTES) throw new ValidationError(`사진은 ${PHOTO_MAX_BYTES / 1024 / 1024}MB 이하만 올릴 수 있습니다.`);
  const contentType = sniffPhotoType(input.data);
  if (!contentType || !PHOTO_TYPES.includes(contentType)) throw new ValidationError("JPEG·PNG·WebP 사진만 올릴 수 있습니다.");
  const [cnt] = await db.select({ n: sql<number>`count(*)::int`, max: sql<number>`coalesce(max(${schema.reportPhotos.sort}), 0)::int` }).from(schema.reportPhotos).where(eq(schema.reportPhotos.reportId, reportId));
  if ((cnt?.n ?? 0) >= PHOTO_MAX_COUNT) throw new ValidationError(`사진은 보고서당 ${PHOTO_MAX_COUNT}장까지입니다.`);
  const row = { id: newId("rph"), reportId, caption: input.caption.trim().slice(0, 60), contentType, data: input.data, sort: (cnt?.max ?? 0) + 1, createdAt: nowIso(), createdBy: user.id };
  await db.insert(schema.reportPhotos).values(row);
  await audit(user, { siteId: r.siteId, robotId: null, action: "REPORT:PHOTO_ADD", params: { reportId, photoId: row.id, bytes: input.data.length }, result: "OK", detail: row.caption || null, vendorTraceId: null }, db);
  const { data: _d, ...meta } = row;
  return meta;
}

async function loadPhotoForEdit(user: User, photoId: string, db: DbLike) {
  const ph = await db.query.reportPhotos.findFirst({ where: eq(schema.reportPhotos.id, photoId), columns: { data: false } });
  if (!ph) throw new NotFoundError("사진을 찾을 수 없습니다.");
  const r = await loadEditable(user, ph.reportId, db);
  if (r.status !== "DRAFT" && r.status !== "REVIEW") throw new ValidationError("확정된 보고서의 사진은 바꿀 수 없습니다.");
  return { ph, r };
}

export async function updatePhotoCaption(user: User, photoId: string, caption: string): Promise<void> {
  const db = getDb();
  const { r } = await loadPhotoForEdit(user, photoId, db);
  await db.update(schema.reportPhotos).set({ caption: caption.trim().slice(0, 60) }).where(eq(schema.reportPhotos.id, photoId));
  await audit(user, { siteId: r.siteId, robotId: null, action: "REPORT:PHOTO_CAPTION", params: { reportId: r.id, photoId }, result: "OK", detail: null, vendorTraceId: null }, db);
}

export async function deletePhoto(user: User, photoId: string): Promise<void> {
  const db = getDb();
  const { r } = await loadPhotoForEdit(user, photoId, db);
  await db.delete(schema.reportPhotos).where(eq(schema.reportPhotos.id, photoId));
  await audit(user, { siteId: r.siteId, robotId: null, action: "REPORT:PHOTO_DELETE", params: { reportId: r.id, photoId }, result: "OK", detail: "초안에서 삭제", vendorTraceId: null }, db);
}

/** 사진 내용. 보고서 접근 권한(고객은 공개본만)을 그대로 따른다. */
export async function getPhotoData(user: User, photoId: string): Promise<{ contentType: string; data: Buffer }> {
  const db = getDb();
  const ph = await db.query.reportPhotos.findFirst({ where: eq(schema.reportPhotos.id, photoId) });
  if (!ph) throw new NotFoundError("사진을 찾을 수 없거나 접근 권한이 없습니다.");
  await getReport(user, ph.reportId); // 권한 없음은 NotFound 로 같게 처리된다
  return { contentType: ph.contentType, data: ph.data };
}

/** 내보내기용: 사진 내용 전체(권한 확인 후 호출). */
export async function loadPhotosWithData(reportId: string): Promise<(ReportPhoto & { data: Buffer })[]> {
  return getDb().select().from(schema.reportPhotos).where(eq(schema.reportPhotos.reportId, reportId)).orderBy(schema.reportPhotos.sort, schema.reportPhotos.createdAt);
}

/** 실적 조회(필터). 고객도 자기 사업장 실적은 볼 수 있다. */
export interface RunRow extends ActualRun {
  robotName: string;
  siteName: string;
  floorName: string;
  taskName: string | null;
}

export async function listRuns(user: User, opts: { siteId?: string; robotId?: string; fromIso: string; toIso: string }): Promise<RunRow[]> {
  assertActive(user);
  const db = getDb();
  const siteIds = await accessibleSiteIds(user, db);
  if (opts.siteId) await assertSiteAccess(user, opts.siteId, db);
  const ids = opts.siteId ? [opts.siteId] : siteIds;
  if (ids.length === 0) return [];
  const rows = await db
    .select({ r: schema.actualRuns, robotName: schema.robots.name, floorName: schema.floors.name, taskName: schema.registeredTasks.name })
    .from(schema.actualRuns)
    .leftJoin(schema.robots, eq(schema.robots.id, schema.actualRuns.robotId))
    .leftJoin(schema.floors, eq(schema.floors.id, schema.actualRuns.floorId))
    .leftJoin(schema.registeredTasks, eq(schema.registeredTasks.id, schema.actualRuns.taskId))
    .where(and(inArray(schema.actualRuns.siteId, ids), opts.robotId ? eq(schema.actualRuns.robotId, opts.robotId) : undefined, gte(schema.actualRuns.startedAt, opts.fromIso), lte(schema.actualRuns.startedAt, opts.toIso)))
    .orderBy(desc(schema.actualRuns.startedAt));
  const sites = new Map((await listSitesByIds(ids, db)).map((s) => [s.id, s.name]));
  return rows.map(({ r, robotName, floorName, taskName }) => {
    const { vendor: _v, vendorRobotId: _vr, rawPayload: _rp, ...run } = r;
    return { ...run, robotName: robotName ?? r.robotId, siteName: sites.get(r.siteId) ?? r.siteId, floorName: floorName ?? r.floorId, taskName: r.taskId ? (taskName ?? r.taskId) : null };
  });
}
