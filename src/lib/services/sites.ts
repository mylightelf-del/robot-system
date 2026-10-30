import { and, eq, sql } from "drizzle-orm";
import type { User, Vendor } from "@/lib/domain/types";
import { getDb, schema } from "@/lib/db/client";
import { isDateKey } from "@/lib/reports/schedule";
import { assertActive, assertAdmin, canAccessSite } from "@/lib/auth/authz";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/util/errors";
import { nowIso } from "@/lib/util/time";
import { newId } from "@/lib/util/random";

import { audit } from "./audit";
import { createPuduApi } from "@/lib/vendors/pudu/puduAdapter";
import type { PuduMapDetail, PuduMapListItem } from "@/lib/vendors/pudu/api";

/**
 * 사업장·층·지도 관리(본사 관리자 전용). 운영 준비 단계: 샘플 적재 없이 실제 사업장을 화면에서 만든다.
 * - 사업장 생성 시 알림 설정 행을 함께 만든다(기본 중복 억제 30분·에스컬레이션 60분).
 * - 층 생성 시 빈 지도 v1(이미지 없음·모서리 없음)을 만든다. 제조사 지도를 가져오면 새 버전이 되고 현재 지도로 바뀐다.
 * - 삭제는 로봇·층이 없을 때만(이력 보존).
 */

const DEFAULT_MAP_W = 1200;
const DEFAULT_MAP_H = 800;

/** ID 는 URL 경로에 쓰이므로 ASCII 만 쓴다(한글 ID 는 경로 인코딩 문제로 접근 차단이 났던 실기 사례). 한글 이름이면 짧은 난수 ID. */
function slug(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return base.length >= 3 ? base.slice(0, 24) : `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;
}

export async function createSite(user: User, input: { name: string; address: string; timezone?: string }): Promise<{ id: string }> {
  assertActive(user);
  assertAdmin(user);
  const name = input.name.trim();
  if (name.length < 2) throw new ValidationError("사업장 이름은 2자 이상이어야 합니다.");
  const timezone = (input.timezone ?? "Asia/Seoul").trim() || "Asia/Seoul";
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    throw new ValidationError(`시간대 형식이 올바르지 않습니다: ${timezone} (예: Asia/Seoul)`);
  }
  const db = getDb();
  if (await db.query.sites.findFirst({ where: eq(schema.sites.name, name) })) throw new ConflictError("같은 이름의 사업장이 이미 있습니다.");
  let id = `site-${slug(name)}`;
  if (await db.query.sites.findFirst({ where: eq(schema.sites.id, id) })) id = `${id}-${newId("x").slice(-4)}`;
  await db.transaction(async (tx) => {
    await tx.insert(schema.sites).values({ id, name, address: input.address.trim(), timezone, isSample: false });
    await tx.insert(schema.notificationSettings).values({ siteId: id, dedupeMinutes: 30, escalateAfterMinutes: 60 }).onConflictDoNothing();
    await audit(user, { siteId: id, robotId: null, action: "SITE:CREATE", params: { name, timezone }, result: "OK", detail: null, vendorTraceId: null }, tx);
  });
  return { id };
}

export async function updateSite(user: User, siteId: string, input: { name?: string; address?: string; timezone?: string; installedOn?: string | null }): Promise<void> {
  assertActive(user);
  assertAdmin(user);
  const db = getDb();
  const site = await db.query.sites.findFirst({ where: eq(schema.sites.id, siteId) });
  if (!site) throw new NotFoundError("사업장을 찾을 수 없습니다.");
  const patch: Partial<typeof site> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length < 2) throw new ValidationError("사업장 이름은 2자 이상이어야 합니다.");
    patch.name = name;
  }
  if (input.address !== undefined) patch.address = input.address.trim();
  if (input.timezone !== undefined) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: input.timezone });
    } catch {
      throw new ValidationError(`시간대 형식이 올바르지 않습니다: ${input.timezone}`);
    }
    patch.timezone = input.timezone;
  }
  if (input.installedOn !== undefined) {
    // 설치일 = 보고서 일정의 기준(D0). 빈 값이면 해제(자동 작성 중지). 이미 만든 보고서는 그대로 둔다.
    const v = (input.installedOn ?? "").trim();
    if (v && !isDateKey(v)) throw new ValidationError("설치일은 YYYY-MM-DD 형식의 날짜여야 합니다.");
    patch.installedOn = v || null;
  }
  await db.transaction(async (tx) => {
    await tx.update(schema.sites).set(patch).where(eq(schema.sites.id, siteId));
    await audit(user, { siteId, robotId: null, action: "SITE:UPDATE", params: patch, result: "OK", detail: null, vendorTraceId: null }, tx);
  });
}

export async function deleteSite(user: User, siteId: string): Promise<void> {
  assertActive(user);
  assertAdmin(user);
  const db = getDb();
  const site = await db.query.sites.findFirst({ where: eq(schema.sites.id, siteId) });
  if (!site) throw new NotFoundError("사업장을 찾을 수 없습니다.");
  const floors = await db.select({ id: schema.floors.id }).from(schema.floors).where(eq(schema.floors.siteId, siteId));
  if (floors.length) throw new ConflictError("층이 남아 있는 사업장은 삭제할 수 없습니다. 층을 먼저 삭제하세요.");
  const robots = await db.select({ id: schema.robots.id }).from(schema.robots).where(eq(schema.robots.siteId, siteId));
  if (robots.length) throw new ConflictError("로봇이 배치된 사업장은 삭제할 수 없습니다.");
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.actualRuns).where(eq(schema.actualRuns.siteId, siteId));
  if (n > 0) throw new ConflictError("실적 이력이 있는 사업장은 삭제할 수 없습니다(이력 보존).");
  await db.transaction(async (tx) => {
    await tx.delete(schema.notificationRecipients).where(eq(schema.notificationRecipients.siteId, siteId));
    await tx.delete(schema.notificationSettings).where(eq(schema.notificationSettings.siteId, siteId));
    await tx.delete(schema.sitePermissions).where(eq(schema.sitePermissions.siteId, siteId));
    await tx.delete(schema.sites).where(eq(schema.sites.id, siteId));
    await audit(user, { siteId: null, robotId: null, action: "SITE:DELETE", params: { siteId, name: site.name }, result: "OK", detail: null, vendorTraceId: null }, tx);
  });
}

export async function createFloor(user: User, siteId: string, name: string): Promise<{ id: string }> {
  assertActive(user);
  assertAdmin(user);
  const db = getDb();
  const site = await db.query.sites.findFirst({ where: eq(schema.sites.id, siteId) });
  if (!site) throw new NotFoundError("사업장을 찾을 수 없습니다.");
  const floorName = name.trim();
  if (!floorName) throw new ValidationError("층 이름을 입력하세요(예: 1층, B1).");
  if (await db.query.floors.findFirst({ where: and(eq(schema.floors.siteId, siteId), eq(schema.floors.name, floorName)) })) throw new ConflictError("같은 이름의 층이 이미 있습니다.");
  const floorId = `${siteId}-${slug(floorName)}`;
  const mapId = `${floorId}-map-v1`;
  await db.transaction(async (tx) => {
    await tx.insert(schema.floors).values({ id: floorId, siteId, name: floorName, currentMapVersionId: mapId });
    await tx.insert(schema.mapVersions).values({ id: mapId, floorId, version: 1, widthPx: DEFAULT_MAP_W, heightPx: DEFAULT_MAP_H, corners: null });
    await audit(user, { siteId, robotId: null, action: "FLOOR:CREATE", params: { floorId, name: floorName }, result: "OK", detail: null, vendorTraceId: null }, tx);
  });
  return { id: floorId };
}

export async function renameFloor(user: User, floorId: string, name: string): Promise<void> {
  assertActive(user);
  assertAdmin(user);
  const db = getDb();
  const floor = await db.query.floors.findFirst({ where: eq(schema.floors.id, floorId) });
  if (!floor) throw new NotFoundError("층을 찾을 수 없습니다.");
  const floorName = name.trim();
  if (!floorName) throw new ValidationError("층 이름을 입력하세요.");
  await db.transaction(async (tx) => {
    await tx.update(schema.floors).set({ name: floorName }).where(eq(schema.floors.id, floorId));
    await audit(user, { siteId: floor.siteId, robotId: null, action: "FLOOR:RENAME", params: { floorId, name: floorName }, result: "OK", detail: null, vendorTraceId: null }, tx);
  });
}

export async function deleteFloor(user: User, floorId: string): Promise<void> {
  assertActive(user);
  assertAdmin(user);
  const db = getDb();
  const floor = await db.query.floors.findFirst({ where: eq(schema.floors.id, floorId) });
  if (!floor) throw new NotFoundError("층을 찾을 수 없습니다.");
  const robots = await db.select({ id: schema.robots.id }).from(schema.robots).where(eq(schema.robots.floorId, floorId));
  if (robots.length) throw new ConflictError("로봇이 배치된 층은 삭제할 수 없습니다. 로봇을 먼저 이동하세요.");
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.actualRuns).where(eq(schema.actualRuns.floorId, floorId));
  if (n > 0) throw new ConflictError("실적 이력이 있는 층은 삭제할 수 없습니다(이력 보존).");
  await db.transaction(async (tx) => {
    await tx.delete(schema.zones).where(eq(schema.zones.floorId, floorId));
    // floors.current_map_version_id 는 FK 가 아니므로 지도 버전을 먼저 지운 뒤 층을 지운다
    await tx.delete(schema.mapVersions).where(eq(schema.mapVersions.floorId, floorId));
    await tx.delete(schema.floors).where(eq(schema.floors.id, floorId));
    await audit(user, { siteId: floor.siteId, robotId: null, action: "FLOOR:DELETE", params: { floorId, name: floor.name }, result: "OK", detail: null, vendorTraceId: null }, tx);
  });
}

// ---- 제조사 지도 가져오기 (PUDU) ----

/** 이 사업장에 등록된 PUDU 로봇 중 하나로 매장 지도 목록을 조회한다(지도는 매장 단위). */
async function puduContextForSite(siteId: string): Promise<{ sn: string; shopId: string }> {
  const robots = await getDb()
    .select()
    .from(schema.robots)
    .where(and(eq(schema.robots.siteId, siteId), eq(schema.robots.vendor, "PUDU"), eq(schema.robots.active, true), sql`${schema.robots.vendorMeta}->>'source' = 'api'`));
  const r = robots.find((x) => x.vendorMeta?.shopId);
  if (!r) throw new ValidationError("이 사업장에 PUDU API 로 등록한 로봇이 없어 지도 목록을 조회할 수 없습니다. 먼저 로봇을 등록·배치하세요.");
  return { sn: r.vendorRobotId, shopId: String(r.vendorMeta!.shopId) };
}

export async function listPuduMapsForSite(user: User, siteId: string): Promise<{ shopId: string; maps: PuduMapListItem[] }> {
  assertActive(user);
  assertAdmin(user);
  const ctx = await puduContextForSite(siteId);
  const page = await createPuduApi().listMaps(ctx.sn);
  const maps = (page.list ?? []).slice().sort((a, b) => Number(a.floor) - Number(b.floor) || a.name.localeCompare(b.name));
  return { shopId: String(page.shop_id ?? ctx.shopId), maps };
}

/** 다각형 면적(m², 신발끈 공식). 좌표는 [x1,y1,x2,y2,…]. */
export function polygonAreaM2(flat: number[]): number {
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.round(Math.abs(s) / 2 * 10) / 10;
}

/**
 * PUDU 지도를 이 층의 새 지도 버전으로 가져온다: 이미지 URL·해상도·원점·크기 저장, area 요소를 구역으로 변환(m → px).
 * 가져온 뒤 이 층의 현재 지도가 되고, 로봇 위치는 이 지도 위에 실제 좌표로 그려진다.
 */
export async function importPuduMap(user: User, floorId: string, mapName: string): Promise<{ mapVersionId: string; version: number; zones: number; imageStored: boolean; imageError?: string }> {
  assertActive(user);
  assertAdmin(user);
  const db = getDb();
  const floor = await db.query.floors.findFirst({ where: eq(schema.floors.id, floorId) });
  if (!floor) throw new NotFoundError("층을 찾을 수 없습니다.");
  const ctx = await puduContextForSite(floor.siteId);
  const detail: PuduMapDetail = await createPuduApi().mapDetail(ctx.shopId, mapName);
  if (!detail?.url || !detail.width || !detail.height || !detail.resolution || !Array.isArray(detail.origin) || detail.origin.length < 2) {
    throw new ValidationError("지도 상세 응답에 이미지·크기·해상도·원점이 모두 있지 않아 가져오지 않습니다.");
  }
  const origin: [number, number] = [Number(detail.origin[0]), Number(detail.origin[1])];
  const res = Number(detail.resolution);
  const existing = await db.select({ version: schema.mapVersions.version }).from(schema.mapVersions).where(eq(schema.mapVersions.floorId, floorId));
  const version = existing.reduce((m, r) => Math.max(m, r.version), 0) + 1;
  const mapVersionId = `${floorId}-map-v${version}`;
  const toPx = (x: number, y: number): [number, number] => [Math.round((x - origin[0]) / res), Math.round(detail.height - (y - origin[1]) / res)];
  const areas = (detail.element_list ?? []).filter((e) => e.type === "area" && Array.isArray(e.vector_list) && e.vector_list.length >= 6);
  const zoneRows = areas.map((a, i) => {
    const poly: [number, number][] = [];
    for (let k = 0; k + 1 < a.vector_list.length; k += 2) poly.push(toPx(a.vector_list[k], a.vector_list[k + 1]));
    return { id: `zone-${floorId}-v${version}-${i + 1}`, floorId, name: a.name || `구역 ${i + 1}`, polygon: poly, areaM2: polygonAreaM2(a.vector_list), vendorElementId: a.id };
  });
  const vendor: Vendor = "PUDU";
  await db.transaction(async (tx) => {
    await tx.insert(schema.mapVersions).values({
      id: mapVersionId,
      floorId,
      version,
      widthPx: detail.width,
      heightPx: detail.height,
      // 모서리(월드 m): 좌하 = 원점, 우상 = 원점 + 크기×해상도
      corners: { bl: [origin[0], origin[1]], tl: [origin[0], origin[1] + detail.height * res], tr: [origin[0] + detail.width * res, origin[1] + detail.height * res], br: [origin[0] + detail.width * res, origin[1]] },
      vendor,
      vendorMapName: detail.map_name || mapName,
      imageUrl: detail.url,
      resolution: res,
      origin,
    });
    // 구역은 층 단위로 관리하므로 기존(샘플/이전 지도) 구역을 새 지도의 구역으로 교체한다. 등록 작업의 zoneIds 는 비워 둔다(PUDU 작업은 제조사 작업 ID 기준).
    await tx.delete(schema.zones).where(eq(schema.zones.floorId, floorId));
    if (zoneRows.length) await tx.insert(schema.zones).values(zoneRows.map(({ vendorElementId: _v, ...z }) => z));
    await tx.update(schema.floors).set({ currentMapVersionId: mapVersionId }).where(eq(schema.floors.id, floorId));
    await audit(user, { siteId: floor.siteId, robotId: null, action: "FLOOR:IMPORT_VENDOR_MAP", params: { floorId, vendor, mapName, version, zones: zoneRows.length, width: detail.width, height: detail.height, resolution: res, origin }, result: "OK", detail: null, vendorTraceId: null }, tx);
  });
  // 이미지 자체 보관(실패해도 가져오기는 성공으로 두고 원본 URL 을 그대로 참조한다 — 관리 화면에서 다시 받기 가능)
  const stored = await storeMapImage(mapVersionId, detail.url);
  return { mapVersionId, version, zones: zoneRows.length, imageStored: stored.ok, imageError: stored.ok ? undefined : stored.error };
}

// ---- 지도 이미지 보관 ----
export const MAP_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
export const mapImagePath = (mapVersionId: string) => `/api/maps/${encodeURIComponent(mapVersionId)}`;

/** 원본 URL 에서 이미지를 내려받아 DB(map_images)에 두고 지도 버전의 imageUrl 을 우리 경로로 바꾼다. */
export async function storeMapImage(mapVersionId: string, sourceUrl: string): Promise<{ ok: true; size: number } | { ok: false; error: string }> {
  const db = getDb();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(process.env.MAP_IMAGE_FETCH_TIMEOUT_MS ?? 30000));
    let res: Response;
    try {
      res = await fetch(sourceUrl, { signal: controller.signal, redirect: "follow" });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return { ok: false, error: `이미지 응답 HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return { ok: false, error: "빈 응답" };
    // 실기: PUDU S3 는 Content-Type 을 binary/octet-stream 으로 준다 → 파일 머리(매직 바이트)로 형식을 정한다
    const headerType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    const contentType = sniffImageType(buf) ?? (headerType.startsWith("image/") ? headerType : null);
    if (!contentType) return { ok: false, error: `이미지가 아닌 응답(${headerType || "형식 불명"})` };
    if (buf.length > MAP_IMAGE_MAX_BYTES) return { ok: false, error: `이미지가 너무 큼(${Math.round(buf.length / 1024 / 1024)}MB > 15MB)` };
    await db.transaction(async (tx) => {
      await tx
        .insert(schema.mapImages)
        .values({ mapVersionId, contentType, bytes: buf, size: buf.length, sourceUrl, fetchedAt: nowIso() })
        .onConflictDoUpdate({ target: schema.mapImages.mapVersionId, set: { contentType, bytes: buf, size: buf.length, sourceUrl, fetchedAt: nowIso() } });
      await tx.update(schema.mapVersions).set({ imageUrl: mapImagePath(mapVersionId) }).where(eq(schema.mapVersions.id, mapVersionId));
    });
    return { ok: true, size: buf.length };
  } catch (e) {
    return { ok: false, error: (e as Error).name === "AbortError" ? "이미지 내려받기 시간 초과" : `이미지 내려받기 실패: ${(e as Error).message}` };
  }
}

/** PNG/JPEG/WebP/GIF 매직 바이트로 형식 판별. */
export function sniffImageType(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buf.length >= 6 && buf.subarray(0, 6).toString("ascii").startsWith("GIF8")) return "image/gif";
  return null;
}

/** 관리 화면 '이미지 다시 받기': 원본 URL(보관 행의 sourceUrl 또는 지도 버전의 원격 imageUrl)에서 재시도. */
export async function refetchMapImage(user: User, mapVersionId: string): Promise<{ size: number }> {
  assertActive(user);
  assertAdmin(user);
  const db = getDb();
  const map = await db.query.mapVersions.findFirst({ where: eq(schema.mapVersions.id, mapVersionId) });
  if (!map) throw new NotFoundError("지도 버전을 찾을 수 없습니다.");
  const stored = await db.query.mapImages.findFirst({ where: eq(schema.mapImages.mapVersionId, mapVersionId) });
  const source = stored?.sourceUrl ?? (map.imageUrl && !map.imageUrl.startsWith("/api/") ? map.imageUrl : null);
  if (!source) throw new ValidationError("원본 이미지 URL 이 없습니다(제조사 지도를 다시 가져오세요).");
  const r = await storeMapImage(mapVersionId, source);
  if (!r.ok) throw new ValidationError(r.error);
  await audit(user, { siteId: null, robotId: null, action: "FLOOR:REFETCH_MAP_IMAGE", params: { mapVersionId, size: r.size }, result: "OK", detail: null, vendorTraceId: null });
  return { size: r.size };
}

/** 지도 이미지 서비스(/api/maps/<id>): 로그인 사용자이고 그 층의 사업장에 접근 권한이 있을 때만. */
export async function getMapImage(user: User, mapVersionId: string): Promise<{ contentType: string; bytes: Buffer; size: number; fetchedAt: string }> {
  assertActive(user);
  const db = getDb();
  const map = await db.query.mapVersions.findFirst({ where: eq(schema.mapVersions.id, mapVersionId) });
  if (!map) throw new NotFoundError("지도를 찾을 수 없습니다.");
  const floor = await db.query.floors.findFirst({ where: eq(schema.floors.id, map.floorId) });
  if (!floor || !(await canAccessSite(user, floor.siteId, db))) throw new ForbiddenError("해당 사업장에 대한 접근 권한이 없습니다.");
  const img = await db.query.mapImages.findFirst({ where: eq(schema.mapImages.mapVersionId, mapVersionId) });
  if (!img) throw new NotFoundError("보관된 지도 이미지가 없습니다.");
  return { contentType: img.contentType, bytes: img.bytes, size: img.size, fetchedAt: img.fetchedAt };
}
