/**
 * 샘플 데이터 적재(개발 전용). 기존 데이터를 모두 지우고 가상 사업장 5곳·로봇 20대를 넣는다.
 * 사용: npm run db:seed
 * 운영 DB 에서는 실행하지 않는다(APP_ENV=production 이면 거부).
 */
import { buildSampleStore } from "../src/lib/sample/seed";
import { resetDatabase, seedDatabase } from "../src/lib/db/seed";
import { closeDb } from "../src/lib/db/client";
import { nowIso } from "../src/lib/util/time";

async function main() {
  if (process.env.APP_ENV === "production" && process.env.ALLOW_SAMPLE_RESET !== "true") {
    throw new Error("운영 환경에서는 샘플 데이터를 적재하지 않습니다 (ALLOW_SAMPLE_RESET=true 로 명시해야 함).");
  }
  const password = process.env.SAMPLE_USER_PASSWORD ?? "sample1234!";
  const data = buildSampleStore(nowIso());
  await resetDatabase();
  await seedDatabase(data, password);
  console.log(`샘플 데이터 적재 완료: 사업장 ${data.sites.length} · 로봇 ${data.robots.length} · 실적 ${data.actualRuns.length} · 사용자 ${data.users.length}`);
  console.log(`샘플 사용자 비밀번호: ${password} (개발 전용)`);
  await closeDb();
}

main().catch((e) => {
  console.error("샘플 적재 실패:", e);
  process.exit(1);
});
