/**
 * CENOBOT L4 2대 · BIB J40 2대를 운영 DB 에 미리 등록한다(docs/22 1-3). 멱등 — 여러 번 실행해도 같은 결과.
 * - 포스코센터: 층 「지하2층」「지하3층」 추가
 * - 포항 플레이그라운드: 새 사업장(Asia/Seoul), 층 2F·3F·4F·6F
 * - 로봇 4대: **사용 중지** 상태로 등록(키·문서 수령 전에는 대시보드 대수·알림·보고서에 빠짐). 조회 전용이라 지원 명령 없음.
 *   CENOBOT 은 번호판(vendorMeta.licensePlate)으로 등록 → 키를 받아 live 가 되면 장비 동기화가 deviceOpenId 를 자동 연결.
 * - 관리번호는 인자로 바꿀 수 있다. 이미 쓰인 번호면 다음 빈 번호를 쓴다.
 *
 * 사용: npx tsx scripts/register-cenobot-bib.ts [--dry] [--posco-site <siteId>] [--ids PW-R-010,PW-R-011,PW-R-012,PW-R-013]
 */
import { and, asc, eq, isNull, like } from "drizzle-orm";
import { closeDb, getDb, schema } from "../src/lib/db/client";
import { getUser } from "../src/lib/db/repo";
import { createFloor, createSite } from "../src/lib/services/sites";
import { nextRobotId } from "../src/lib/services/admin";
import { audit } from "../src/lib/services/audit";
import { newId } from "../src/lib/util/random";
import { nowIso } from "../src/lib/util/time";

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const DRY = process.argv.includes("--dry");

async function main() {
  const db = getDb();
  const actorRow = await db.query.users.findFirst({ where: and(eq(schema.users.role, "HQ_ADMIN"), eq(schema.users.active, true)), orderBy: asc(schema.users.createdAt) });
  if (!actorRow) throw new Error("활성 본사 관리자 계정이 없습니다.");
  const actor = (await getUser(actorRow.id, db))!;
  const ids = (arg("--ids") ?? "PW-R-010,PW-R-011,PW-R-012,PW-R-013").split(",").map((s) => s.trim());

  // 1) 포스코센터
  let posco = arg("--posco-site") ? await db.query.sites.findFirst({ where: eq(schema.sites.id, arg("--posco-site")!) }) : undefined;
  if (!posco) {
    const cands = await db.select().from(schema.sites).where(and(like(schema.sites.name, "%포스코센터%"), isNull(schema.sites.retiredAt)));
    if (cands.length !== 1) throw new Error(`포스코센터 사업장을 하나로 정하지 못했습니다(${cands.map((c) => `${c.id}:${c.name}`).join(", ") || "없음"}). --posco-site 로 지정하세요.`);
    posco = cands[0];
  }
  console.log(`포스코센터: ${posco.id} (${posco.name})`);

  // 2) 포항 플레이그라운드
  let pohang = (await db.select().from(schema.sites).where(eq(schema.sites.name, "포항 플레이그라운드")))[0];
  if (!pohang) {
    if (DRY) console.log("[dry] 사업장 '포항 플레이그라운드' 생성 예정");
    else {
      const { id } = await createSite(actor, { name: "포항 플레이그라운드", address: "", timezone: "Asia/Seoul" });
      pohang = (await db.query.sites.findFirst({ where: eq(schema.sites.id, id) }))!;
      console.log(`사업장 생성: ${id} 포항 플레이그라운드`);
    }
  } else console.log(`포항 플레이그라운드: ${pohang.id} (이미 있음)`);

  const ensureFloor = async (siteId: string | undefined, name: string): Promise<string | null> => {
    if (!siteId) return null;
    const f = (await db.select().from(schema.floors).where(and(eq(schema.floors.siteId, siteId), eq(schema.floors.name, name))))[0];
    if (f) return f.id;
    if (DRY) {
      console.log(`[dry] 층 생성 예정: ${siteId} ${name}`);
      return null;
    }
    const { id } = await createFloor(actor, siteId, name);
    console.log(`층 생성: ${siteId} ${name} → ${id}`);
    return id;
  };
  const b2 = await ensureFloor(posco.id, "지하2층");
  const b3 = await ensureFloor(posco.id, "지하3층");
  const pf: Record<string, string | null> = {};
  for (const n of ["2F", "3F", "4F", "6F"]) pf[n] = await ensureFloor(pohang?.id, n);

  // 3) 로봇
  const specs = [
    { id: ids[0], vendor: "CENOBOTS" as const, model: "L4" as const, name: "포스코센터 1호기 (지하3층)", siteId: posco.id, floorId: b3, serial: "E260227010A", meta: { source: "api", licensePlate: "L4-05590", vendorMap: "POSCO B3F" } },
    { id: ids[1], vendor: "CENOBOTS" as const, model: "L4" as const, name: "포스코센터 2호기 (지하2층)", siteId: posco.id, floorId: b2, serial: "E250918008A", meta: { source: "api", licensePlate: "L4-05408", vendorMap: "POSCO B2F" } },
    { id: ids[2], vendor: "BIB" as const, model: "J40" as const, name: "CG_1 (습식)", siteId: pohang?.id, floorId: pf["2F"], serial: "J40-20-CP-SZ342740-0006", meta: { source: "pending", sn: "J40-20-CP-SZ342740-0006", floors: ["2F", "3F"], note: "BIB 문서·키 수령 전" } },
    { id: ids[3], vendor: "BIB" as const, model: "J40" as const, name: "CG_2 (건식)", siteId: pohang?.id, floorId: pf["4F"], serial: "J40-23-CP-352935-2584", meta: { source: "pending", sn: "J40-23-CP-352935-2584", floors: ["4F", "6F"], note: "BIB 문서·키 수령 전" } },
  ];
  for (const s of specs) {
    const all = await db.select().from(schema.robots);
    const exists = all.find((r) => r.vendor === s.vendor && (r.serial === s.serial || r.vendorMeta?.licensePlate === s.meta.licensePlate && !!s.meta.licensePlate));
    if (exists) {
      console.log(`로봇 이미 있음: ${exists.id} ${exists.name}`);
      continue;
    }
    const id = all.some((r) => r.id === s.id) ? await nextRobotId(db) : s.id;
    if (DRY || !s.siteId || !s.floorId) {
      console.log(`[dry] 로봇 등록 예정: ${id} ${s.vendor} ${s.model} ${s.name} → ${s.siteId}/${s.floorId}`);
      continue;
    }
    const now = nowIso();
    await db.transaction(async (tx) => {
      await tx.insert(schema.robots).values({ id, vendor: s.vendor, model: s.model, vendorRobotId: s.meta.licensePlate ? `plate:${s.meta.licensePlate}` : `sn:${s.serial}`, siteId: s.siteId!, floorId: s.floorId!, name: s.name, serial: s.serial, firmware: "", active: false, supportedCommands: [], internalNote: "조회 전용 연동 예정(docs/22). 키 수령 후 사용으로 전환.", vendorMeta: s.meta });
      await tx.insert(schema.robotPlacements).values({ id: newId("plc"), robotId: id, siteId: s.siteId!, from: now, to: null });
      await tx.insert(schema.robotStatus).values({ robotId: id, common: "UNKNOWN", raw: "등록만 됨 — 연동 전(사용 중지)", online: false, batteryPct: null, pose: null, poseIsLastKnown: true, mapVersionId: null, currentMissionId: null, progressPct: null, lastReceivedAt: null, dataAt: null });
      await audit(actor, { siteId: s.siteId!, robotId: id, action: "ROBOT:PREREGISTER", params: { vendor: s.vendor, model: s.model, serial: s.serial }, result: "OK", detail: "조회 전용 연동 대비 사전 등록(사용 중지)", vendorTraceId: null }, tx);
    });
    console.log(`로봇 등록(사용 중지): ${id} ${s.vendor} ${s.model} ${s.name}`);
  }
}

main()
  .catch((e) => {
    console.error("실패:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
