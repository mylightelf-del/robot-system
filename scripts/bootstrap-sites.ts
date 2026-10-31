/**
 * 운영 초기 구성(멱등): 사업장·층을 만들고 PUDU 로봇을 등록·배치하고, 지정한 제조사 지도를 층에 가져온다.
 * 화면에서 하는 것과 같은 서비스 함수를 쓰므로 권한 검사·감사 기록이 그대로 남는다.
 * 사용: npx tsx scripts/bootstrap-sites.ts <spec.json> [관리자 이메일]
 * spec.json 예:
 * {
 *   "sites": [
 *     { "name": "포스코센터 선릉", "address": "서울 강남구", "floors": [
 *       { "name": "1층", "robots": ["8880T5B27070005"], "puduMap": "1#2#포스코센터1층_" },
 *       { "name": "2층", "robots": ["8880T5B27070002"] }
 *     ] }
 *   ]
 * }
 * 실제 SN·매장 정보가 들어가므로 spec 파일은 저장소에 넣지 않는다(.gitignore: ops-*.json).
 */
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { closeDb, getDb, schema } from "../src/lib/db/client";
import { getUser } from "../src/lib/db/repo";
import { createFloor, createSite, importPuduMap } from "../src/lib/services/sites";
import { puduImportRobots, relocateRobot } from "../src/lib/services/admin";

type Spec = { sites: { name: string; address?: string; timezone?: string; floors: { name: string; robots?: string[]; puduMap?: string }[] }[] };

async function main() {
  const [specPath, adminEmail] = process.argv.slice(2);
  if (!specPath) {
    console.error("사용: npx tsx scripts/bootstrap-sites.ts <spec.json> [관리자 이메일]");
    process.exit(2);
  }
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as Spec;
  const db = getDb();
  const adminRow = adminEmail
    ? await db.query.users.findFirst({ where: eq(schema.users.email, adminEmail) })
    : await db.query.users.findFirst({ where: and(eq(schema.users.role, "HQ_ADMIN"), eq(schema.users.active, true)) });
  const admin = adminRow ? await getUser(adminRow.id, db) : undefined;
  if (!admin) throw new Error("활성 본사 관리자가 없습니다(scripts/bootstrap-admin.ts 먼저).");
  console.log(`실행 사용자: ${admin.name} <${admin.email}>`);

  for (const s of spec.sites) {
    let site = await db.query.sites.findFirst({ where: eq(schema.sites.name, s.name) });
    if (!site) {
      const { id } = await createSite(admin, { name: s.name, address: s.address ?? "", timezone: s.timezone });
      site = (await db.query.sites.findFirst({ where: eq(schema.sites.id, id) }))!;
      console.log(`사업장 생성: ${s.name} (${id})`);
    } else console.log(`사업장 있음: ${s.name} (${site.id})`);
    for (const f of s.floors) {
      let floor = await db.query.floors.findFirst({ where: and(eq(schema.floors.siteId, site.id), eq(schema.floors.name, f.name)) });
      if (!floor) {
        const { id } = await createFloor(admin, site.id, f.name);
        floor = (await db.query.floors.findFirst({ where: eq(schema.floors.id, id) }))!;
        console.log(`  층 생성: ${f.name} (${id})`);
      } else console.log(`  층 있음: ${f.name} (${floor.id})`);
      for (const sn of f.robots ?? []) {
        const existing = await db.query.robots.findFirst({ where: and(eq(schema.robots.vendor, "PUDU"), eq(schema.robots.vendorRobotId, sn)) });
        if (!existing) {
          const n = await puduImportRobots(admin, site.id, floor.id, [sn]);
          console.log(`    로봇 등록: ${sn} (${n}대)`);
        } else if (existing.floorId !== floor.id) {
          await relocateRobot(admin, existing.id, site.id, floor.id, "운영 초기 구성(bootstrap-sites)");
          console.log(`    로봇 이동: ${existing.id} ${sn} → ${s.name}/${f.name}`);
        } else console.log(`    로봇 있음: ${existing.id} ${sn}`);
      }
      if (f.puduMap) {
        const current = await db.query.mapVersions.findFirst({ where: eq(schema.mapVersions.id, floor.currentMapVersionId) });
        if (current?.vendorMapName === f.puduMap) console.log(`    지도 있음: ${f.puduMap} (v${current.version})`);
        else {
          const r = await importPuduMap(admin, floor.id, f.puduMap);
          console.log(`    지도 가져옴: ${f.puduMap} → v${r.version}, 구역 ${r.zones}개, 이미지 ${r.imageStored ? "보관" : `원격 참조(${r.imageError})`}`);
        }
      }
    }
  }
  await closeDb();
}

main().catch(async (e) => {
  console.error("실패:", e?.message ?? e);
  await closeDb();
  process.exit(1);
});
