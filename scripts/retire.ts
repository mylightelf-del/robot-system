/**
 * 운영에서 빼기(서버 일회성 실행, 본사 관리자 명의 → 감사 기록). 화면의 고급 설정과 같은 서비스 함수를 쓴다.
 * 사용:
 *   npx tsx scripts/retire.ts robot <로봇ID> "<사유>"        → 로봇 사용 중지(동기화·운영 화면·명령에서 제외, 이력 보존)
 *   npx tsx scripts/retire.ts robot-restore <로봇ID> "<사유>"
 *   npx tsx scripts/retire.ts site <사업장ID> "<사유>"       → 사업장 사용 중지(로봇 전부 중지, 운영 화면·권한·알림·보고서 일정 제외, 이력 보존)
 *   npx tsx scripts/retire.ts site-restore <사업장ID> "<사유>"
 *   --as 이메일  → 지정한 본사 관리자 명의로 실행(기본: 가장 먼저 만든 활성 본사 관리자)
 */
import { and, asc, eq } from "drizzle-orm";
import { closeDb, getDb, schema } from "../src/lib/db/client";
import { getUser } from "../src/lib/db/repo";
import { restoreSite, retireSite, setRobotActive } from "../src/lib/services/admin";

async function main() {
  const args = process.argv.slice(2);
  const asIdx = args.indexOf("--as");
  const asEmail = asIdx >= 0 ? args.splice(asIdx, 2)[1] : undefined;
  const [cmd, id, reason] = args;
  if (!cmd || !id) throw new Error("사용법: retire.ts robot|robot-restore|site|site-restore <ID> \"<사유>\"");
  const db = getDb();
  const actorRow = asEmail
    ? await db.query.users.findFirst({ where: and(eq(schema.users.email, asEmail), eq(schema.users.active, true)) })
    : await db.query.users.findFirst({ where: and(eq(schema.users.role, "HQ_ADMIN"), eq(schema.users.active, true)), orderBy: asc(schema.users.createdAt) });
  if (!actorRow) throw new Error("활성 본사 관리자 계정이 없습니다.");
  const actor = (await getUser(actorRow.id, db))!;
  console.log(`실행 계정: ${actor.name} (${actor.role})`);
  switch (cmd) {
    case "robot":
      await setRobotActive(actor, id, false, reason);
      console.log(`로봇 ${id} 사용 중지`);
      break;
    case "robot-restore":
      await setRobotActive(actor, id, true, reason);
      console.log(`로봇 ${id} 다시 사용`);
      break;
    case "site": {
      const r = await retireSite(actor, id, reason);
      console.log(`사업장 ${id} 사용 중지 — 로봇 ${r.robots}대 중지, 예정 회차 ${r.cancelledPlannedRuns}건 취소`);
      break;
    }
    case "site-restore":
      await restoreSite(actor, id, reason);
      console.log(`사업장 ${id} 다시 사용(로봇은 중지 상태 유지)`);
      break;
    default:
      throw new Error(`알 수 없는 명령: ${cmd}`);
  }
}

main()
  .catch((e) => {
    console.error("실패:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
