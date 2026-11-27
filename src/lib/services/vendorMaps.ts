import { eq } from "drizzle-orm";
import type { MapCorners, Robot, Vendor } from "@/lib/domain/types";
import { getDb, schema } from "@/lib/db/client";
import { audit } from "./audit";
import { storeMapImage, storeMapImageBytes } from "./sites";

/**
 * CENOBOT·BIB 지도 자동 가져오기(사용자 요청 2026-11-27 「맵이 안 들어온다」).
 * PUDU 는 관리자가 「지도 맞추기」로 고르지만, 두 회사는 조회 전용이고 한 대가 여러 층(지도)을 오가므로(실측: 2F 등록 로봇이 CGP7F 사용)
 * 워커가 로봇의 지도들을 **이름으로 층에 짝지어** 가져온다. 로봇은 지금 쓰는 지도가 걸린 층에 보인다(services/robots, 등록 층은 그대로).
 */
export const MAP_ACTOR = { id: "system", name: "시스템(지도 자동 가져오기)" } as const;

export interface ExternalZone {
  name: string;
  polygonPx: [number, number][];
  areaM2: number;
  vendorId: string;
}
export interface ExternalMapInput {
  floorId: string;
  vendor: Extract<Vendor, "CENOBOTS" | "BIB">;
  mapName: string;
  mapVersion: string;
  widthPx: number;
  heightPx: number;
  corners: MapCorners | null;
  image: { url: string } | { bytes: Buffer; source: string; mimeType?: string | null };
  zones?: ExternalZone[];
}

export async function importExternalMap(input: ExternalMapInput): Promise<{ mapVersionId: string; version: number; zones: number; imageStored: boolean; imageError?: string }> {
  const db = getDb();
  const floor = await db.query.floors.findFirst({ where: eq(schema.floors.id, input.floorId) });
  if (!floor) throw new Error(`층 없음: ${input.floorId}`);
  if (!(input.widthPx > 0 && input.heightPx > 0)) throw new Error("지도 크기를 알 수 없어 가져오지 않습니다.");
  const existing = await db.select({ version: schema.mapVersions.version }).from(schema.mapVersions).where(eq(schema.mapVersions.floorId, floor.id));
  const version = existing.reduce((m, r) => Math.max(m, r.version), 0) + 1;
  const mapVersionId = `${floor.id}-map-v${version}`;
  const zones = (input.zones ?? []).filter((z) => z.polygonPx.length >= 3);
  await db.transaction(async (tx) => {
    await tx.insert(schema.mapVersions).values({
      id: mapVersionId,
      floorId: floor.id,
      version,
      widthPx: Math.round(input.widthPx),
      heightPx: Math.round(input.heightPx),
      corners: input.corners,
      vendor: input.vendor,
      vendorMapName: input.mapName,
      vendorMapVersion: input.mapVersion,
      imageUrl: "url" in input.image ? input.image.url : null,
      resolution: null,
      origin: null,
      points: null,
      forbidden: null,
    });
    // 구역은 층 단위 → 새 지도의 구역으로 교체(제조사가 구역을 주지 않으면 비운다 — 이전 지도 좌표의 구역이 엉뚱한 곳에 그려지지 않도록)
    await tx.delete(schema.zones).where(eq(schema.zones.floorId, floor.id));
    if (zones.length) {
      await tx.insert(schema.zones).values(zones.map((z, i) => ({ id: `zone-${floor.id}-v${version}-${i + 1}`, floorId: floor.id, name: z.name || `구역 ${i + 1}`, polygon: z.polygonPx, areaM2: z.areaM2, vendorZoneId: z.vendorId })));
    }
    await tx.update(schema.floors).set({ currentMapVersionId: mapVersionId }).where(eq(schema.floors.id, floor.id));
    await audit(MAP_ACTOR, { siteId: floor.siteId, robotId: null, action: "FLOOR:IMPORT_VENDOR_MAP", params: { floorId: floor.id, vendor: input.vendor, mapName: input.mapName, version, zones: zones.length, width: input.widthPx, height: input.heightPx, corners: !!input.corners, auto: true }, result: "OK", detail: null, vendorTraceId: null }, tx);
  });
  const stored = "url" in input.image ? await storeMapImage(mapVersionId, input.image.url) : await storeMapImageBytes(mapVersionId, input.image.bytes, input.image.source, input.image.mimeType ?? "");
  return { mapVersionId, version, zones: zones.length, imageStored: stored.ok, imageError: stored.ok ? undefined : stored.error };
}

/**
 * 층 이름 ↔ 지도 이름 짝짓기 열쇠: 지하 n층 → "B<n>", 지상 n층 → "<n>". 못 읽으면 null.
 * 예: "지하3층"·"B3"·"B3F"·"POSCO B6F"(→B6) · "2F"·"7층"·"CGP7F"(→7).
 */
export function floorKey(name: string | null | undefined): string | null {
  const s = (name ?? "").toUpperCase().replace(/\s+/g, " ");
  const b = /(?:지하|(?:^|[^A-Z])B)\s*(\d{1,3})\s*(?:F|층)?(?![0-9])/.exec(s);
  if (b) return `B${Number(b[1])}`;
  const a = /(\d{1,3})\s*(?:F|층)(?![A-Z0-9])/.exec(s) ?? /^(\d{1,3})$/.exec(s.trim());
  return a ? String(Number(a[1])) : null;
}

export interface VendorMapRef {
  name: string;
  version: string;
  inUse: boolean;
}
export interface RobotMaps<R> {
  robot: R;
  maps: VendorMapRef[];
}

/**
 * 로봇들이 가진 지도를 이름으로 사업장 층에 짝지어, 층마다 가져올 지도를 고른다.
 * - 이 시스템의 **층 지도만** 바꾼다(로봇의 등록 층·로봇 자체 지도는 바꾸지 않음).
 * - 층 지도가 다른 회사 지도면 그대로. 같은 회사 지도가 이미 있으면 그대로 두고, **같은 이름 지도의 새 판**(로봇이 쓰는 중)일 때만 다시 가져온다.
 * - 이름으로 층을 못 찾은 지도는 가져오지 않고 알린다(층을 추가하면 다음 동기화 때 들어온다).
 */
export async function syncVendorFloorMaps<R extends Pick<Robot, "id" | "siteId">>(
  vendor: Extract<Vendor, "CENOBOTS" | "BIB">,
  list: RobotMaps<R>[],
  importOne: (floorId: string, robot: R, map: VendorMapRef) => Promise<string>,
): Promise<{ detail: string; counts: Record<string, number> }> {
  const db = getDb();
  const notes: string[] = [];
  const unmatched = new Set<string>();
  let imported = 0;
  let ok = 0;
  const bySite = new Map<string, RobotMaps<R>[]>();
  for (const x of list) bySite.set(x.robot.siteId, [...(bySite.get(x.robot.siteId) ?? []), x]);
  for (const [siteId, items] of bySite) {
    const floors = await db.select().from(schema.floors).where(eq(schema.floors.siteId, siteId));
    const keyed = new Map<string, typeof floors>();
    for (const f of floors) {
      const k = floorKey(f.name);
      if (k) keyed.set(k, [...(keyed.get(k) ?? []), f]);
    }
    const cands = new Map<string, { robot: R; map: VendorMapRef }[]>();
    for (const { robot, maps } of items) {
      for (const m of maps) {
        const fs = keyed.get(floorKey(m.name) ?? "") ?? [];
        if (fs.length !== 1) {
          unmatched.add(`${m.name}${fs.length > 1 ? "(층 이름 중복)" : ""}`);
          continue;
        }
        cands.set(fs[0].id, [...(cands.get(fs[0].id) ?? []), { robot, map: m }]);
      }
    }
    for (const [floorId, cs] of cands) {
      const floor = floors.find((f) => f.id === floorId)!;
      const cur = await db.query.mapVersions.findFirst({ where: eq(schema.mapVersions.id, floor.currentMapVersionId) });
      if (cur?.vendor && cur.imageUrl && cur.vendor !== vendor) {
        notes.push(`${floor.name}: ${cur.vendor} 지도라 그대로`);
        continue;
      }
      const sorted = [...cs].sort((a, b) => Number(b.map.inUse) - Number(a.map.inUse));
      let pick: { robot: R; map: VendorMapRef } | undefined;
      if (cur?.vendor === vendor && cur.imageUrl) {
        if (cs.some((c) => c.map.version === cur.vendorMapVersion)) {
          ok += 1;
          continue;
        }
        pick = sorted.find((c) => c.map.inUse && c.map.name === cur.vendorMapName);
        if (!pick) {
          ok += 1;
          continue;
        }
      } else pick = sorted[0];
      try {
        notes.push(`${floor.name}: ${await importOne(floorId, pick.robot, pick.map)}`);
        imported += 1;
      } catch (e) {
        notes.push(`${floor.name}: 「${pick.map.name}」 실패 — ${(e as Error).message}`);
      }
    }
  }
  if (unmatched.size) notes.push(`층 이름을 못 찾은 지도 ${unmatched.size}개(${[...unmatched].slice(0, 8).join(", ")})`);
  return { detail: `가져옴 ${imported} · 그대로 ${ok}${notes.length ? ` · ${notes.join(" / ")}` : ""}`.slice(0, 900), counts: { imported, ok, unmatched: unmatched.size } };
}

/** 로봇이 지금 쓰는 지도(판)가 사업장 어느 층의 현재 지도이면 그 지도 버전(위치를 그 위에 그림). */
export async function siteMapFor(robot: Pick<Robot, "siteId">, vendor: Vendor, mapVersion: string | null | undefined) {
  if (!mapVersion) return null;
  const db = getDb();
  const floors = await db.select().from(schema.floors).where(eq(schema.floors.siteId, robot.siteId));
  for (const f of floors) {
    const map = await db.query.mapVersions.findFirst({ where: eq(schema.mapVersions.id, f.currentMapVersionId) });
    if (map && map.vendor === vendor && map.vendorMapVersion === mapVersion) return map;
  }
  return null;
}
