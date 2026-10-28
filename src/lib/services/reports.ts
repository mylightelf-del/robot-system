import type { ActualRun, ReportComments, ReportVersion, User } from "@/lib/domain/types";
import { accessibleSiteIds, assertActive, assertSiteAccess, canConfirmReports, canEditReports, isCustomer } from "@/lib/auth/authz";
import { getStore } from "@/lib/store/store";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/util/errors";
import { localMonthKey, nowIso } from "@/lib/util/time";
import { audit } from "./audit";
import { computeAggregates } from "./reportAggregates";

export interface ReportRow extends ReportVersion {
  siteName: string;
  lateRuns: number; // 집계 이후 수신된 해당 월 실적 건수
  isLatestVersion: boolean;
}

function lateRunsFor(r: ReportVersion): number {
  const data = getStore();
  const site = data.sites.find((s) => s.id === r.siteId)!;
  return data.actualRuns.filter((x) => x.siteId === r.siteId && localMonthKey(x.startedAt, site.timezone) === r.month && x.receivedAt > r.aggregates.generatedAt).length;
}

function toRow(r: ReportVersion): ReportRow {
  const data = getStore();
  const latest = Math.max(...data.reports.filter((x) => x.siteId === r.siteId && x.month === r.month).map((x) => x.version));
  return { ...r, siteName: data.sites.find((s) => s.id === r.siteId)?.name ?? r.siteId, lateRuns: lateRunsFor(r), isLatestVersion: r.version === latest };
}

/** 고객은 확정·공개본만 본다. 초안·검토본은 목록에도 나오지 않는다. */
export function listReports(user: User, siteId?: string): ReportRow[] {
  assertActive(user);
  const data = getStore();
  const siteIds = accessibleSiteIds(data, user);
  if (siteId) assertSiteAccess(data, user, siteId);
  const customer = isCustomer(user);
  return data.reports
    .filter((r) => siteIds.includes(r.siteId) && (!siteId || r.siteId === siteId))
    .filter((r) => !customer || r.status === "PUBLISHED")
    .sort((a, b) => b.month.localeCompare(a.month) || a.siteId.localeCompare(b.siteId) || b.version - a.version)
    .map(toRow);
}

export function getReport(user: User, reportId: string): ReportRow {
  assertActive(user);
  const data = getStore();
  const r = data.reports.find((x) => x.id === reportId);
  // 존재 여부를 숨기기 위해 권한 없음과 미존재를 같은 메시지로 처리
  if (!r) throw new NotFoundError("보고서를 찾을 수 없거나 접근 권한이 없습니다.");
  try {
    assertSiteAccess(data, user, r.siteId);
  } catch {
    throw new NotFoundError("보고서를 찾을 수 없거나 접근 권한이 없습니다.");
  }
  if (isCustomer(user) && r.status !== "PUBLISHED") throw new NotFoundError("보고서를 찾을 수 없거나 접근 권한이 없습니다.");
  return toRow(r);
}

function emptyComments(): ReportComments {
  return { overallOpinion: "", incompleteReasons: "", improvements: "", focusZones: "", nextMonthPlan: "" };
}

/** 초안 생성(자동 집계). 같은 월에 확정본이 있으면 새 버전으로 만든다. */
export function createDraft(user: User, siteId: string, month: string): ReportVersion {
  const data = getStore();
  assertSiteAccess(data, user, siteId);
  if (!canEditReports(user)) throw new ForbiddenError("보고서 작성은 현장/본사 담당자만 할 수 있습니다.");
  if (!/^\d{4}-\d{2}$/.test(month)) throw new ValidationError("월은 YYYY-MM 형식입니다.");
  const existing = data.reports.filter((r) => r.siteId === siteId && r.month === month);
  const openDraft = existing.find((r) => r.status === "DRAFT" || r.status === "REVIEW");
  if (openDraft) throw new ValidationError("이미 작성 중인 초안/검토본이 있습니다. 그 버전을 이어서 작업하세요.");
  const version = existing.length ? Math.max(...existing.map((r) => r.version)) + 1 : 1;
  const prev = existing.sort((a, b) => b.version - a.version)[0];
  const now = nowIso();
  const r: ReportVersion = {
    id: `rpt-${siteId}-${month}-v${version}`,
    siteId,
    month,
    version,
    status: "DRAFT",
    aggregates: computeAggregates(data, siteId, month, now),
    comments: prev ? { ...prev.comments } : emptyComments(),
    createdAt: now,
    createdBy: user.id,
    reviewedAt: null,
    reviewedBy: null,
    confirmedAt: null,
    confirmedBy: null,
    publishedAt: null,
  };
  data.reports.push(r);
  audit(data, user, { siteId, robotId: null, action: "REPORT:CREATE_DRAFT", params: { month, version }, result: "OK", detail: prev ? `기존 v${prev.version} 은 유지, 새 버전 작성` : null, vendorTraceId: null });
  return r;
}

/** 초안 재집계: 확정 전에만 가능. 확정본은 절대 재집계로 변경하지 않는다. */
export function recomputeDraft(user: User, reportId: string): ReportVersion {
  const data = getStore();
  const r = data.reports.find((x) => x.id === reportId);
  if (!r) throw new NotFoundError();
  assertSiteAccess(data, user, r.siteId);
  if (!canEditReports(user)) throw new ForbiddenError("보고서 수정 권한이 없습니다.");
  if (r.status !== "DRAFT" && r.status !== "REVIEW") throw new ValidationError("확정된 보고서는 재집계할 수 없습니다. 새 버전을 작성하세요.");
  r.aggregates = computeAggregates(data, r.siteId, r.month, nowIso());
  audit(data, user, { siteId: r.siteId, robotId: null, action: "REPORT:RECOMPUTE", params: { reportId }, result: "OK", detail: null, vendorTraceId: null });
  return r;
}

export function updateComments(user: User, reportId: string, comments: Partial<ReportComments>): ReportVersion {
  const data = getStore();
  const r = data.reports.find((x) => x.id === reportId);
  if (!r) throw new NotFoundError();
  assertSiteAccess(data, user, r.siteId);
  if (!canEditReports(user)) throw new ForbiddenError("보고서 수정 권한이 없습니다.");
  if (r.status !== "DRAFT" && r.status !== "REVIEW") throw new ValidationError("확정된 보고서의 의견은 수정할 수 없습니다. 새 버전을 작성하세요.");
  r.comments = { ...r.comments, ...comments };
  audit(data, user, { siteId: r.siteId, robotId: null, action: "REPORT:UPDATE_COMMENTS", params: { reportId }, result: "OK", detail: null, vendorTraceId: null });
  return r;
}

export function submitForReview(user: User, reportId: string): ReportVersion {
  const data = getStore();
  const r = data.reports.find((x) => x.id === reportId);
  if (!r) throw new NotFoundError();
  assertSiteAccess(data, user, r.siteId);
  if (!canEditReports(user)) throw new ForbiddenError("보고서 검토 요청 권한이 없습니다.");
  if (r.status !== "DRAFT") throw new ValidationError("초안 상태에서만 검토 요청할 수 있습니다.");
  if (!r.comments.overallOpinion.trim()) throw new ValidationError("종합 의견을 작성한 뒤 검토 요청하세요.");
  r.status = "REVIEW";
  audit(data, user, { siteId: r.siteId, robotId: null, action: "REPORT:SUBMIT_REVIEW", params: { reportId }, result: "OK", detail: null, vendorTraceId: null });
  return r;
}

export function returnToDraft(user: User, reportId: string, reason: string): ReportVersion {
  const data = getStore();
  const r = data.reports.find((x) => x.id === reportId);
  if (!r) throw new NotFoundError();
  assertSiteAccess(data, user, r.siteId);
  if (!canConfirmReports(data, user)) throw new ForbiddenError("검토 반려 권한이 없습니다.");
  if (r.status !== "REVIEW") throw new ValidationError("검토 중인 보고서만 반려할 수 있습니다.");
  r.status = "DRAFT";
  audit(data, user, { siteId: r.siteId, robotId: null, action: "REPORT:RETURN", params: { reportId, reason }, result: "OK", detail: null, vendorTraceId: null });
  return r;
}

/** 확정: 집계값과 의견을 스냅샷으로 고정. 이후 재집계·수정 불가. */
export function confirmReport(user: User, reportId: string): ReportVersion {
  const data = getStore();
  const r = data.reports.find((x) => x.id === reportId);
  if (!r) throw new NotFoundError();
  assertSiteAccess(data, user, r.siteId);
  if (!canConfirmReports(data, user)) throw new ForbiddenError("보고서 확정 권한이 없습니다(본사 관리자 또는 설정으로 허용된 현장 담당자).");
  if (r.status !== "REVIEW") throw new ValidationError("검토 중인 보고서만 확정할 수 있습니다.");
  const now = nowIso();
  r.status = "CONFIRMED";
  r.reviewedAt = now;
  r.reviewedBy = user.id;
  r.confirmedAt = now;
  r.confirmedBy = user.id;
  // 스냅샷 보존: 깊은 복사로 외부 참조와 분리
  r.aggregates = JSON.parse(JSON.stringify(r.aggregates));
  r.comments = { ...r.comments };
  audit(data, user, { siteId: r.siteId, robotId: null, action: "REPORT:CONFIRM", params: { reportId, version: r.version }, result: "OK", detail: "스냅샷 고정", vendorTraceId: null });
  return r;
}

export function publishReport(user: User, reportId: string): ReportVersion {
  const data = getStore();
  const r = data.reports.find((x) => x.id === reportId);
  if (!r) throw new NotFoundError();
  assertSiteAccess(data, user, r.siteId);
  if (!canConfirmReports(data, user)) throw new ForbiddenError("고객 공개 권한이 없습니다.");
  if (r.status !== "CONFIRMED") throw new ValidationError("확정된 보고서만 고객에게 공개할 수 있습니다.");
  r.status = "PUBLISHED";
  r.publishedAt = nowIso();
  audit(data, user, { siteId: r.siteId, robotId: null, action: "REPORT:PUBLISH", params: { reportId }, result: "OK", detail: null, vendorTraceId: null });
  return r;
}

/** 실적 조회(필터). 고객도 자기 사업장 실적은 볼 수 있다. */
export interface RunRow extends ActualRun {
  robotName: string;
  siteName: string;
  floorName: string;
  taskName: string | null;
}

export function listRuns(user: User, opts: { siteId?: string; robotId?: string; fromIso: string; toIso: string }): RunRow[] {
  assertActive(user);
  const data = getStore();
  const siteIds = accessibleSiteIds(data, user);
  if (opts.siteId) assertSiteAccess(data, user, opts.siteId);
  return data.actualRuns
    .filter((r) => siteIds.includes(r.siteId) && (!opts.siteId || r.siteId === opts.siteId) && (!opts.robotId || r.robotId === opts.robotId) && r.startedAt >= opts.fromIso && r.startedAt <= opts.toIso)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map((r) => ({
      ...r,
      robotName: data.robots.find((x) => x.id === r.robotId)?.name ?? r.robotId,
      siteName: data.sites.find((s) => s.id === r.siteId)?.name ?? r.siteId,
      floorName: data.floors.find((f) => f.id === r.floorId)?.name ?? r.floorId,
      taskName: r.taskId ? (data.tasks.find((t) => t.id === r.taskId)?.name ?? r.taskId) : null,
    }));
}
