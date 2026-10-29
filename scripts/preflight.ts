/**
 * 배포 전·기동 전 점검: 환경변수 규칙 + DB(연결·마이그레이션·관리자·샘플·워커). 비밀값은 출력하지 않는다.
 * 사용: npm run preflight        (오류가 있으면 종료 코드 1 — compose 의 migrate 단계에서 web/worker 기동을 막는다)
 *       npm run preflight -- --env-only   (DB 없이 환경변수만)
 */
import { closeDb, getDb } from "../src/lib/db/client";
import { checkDb, checkEnv, migrationCountInRepo, summarize, type Finding } from "../src/lib/ops/preflight";

function print(findings: Finding[]) {
  for (const f of findings) console.log(`${f.level === "error" ? "✖" : f.level === "warn" ? "⚠" : "✓"} [${f.code}] ${f.message}`);
}

async function main() {
  const envOnly = process.argv.includes("--env-only");
  console.log(`배포 전 점검 — APP_ENV=${process.env.APP_ENV ?? "(없음)"} VENDOR_MODE=${process.env.VENDOR_MODE ?? "sample"}`);
  const findings = checkEnv(process.env);
  if (!envOnly && process.env.DATABASE_URL) {
    try {
      findings.push(...(await checkDb(getDb(), { expectedMigrations: migrationCountInRepo(), production: process.env.APP_ENV === "production" })));
    } finally {
      await closeDb();
    }
  }
  print(findings);
  const s = summarize(findings);
  console.log(`\n오류 ${s.errors} · 주의 ${s.warns}`);
  if (s.errors > 0) {
    console.log("오류를 고친 뒤 다시 실행하세요. (docs/09-배포전-점검.md)");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("점검 실패:", e?.message ?? e);
  process.exit(1);
});
