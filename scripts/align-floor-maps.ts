/**
 * 로봇이 지금 쓰는 PUDU 지도로 층 지도 맞추기(관리 설정 PUDU 패널의 버튼과 같다). 서버에서 한 번에 돌릴 때 쓴다.
 * 이 시스템의 층 지도만 바꾼다(로봇 자체의 지도는 바꾸지 않는다). 기본은 미리 보기, --apply <층ID...> 로 고른 층만 적용.
 * 사용(서버): docker compose run --rm worker npx tsx scripts/align-floor-maps.ts [--apply floorId ...]
 */
import { and, eq } from "drizzle-orm";
import { closeDb, getDb, schema } from "../src/lib/db/client";
import { getUser } from "../src/lib/db/repo";
import { alignFloorMapsToRobots } from "../src/lib/services/sites";

async function main() {
  const row = await getDb().query.users.findFirst({ where: and(eq(schema.users.role, "HQ_ADMIN"), eq(schema.users.active, true)) });
  const admin = row ? await getUser(row.id) : undefined;
  if (!admin) throw new Error("활성 본사 관리자가 없습니다.");
  const i = process.argv.indexOf("--apply");
  const floorIds = i >= 0 ? process.argv.slice(i + 1) : [];
  for (const r of await alignFloorMapsToRobots(admin, { apply: i >= 0, floorIds })) console.log(`[${r.floorId}] ${r.site} / ${r.floor}: 현재 ${r.current ?? "-"} · 로봇 ${r.map ?? "-"} → ${r.result}`);
  await closeDb();
}
main().catch(async (e) => {
  console.error("실패:", e?.message ?? e);
  await closeDb();
  process.exit(1);
});
