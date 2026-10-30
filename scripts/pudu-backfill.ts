/**
 * PUDU 과거 이력 적재: 청소 보고서(실적)와 장애 로그를 7일 구간씩 거슬러 받아 DB 에 영구 보관한다.
 * - PUDU 통계 API 는 최근 180일만 조회된다(docs/06). 그보다 오래된 실적은 받을 수 없다.
 * - 한 번에 7일 이하 권장, 같은 종류 동시 호출 1건 제한 → 구간을 순서대로(오래된 것부터) 처리하고, 거절되면 잠시 쉬고 다시 시도한다.
 * - 이미 있는 실적·장애는 건너뛴다(멱등). 7일보다 오래된 장애 로그는 '복구' 상태 이력으로 적재한다.
 * 사용(서버): docker compose run --rm worker npx tsx scripts/pudu-backfill.ts [일수=180] [--errors-only|--reports-only]
 */
import { closeDb } from "../src/lib/db/client";
import { createPuduApi } from "../src/lib/vendors/pudu/puduAdapter";
import { puduLiveEnabled, syncPuduErrors, syncPuduReports } from "../src/worker/pudu";

const DAY = 86_400;
const MAX_DAYS = 180;

async function withRetry(label: string, fn: () => Promise<{ ok: boolean; detail: string }>) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fn();
    if (r.ok) return r;
    console.log(`  ${label} 실패(${attempt}/4): ${r.detail}`);
    await new Promise((res) => setTimeout(res, attempt * 15_000));
  }
  return { ok: false, detail: "재시도 초과" };
}

async function main() {
  const args = process.argv.slice(2);
  const days = Math.min(MAX_DAYS, Number(args.find((a) => /^\d+$/.test(a)) ?? MAX_DAYS));
  const doReports = !args.includes("--errors-only");
  const doErrors = !args.includes("--reports-only");
  if (!puduLiveEnabled()) throw new Error("PUDU live 설정이 아닙니다(키·클러스터·허용 매장 필요).");
  const api = createPuduApi();
  const now = Math.floor(Date.now() / 1000);
  // 180일 경계는 PUDU 쪽 기준과 몇 시간 어긋날 수 있어 하루 여유를 둔다.
  const oldest = now - Math.min(days, MAX_DAYS - 1) * DAY;
  console.log(`PUDU 이력 적재: ${new Date(oldest * 1000).toISOString().slice(0, 10)} ~ 오늘 (${days}일), 실적 ${doReports ? "O" : "X"} · 장애 ${doErrors ? "O" : "X"}`);
  let failed = 0;
  for (let start = oldest; start < now; start += 7 * DAY) {
    const end = Math.min(now, start + 7 * DAY);
    const label = `${new Date(start * 1000).toISOString().slice(0, 10)}~${new Date(end * 1000).toISOString().slice(0, 10)}`;
    if (doReports) {
      const r = await withRetry(`${label} 실적`, () => syncPuduReports(api, 0, { start, end }));
      console.log(`${label} 실적: ${r.detail}`);
      if (!r.ok) failed += 1;
    }
    if (doErrors) {
      const r = await withRetry(`${label} 장애`, () => syncPuduErrors(api, 0, { start, end }));
      console.log(`${label} 장애: ${r.detail}`);
      if (!r.ok) failed += 1;
    }
  }
  console.log(failed ? `완료(실패 구간 ${failed}개 — 다시 실행하면 이어서 채운다)` : "완료");
  await closeDb();
  if (failed) process.exit(1);
}

main().catch(async (e) => {
  console.error("실패:", e?.message ?? e);
  await closeDb();
  process.exit(1);
});
