/**
 * 열려 있는(초안·검토) 보고서를 모두 재집계한다. 확정본은 건드리지 않는다.
 * 과거 실적을 적재(scripts/pudu-backfill.ts)한 뒤 초안 숫자를 최신 데이터로 맞출 때 쓴다.
 * 사용: npx tsx scripts/recompute-drafts.ts            → 활성 본사 관리자 1명 명의로 실행(감사 기록에 남음)
 *       npx tsx scripts/recompute-drafts.ts --as 이메일  → 지정한 직원 계정 명의로 실행
 *       --dry-run                                        → 대상만 출력하고 바꾸지 않음
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { closeDb, getDb, schema } from "../src/lib/db/client";
import { getUser } from "../src/lib/db/repo";
import { recomputeDraft } from "../src/lib/services/reports";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const asIdx = args.indexOf("--as");
  const asEmail = asIdx >= 0 ? args[asIdx + 1] : undefined;
  const db = getDb();

  const actorRow = asEmail
    ? await db.query.users.findFirst({ where: and(eq(schema.users.email, asEmail), eq(schema.users.active, true)) })
    : await db.query.users.findFirst({ where: and(eq(schema.users.role, "HQ_ADMIN"), eq(schema.users.active, true)), orderBy: asc(schema.users.createdAt) });
  if (!actorRow) throw new Error(asEmail ? `활성 계정이 없습니다: ${asEmail}` : "활성 본사 관리자 계정이 없습니다.");
  const actor = await getUser(actorRow.id, db);
  if (!actor) throw new Error("계정을 불러오지 못했습니다.");
  console.log(`실행 계정: ${actor.name} (${actor.role})${dryRun ? " — 미리 보기" : ""}`);

  const open = await db
    .select({ id: schema.reportVersions.id, siteId: schema.reportVersions.siteId, kind: schema.reportVersions.kind, periodStart: schema.reportVersions.periodStart, periodEnd: schema.reportVersions.periodEnd, status: schema.reportVersions.status, aggregates: schema.reportVersions.aggregates })
    .from(schema.reportVersions)
    .where(inArray(schema.reportVersions.status, ["DRAFT", "REVIEW"]))
    .orderBy(asc(schema.reportVersions.siteId), asc(schema.reportVersions.periodStart));
  console.log(`열린 보고서 ${open.length}건`);
  const runsOf = (a: unknown) => (a as { totalRuns?: number } | null)?.totalRuns ?? 0;
  for (const r of open) {
    const before = runsOf(r.aggregates);
    if (dryRun) {
      console.log(`  ${r.siteId} ${r.kind} ${r.periodStart}~${r.periodEnd} [${r.status}] 실적 ${before}건`);
      continue;
    }
    await recomputeDraft(actor, r.id);
    const after = await db.query.reportVersions.findFirst({ where: eq(schema.reportVersions.id, r.id), columns: { aggregates: true } });
    const afterRuns = runsOf(after?.aggregates);
    console.log(`  ${r.siteId} ${r.kind} ${r.periodStart}~${r.periodEnd} [${r.status}] 실적 ${before} → ${afterRuns}건`);
  }
}

main()
  .catch((e) => {
    console.error("실패:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
