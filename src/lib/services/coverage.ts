import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { User } from "@/lib/domain/types";
import { assertRobotAccess } from "@/lib/auth/authz";
import { getDb, schema } from "@/lib/db/client";
import { listZonesByFloor, type DbLike } from "@/lib/db/repo";
import { NotFoundError } from "@/lib/util/errors";
import { nowIso } from "@/lib/util/time";
import { matchZoneIds, parseCoverage } from "@/lib/vendors/pudu/mapping";
import { sniffImageType } from "./sites";

/**
 * 청소 범위 증빙: 실적의 결과 지도 이미지를 제조사 S3 에서 받아 보관하고 화면에 준다.
 * - 이미지는 작다(실기 15KB 안팎). 받은 뒤에는 제조사 보관 기간과 무관하게 남는다.
 * - 과거 실적은 scripts/recompute-coverage.ts 로 raw_payload 에서 다시 파싱한다.
 */
export const RUN_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export type RunImageKind = "RESULT" | "HEATMAP";

async function fetchImage(url: string): Promise<{ contentType: string; data: Buffer } | { error: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(process.env.MAP_IMAGE_FETCH_TIMEOUT_MS ?? 20000));
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = Buffer.from(await res.arrayBuffer());
    const contentType = sniffImageType(data);
    if (!contentType) return { error: "이미지가 아닌 응답" };
    if (data.length > RUN_IMAGE_MAX_BYTES) return { error: "이미지가 너무 큼" };
    return { contentType, data };
  } catch (e) {
    return { error: (e as Error).name === "AbortError" ? "시간 초과" : (e as Error).message };
  }
}

/** 실적의 결과 지도를 받아 보관(이미 있으면 건너뜀). 워커가 새 실적마다 부르고, 화면 조회 때도 없으면 받는다. */
export async function storeRunImage(runId: string, kind: RunImageKind, db: DbLike = getDb()): Promise<{ stored: boolean; reason?: string }> {
  const existing = await db.query.runImages.findFirst({ where: and(eq(schema.runImages.runId, runId), eq(schema.runImages.kind, kind)), columns: { id: true } });
  if (existing) return { stored: false, reason: "이미 보관" };
  const run = await db.query.actualRuns.findFirst({ where: eq(schema.actualRuns.id, runId), columns: { coverage: true } });
  const url = kind === "RESULT" ? run?.coverage?.resultImageUrl : run?.coverage?.heatmapUrl;
  if (!url) return { stored: false, reason: "이미지 URL 없음" };
  const r = await fetchImage(url);
  if ("error" in r) return { stored: false, reason: r.error };
  await db.insert(schema.runImages).values({ id: `rimg-${runId}-${kind.toLowerCase()}`, runId, kind, contentType: r.contentType, data: r.data, fetchedAt: nowIso() }).onConflictDoNothing();
  return { stored: true };
}

/** 화면용: 실적 이미지(권한은 로봇 접근과 같다). 보관본이 없으면 그때 받아 보관한다. */
export async function getRunImage(user: User, runId: string, kind: RunImageKind): Promise<{ contentType: string; data: Buffer; fetchedAt: string }> {
  const db = getDb();
  const run = await db.query.actualRuns.findFirst({ where: eq(schema.actualRuns.id, runId), columns: { robotId: true } });
  if (!run) throw new NotFoundError("실적을 찾을 수 없습니다.");
  await assertRobotAccess(user, run.robotId, db);
  let img = await db.query.runImages.findFirst({ where: and(eq(schema.runImages.runId, runId), eq(schema.runImages.kind, kind)) });
  if (!img) {
    const r = await storeRunImage(runId, kind, db);
    if (!r.stored) throw new NotFoundError(`결과 지도가 없습니다(${r.reason ?? "미제공"}).`);
    img = await db.query.runImages.findFirst({ where: and(eq(schema.runImages.runId, runId), eq(schema.runImages.kind, kind)) });
  }
  if (!img) throw new NotFoundError("결과 지도가 없습니다.");
  return { contentType: img.contentType, data: img.data, fetchedAt: img.fetchedAt };
}

/** 과거 실적의 raw_payload 에서 증빙을 다시 파싱해 coverage·zoneIds 를 채운다(멱등). 이미지는 withImagesSinceIso 이후 실적만 받는다. */
export async function recomputeCoverage(opts: { withImagesSinceIso?: string; log?: (s: string) => void } = {}, db: DbLike = getDb()): Promise<{ scanned: number; updated: number; images: number }> {
  const rows = await db.select({ id: schema.actualRuns.id, floorId: schema.actualRuns.floorId, raw: schema.actualRuns.rawPayload, startedAt: schema.actualRuns.startedAt, zoneIds: schema.actualRuns.zoneIds }).from(schema.actualRuns).where(and(eq(schema.actualRuns.vendor, "PUDU"), isNotNull(schema.actualRuns.rawPayload))).orderBy(desc(schema.actualRuns.startedAt));
  const zonesByFloor = new Map<string, Awaited<ReturnType<typeof listZonesByFloor>>>();
  let updated = 0;
  let images = 0;
  for (const r of rows) {
    const cov = parseCoverage((r.raw ?? {}) as { floor_list?: string; percentage?: number });
    if (!zonesByFloor.has(r.floorId)) zonesByFloor.set(r.floorId, await listZonesByFloor(r.floorId, db));
    const zoneIds = matchZoneIds(cov, zonesByFloor.get(r.floorId)!);
    await db.update(schema.actualRuns).set({ coverage: cov, zoneIds }).where(eq(schema.actualRuns.id, r.id));
    if (cov) updated += 1;
    if (cov?.resultImageUrl && opts.withImagesSinceIso && r.startedAt >= opts.withImagesSinceIso) {
      const res = await storeRunImage(r.id, "RESULT", db);
      if (res.stored) images += 1;
    }
    if (updated % 100 === 0 && updated > 0) opts.log?.(`${updated}건 갱신…`);
  }
  return { scanned: rows.length, updated, images };
}

/** 실적 목록에 결과 지도 보관 여부를 붙인다(화면 링크 표시용). */
export async function runImageFlags(runIds: string[], db: DbLike = getDb()): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  const rows = await db.select({ runId: schema.runImages.runId }).from(schema.runImages).where(and(inArray(schema.runImages.runId, runIds), eq(schema.runImages.kind, "RESULT")));
  return new Set(rows.map((r) => r.runId));
}

/** 보관 이미지 용량 합계(관리 화면 표시용). */
export async function runImageStats(db: DbLike = getDb()): Promise<{ count: number; bytes: number }> {
  const [row] = await db.select({ count: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(octet_length(${schema.runImages.data})),0)::bigint` }).from(schema.runImages);
  return { count: row?.count ?? 0, bytes: Number(row?.bytes ?? 0) };
}
