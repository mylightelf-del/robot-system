/**
 * 과거 실적의 청소 범위 증빙(coverage·구역별 수행)을 raw_payload 에서 다시 파싱한다(멱등).
 * 사용: npx tsx scripts/recompute-coverage.ts                → coverage·zoneIds 만 갱신
 *       npx tsx scripts/recompute-coverage.ts --images 90    → 최근 90일 실적의 결과 지도 이미지도 받아 보관(실기 15KB 안팎/건)
 */
import { closeDb } from "../src/lib/db/client";
import { recomputeCoverage, runImageStats } from "../src/lib/services/coverage";

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--images");
  const days = i >= 0 ? Number(args[i + 1] ?? 30) : 0;
  const since = days > 0 ? new Date(Date.now() - days * 86400_000).toISOString() : undefined;
  console.log(`시작 — 이미지 ${days > 0 ? `최근 ${days}일` : "받지 않음"}`);
  const r = await recomputeCoverage({ withImagesSinceIso: since, log: (m) => console.log("  " + m) });
  const st = await runImageStats();
  console.log(`완료: 실적 ${r.scanned}건 중 증빙 ${r.updated}건, 이미지 신규 ${r.images}건 (보관 ${st.count}건 · ${Math.round(st.bytes / 1024 / 1024)}MB)`);
}

main()
  .catch((e) => {
    console.error("실패:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
