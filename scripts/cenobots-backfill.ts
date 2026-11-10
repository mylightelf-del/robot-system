/**
 * CENOBOTS(CZ Robots) 과거 작업 이력 적재: mission/list 를 7일 구간씩(오래된 것부터) 받아 실적으로 영구 보관한다. 멱등(missionId 중복 제거).
 * 조회 전용 API(조회용 POST)만 쓴다. 운영 서버의 mock 모드에서는 실행하지 않는다.
 * 사용(서버): docker compose run --rm worker npx tsx scripts/cenobots-backfill.ts [일수=90 | --from YYYY-MM-DD]
 */
import { closeDb } from "../src/lib/db/client";
import { createCenobotsApi } from "../src/lib/vendors/cenobots/cenobotsAdapter";
import { cenobotsDryRun, cenobotsEnabled, syncCenobotsReports } from "../src/worker/cenobots";

const DAY = 86_400;

async function main() {
  const args = process.argv.slice(2);
  const fromIdx = args.indexOf("--from");
  const fromDate = fromIdx >= 0 ? args[fromIdx + 1] : null;
  if (fromDate && !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) throw new Error("--from 은 YYYY-MM-DD 형식입니다.");
  const days = Number(args.find((a) => /^\d+$/.test(a) && a !== fromDate) ?? 90);
  if (!cenobotsEnabled()) throw new Error("CENOBOTS 연동이 꺼져 있습니다(CENOBOTS_MODE·키·허용 장비 확인).");
  if (cenobotsDryRun()) throw new Error("운영 서버의 mock 모드에서는 이력을 적재하지 않습니다.");
  const api = createCenobotsApi();
  const now = Math.floor(Date.now() / 1000);
  const oldest = fromDate ? Math.floor(new Date(`${fromDate}T00:00:00+09:00`).getTime() / 1000) : now - days * DAY;
  console.log(`CENOBOTS 이력 적재: ${new Date(oldest * 1000).toISOString().slice(0, 10)} ~ 오늘`);
  let failed = 0;
  for (let start = oldest; start < now; start += 7 * DAY) {
    const end = Math.min(now, start + 7 * DAY);
    const r = await syncCenobotsReports(api, 0, { start, end });
    console.log(`  ${new Date(start * 1000).toISOString().slice(0, 10)} ~ ${new Date(end * 1000).toISOString().slice(0, 10)}: ${r.ok ? r.detail : `실패 — ${r.detail}`}`);
    if (!r.ok) failed += 1;
  }
  if (failed) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("실패:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
