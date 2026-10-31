/**
 * PUDU 과거 이력 적재: 청소 보고서(실적)와 장애 로그를 7일 구간씩 거슬러 받아 DB 에 영구 보관한다.
 * - PUDU 문서는 "최근 180일 조회"라고 하지만 실기(2026-10-31)에서는 그보다 오래된 구간(4월)도 응답했다 → 시작일을 직접 줄 수 있다.
 * - 한 번에 7일 이하 권장, 같은 종류 동시 호출 1건 제한 → 구간을 순서대로(오래된 것부터) 처리하고, 거절되면 잠시 쉬고 다시 시도한다.
 * - 이미 있는 실적·장애는 건너뛴다(멱등). 7일보다 오래된 장애 로그는 '복구' 상태 이력으로 적재한다.
 * 사용(서버): docker compose run --rm worker npx tsx scripts/pudu-backfill.ts [일수=180 | --from YYYY-MM-DD] [--errors-only|--reports-only]
 *   예: --from 2026-01-01  (올해 전체)
 */
import { closeDb } from "../src/lib/db/client";
import { createPuduApi } from "../src/lib/vendors/pudu/puduAdapter";
import { puduLiveEnabled, syncPuduErrors, syncPuduReports } from "../src/worker/pudu";

const DAY = 86_400;

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
  const fromIdx = args.indexOf("--from");
  const fromDate = fromIdx >= 0 ? args[fromIdx + 1] : null;
  if (fromDate && !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) throw new Error("--from 은 YYYY-MM-DD 형식입니다.");
  const days = Number(args.find((a) => /^\d+$/.test(a) && a !== fromDate) ?? 180);
  const doReports = !args.includes("--errors-only");
  const doErrors = !args.includes("--reports-only");
  if (!puduLiveEnabled()) throw new Error("PUDU live 설정이 아닙니다(키·클러스터·허용 매장 필요).");
  const api = createPuduApi();
  const now = Math.floor(Date.now() / 1000);
  const oldest = fromDate ? Math.floor(new Date(`${fromDate}T00:00:00+09:00`).getTime() / 1000) : now - days * DAY;
  console.log(`PUDU 이력 적재: ${new Date(oldest * 1000).toISOString().slice(0, 10)} ~ 오늘, 실적 ${doReports ? "O" : "X"} · 장애 ${doErrors ? "O" : "X"}`);
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
