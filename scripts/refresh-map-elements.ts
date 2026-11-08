/**
 * 제조사(PUDU) 지도를 가져온 모든 층의 현재 지도에 지점(충전소·워크스테이션·반환·유지보수)·금지 구역을 채운다(관리자 명의, 멱등).
 * 사용: npx tsx scripts/refresh-map-elements.ts
 */
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { closeDb, getDb, schema } from "../src/lib/db/client";
import { getUser } from "../src/lib/db/repo";
import { refreshMapElements } from "../src/lib/services/sites";

async function main() {
  const db = getDb();
  const actorRow = await db.query.users.findFirst({ where: and(eq(schema.users.role, "HQ_ADMIN"), eq(schema.users.active, true)), orderBy: asc(schema.users.createdAt) });
  if (!actorRow) throw new Error("활성 본사 관리자 계정이 없습니다.");
  const actor = (await getUser(actorRow.id, db))!;
  const floors = await db.select().from(schema.floors);
  const maps = await db.select().from(schema.mapVersions).where(and(eq(schema.mapVersions.vendor, "PUDU"), isNotNull(schema.mapVersions.vendorMapName)));
  for (const f of floors) {
    const m = maps.find((x) => x.id === f.currentMapVersionId);
    if (!m) continue;
    try {
      const r = await refreshMapElements(actor, m.id);
      console.log(`${f.id} ${m.vendorMapName}: 지점 ${r.points} · 금지 ${r.forbidden}`);
    } catch (e) {
      console.log(`${f.id}: 실패 — ${(e as Error).message}`);
    }
  }
}
main()
  .catch((e) => {
    console.error("실패:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
