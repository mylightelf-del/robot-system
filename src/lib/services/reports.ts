import { and, desc, eq, gt, gte, inArray, lte, sql } from "drizzle-orm";
import type { ActualRun, ReportComments, ReportVersion, User } from "@/lib/domain/types";
import { accessibleSiteIds, assertActive, assertSiteAccess, canConfirmReports, canEditReports, isCustomer } from "@/lib/auth/authz";
import { getDb, schema } from "@/lib/db/client";
import { getSite, listSitesByIds, type DbLike } from "@/lib/db/repo";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/util/errors";
import { localToUtcIso, nowIso, shiftMonth } from "@/lib/util/time";
import { audit } from "./audit";
import { computeAggregates } from "./reportAggregates";
import { loadAggregateInput } from "./reportData";

export interface ReportRow extends ReportVersion {
  siteName: string;
  lateRuns: number; // 집계 이후 수신된 해당 월 실적 건수
  isLatestVersion: boolean;
}

function monthRangeFor(month: string, tz: string): { fromIso: string; toIso: string } {
  return { fromIso: localToUtcIso(`${month}-01`, "00:00", tz), toIso: localToUtcIso(`${shiftMonth(month, 1)}-01`, "00:00", tz) };
}

async function lateRunsFor(r: ReportVersion, db: DbLike): Promise<number> {
  const site = (await getSite(r.siteId, db))!;
  const { fromIso, toIso } = monthRangeFor(r.month, site.timezone);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.actualRuns)
    .where(and(eq(schema.actualRuns.siteId, r.siteId), gte(schema.actualRuns.startedAt, fromIso), lte(schema.actualRuns.startedAt, toIso), gt(schema.actualRuns.receivedAt, r.aggregates.generatedAt)));
  return row?.n ?? 0;
}

async function toRow(r: ReportVersion, db: DbLike): Promise<ReportRow> {
  const [latest] = await db.select({ v: sql<number>`max(${schema.reportVersions.version})::int` }).from(schema.reportVersions).where(and(eq(schema.reportVersions.siteId, r.siteId), eq(schema.reportVersions.month, r.month)));
  const site = await getSite(r.siteId, db);
  return { ...r, siteName: site?.name ?? r.siteId, lateRuns: await lateRunsFor(r, db), isLatestVersion: r.version === (latest?.v ?? r.version) };
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
    .orderBy(desc(schema.reportVersions.month), schema.reportVersions.siteId, desc(schema.reportVersions.version));
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

/** 같은 사업장·월의 버전 목록(고객은 공개본만). */
export async function listVersions(user: User, siteId: string, month: string): Promise<ReportVersion[]> {
  const db = getDb();
  await assertSiteAccess(user, siteId, db);
  return db
    .select()
    .from(schema.reportVersions)
    .where(and(eq(schema.reportVersions.siteId, siteId), eq(schema.reportVersions.month, month), isCustomer(user) ? eq(schema.reportVersions.status, "PUBLISHED") : undefined))
    .orderBy(schema.reportVersions.version);
}

function emptyComments(): ReportComments {
  return { overallOpinion: "", incompleteReasons: "", improvements: "", focusZones: "", nextMonthPlan: "" };
}

/** 초안 생성(자동 집계). 같은 월에 확정본이 있으면 새 버전으로 만든다. */
export async function createDraft(user: User, siteId: string, month: string): Promise<ReportVersion> {
  const db = getDb();
  await assertSiteAccess(user, siteId, db);
  if (!canEditReports(user)) throw new ForbiddenError("보고서 작성은 현장/본사 담당자만 할 수 있습니다.");
  if (!/^\d{4}-\d{2}$/.test(month)) throw new ValidationError("월은 YYYY-MM 형식입니다.");
  const existing = await db.select().from(schema.reportVersions).where(and(eq(schema.reportVersions.siteId, siteId), eq(schema.reportVersions.month, month))).orderBy(desc(schema.reportVersions.version));
  const openDraft = existing.find((r) => r.status === "DRAFT" || r.status === "REVIEW");
  if (openDraft) throw new ValidationError("이미 작성 중인 초안/검토본이 있습니다. 그 버전을 이어서 작업하세요.");
  const version = existing.length ? existing[0].version + 1 : 1;
  const prev = existing[0];
  const now = nowIso();
  const input = await loadAggregateInput(siteId, db);
  const r: ReportVersion = {
    id: `rpt-${siteId}-${month}-v${version}`,
    siteId,
    month,
    version,
    status: "DRAFT",
    aggregates: computeAggregates(input, siteId, month, now),
    comments: prev ? { ...prev.comments } : emptyComments(),
    createdAt: now,
    createdBy: user.id,
    reviewedAt: null,
    reviewedBy: null,
    confirmedAt: null,
    confirmedBy: null,
    publishedAt: null,
  };
  await db.insert(schema.reportVersions).values(r);
  await audit(user, { siteId, robotId: null, action: "REPORT:CREATE_DRAFT", params: { month, version }, result: "OK", detail: prev ? `기존 v${prev.version} 은 유지, 새 버전 작성` : null, vendorTraceId: null }, db);
  return r;
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
  const aggregates = computeAggregates(await loadAggregateInput(r.siteId, db), r.siteId, r.month, nowIso());
  await db.update(schema.reportVersions).set({ aggregates }).where(eq(schema.reportVersions.id, reportId));
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
