/**
 * DB 마이그레이션 적용. drizzle/ 폴더의 SQL 을 순서대로 실행한다(적용 이력은 __drizzle_migrations 에 기록).
 * 사용: npm run db:migrate   (DATABASE_URL 필요)
 * 운영 컨테이너는 기동 시 이 스크립트를 먼저 실행한다.
 */
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, getDb } from "../src/lib/db/client";

async function main() {
  const db = getDb();
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("마이그레이션 적용 완료:", process.env.DATABASE_URL?.replace(/:\/\/[^@]*@/, "://***@"));
  await closeDb();
}

main().catch((e) => {
  console.error("마이그레이션 실패:", e);
  process.exit(1);
});
