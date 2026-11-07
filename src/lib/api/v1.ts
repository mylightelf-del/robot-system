import { and, asc, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import { listSitesByIds, toStatus } from "@/lib/db/repo";
import { reportTitle } from "@/lib/reports/schedule";
import { authenticateApiToken } from "@/lib/services/apiTokens";
import { effectiveAggregates } from "@/lib/services/reports";

/**
 * 외부 연동용 읽기 전용 API(v1). 토큰 인증(Bearer), 사업장 범위는 토큰 발급 때 정한다.
 * 고객 화면과 같은 기준으로 **공개 가능한 필드만** 준다: 원시 오류·내부 메모·제조사 ID·초안 보고서는 내보내지 않는다.
 */
export const API_MAX_DAYS = 31;
export const API_MAX_ROWS = 1000;

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function error(status: number, message: string): Response {
  return json({ ok: false, error: message }, status);
}

/** 토큰 인증 뒤 handler 실행. handler 는 토큰 범위의 사업장 ID 와 쿼리를 받는다. */
export async function withToken(req: Request, handler: (ctx: { siteIds: string[]; q: URLSearchParams }) => Promise<Response>): Promise<Response> {
  const auth = await authenticateApiToken(req);
  if (!auth.ok) return error(auth.status, auth.error);
  const q = new URL(req.url).searchParams;
  const site = q.get("site");
  const siteIds = site ? auth.siteIds.filter((s) => s === site) : auth.siteIds;
  if (site && siteIds.length === 0) return error(404, "해당 사업장이 없거나 토큰 범위 밖입니다.");
  try {
    return await handler({ siteIds, q });
  } catch (e) {
    console.error("[api/v1] 오류:", e);
    return error(500, "처리 중 오류가 발생했습니다.");
  }
}

/** from/to(YYYY-MM-DD 또는 ISO) → UTC ISO 구간. 기본 최근 7일, 최대 API_MAX_DAYS 일. */
export function parseRange(q: URLSearchParams): { fromIso: string; toIso: string } | { error: string } {
  const parse = (v: string | null, endOfDay: boolean): string | null | undefined => {
    if (!v) return undefined;
    const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T${endOfDay ? "23:59:59.999" : "00:00:00"}+09:00`) : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  const to = parse(q.get("to"), true);
  const from = parse(q.get("from"), false);
  if (to === null || from === null) return { error: "from/to 는 YYYY-MM-DD 또는 ISO 8601 형식이어야 합니다." };
  const toIso = to ?? new Date().toISOString();
  const fromIso = from ?? new Date(new Date(toIso).getTime() - 7 * 86400_000).toISOString();
  if (fromIso > toIso) return { error: "from 이 to 보다 늦습니다." };
  if (new Date(toIso).getTime() - new Date(fromIso).getTime() > API_MAX_DAYS * 86400_000) return { error: `조회 구간은 최대 ${API_MAX_DAYS}일입니다.` };
  return { fromIso, toIso };
}

export async function sitesPayload(siteIds: string[]) {
  const db = getDb();
  const sites = await listSitesByIds(siteIds, db);
  const robots = siteIds.length ? await db.select({ siteId: schema.robots.siteId }).from(schema.robots).where(and(inArray(schema.robots.siteId, siteIds), eq(schema.robots.active, true))) : [];
  return sites.map((s) => ({ id: s.id, name: s.name, timezone: s.timezone, address: s.address, installedOn: s.installedOn, robotCount: robots.filter((r) => r.siteId === s.id).length }));
}

export async function robotsPayload(siteIds: string[]) {
  const db = getDb();
  if (siteIds.length === 0) return [];
  const rows = await db
    .select({ r: schema.robots, st: schema.robotStatus, floorName: schema.floors.name })
    .from(schema.robots)
    .leftJoin(schema.robotStatus, eq(schema.robotStatus.robotId, schema.robots.id))
    .leftJoin(schema.floors, eq(schema.floors.id, schema.robots.floorId))
    .where(and(inArray(schema.robots.siteId, siteIds), eq(schema.robots.active, true)))
    .orderBy(asc(schema.robots.id));
  return rows.map(({ r, st, floorName }) => {
    const s = st ? toStatus(st) : null;
    return { id: r.id, name: r.name, vendor: r.vendor, model: r.model, siteId: r.siteId, floorId: r.floorId, floorName: floorName ?? null, status: s ? { common: s.common, online: s.online, batteryPct: s.batteryPct, progressPct: s.progressPct, lastReceivedAt: s.lastReceivedAt } : { common: "UNKNOWN", online: false, batteryPct: null, progressPct: null, lastReceivedAt: null } };
  });
}

export async function runsPayload(siteIds: string[], fromIso: string, toIso: string) {
  const db = getDb();
  if (siteIds.length === 0) return [];
  const rows = await db
    .select()
    .from(schema.actualRuns)
    .where(and(inArray(schema.actualRuns.siteId, siteIds), gte(schema.actualRuns.startedAt, fromIso), lte(schema.actualRuns.startedAt, toIso)))
    .orderBy(desc(schema.actualRuns.startedAt))
    .limit(API_MAX_ROWS);
  return rows.map((r) => ({ id: r.id, siteId: r.siteId, robotId: r.robotId, floorId: r.floorId, taskId: r.taskId, startedAt: r.startedAt, endedAt: r.endedAt, result: r.result, origin: r.origin, areaM2: r.areaM2, durationMin: r.durationMin, waterL: r.waterL, completionPct: r.coverage?.percentage ?? null, zoneIds: r.zoneIds, cleanedZones: r.coverage?.areas.filter((a) => a.cleanCount > 0).map((a) => a.name) ?? [] }));
}

export async function incidentsPayload(siteIds: string[], fromIso: string, toIso: string, status: string | null) {
  const db = getDb();
  if (siteIds.length === 0) return [];
  const rows = await db
    .select()
    .from(schema.incidents)
    .where(and(inArray(schema.incidents.siteId, siteIds), gte(schema.incidents.occurredAt, fromIso), lte(schema.incidents.occurredAt, toIso), isNull(schema.incidents.dismissedAt), status === "open" ? inArray(schema.incidents.status, ["OPEN", "ACKED", "IN_PROGRESS"]) : status === "resolved" ? eq(schema.incidents.status, "RESOLVED") : undefined))
    .orderBy(desc(schema.incidents.occurredAt))
    .limit(API_MAX_ROWS);
  const ids = rows.map((r) => r.id);
  const actions = ids.length ? await db.select().from(schema.incidentActions).where(and(inArray(schema.incidentActions.incidentId, ids), eq(schema.incidentActions.internal, false))).orderBy(asc(schema.incidentActions.at)) : [];
  // 고객 기준: 코드·원문 없이 요약 메시지와 외부 공개 조치만
  return rows.map((i) => ({ id: i.id, siteId: i.siteId, robotId: i.robotId, severity: i.severity, status: i.status, message: i.customerMessage, occurredAt: i.occurredAt, occurrences: i.occurrences ?? 1, acknowledgedAt: i.acknowledgedAt, resolvedAt: i.resolvedAt, actions: actions.filter((a) => a.incidentId === i.id).map((a) => ({ at: a.at, note: a.note })) }));
}

export async function reportsPayload(siteIds: string[]) {
  const db = getDb();
  if (siteIds.length === 0) return [];
  const base = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  const rows = await db.select().from(schema.reportVersions).where(and(inArray(schema.reportVersions.siteId, siteIds), eq(schema.reportVersions.status, "PUBLISHED"))).orderBy(desc(schema.reportVersions.periodStart), desc(schema.reportVersions.version)).limit(200);
  return rows.map((r) => {
    const a = effectiveAggregates(r);
    return { id: r.id, siteId: r.siteId, kind: r.kind, title: reportTitle(r), periodStart: r.periodStart, periodEnd: r.periodEnd, version: r.version, publishedAt: r.publishedAt, summary: { robotCount: a.robotCount, completionRatePct: a.completionRatePct, totalRuns: a.totalRuns, cumulativeAreaM2: a.cumulativeAreaM2, totalDurationMin: a.totalDurationMin, incidents: a.incidents.length, productivityM2PerHour: a.productivityM2PerHour ?? null, avgCompletionPct: a.avgCompletionPct ?? null }, url: `${base}/reports/${encodeURIComponent(r.id)}`, exports: { pptx: `${base}/api/reports/${encodeURIComponent(r.id)}/export?format=pptx`, xlsx: `${base}/api/reports/${encodeURIComponent(r.id)}/export?format=xlsx` } };
  });
}
