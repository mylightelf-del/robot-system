/**
 * PUDU 연결 확인(키 발급 후 첫 시험). DB 를 건드리지 않고 읽기 API 만 호출한다.
 * 사용: npm run pudu:check            → Health Check, 매장 목록, 로봇 목록
 *       npm run pudu:check -- <SN>     → 위 + 해당 SN 의 상세 상태·등록 작업·예약·소모품
 * 필요한 환경변수: PUDU_API_APP_KEY, PUDU_API_APP_SECRET, PUDU_API_CLUSTER(cn|sea|de|us)
 * 비밀값은 출력하지 않는다.
 */
import { PuduApi } from "../src/lib/vendors/pudu/api";
import { configFromEnv, PuduClient } from "../src/lib/vendors/pudu/client";
import { mapCleanbotTaskCode, mapProductCode } from "../src/lib/vendors/pudu/mapping";

async function main() {
  const cfg = configFromEnv();
  if (!cfg) {
    console.error("PUDU_API_APP_KEY / PUDU_API_APP_SECRET / PUDU_API_CLUSTER 를 .env.local 에 설정하세요. (기본 클러스터 없음: 발급 계정의 클러스터를 확인)");
    process.exit(2);
  }
  const client = new PuduClient(cfg);
  const api = new PuduApi(client);
  console.log("대상:", client.describe);

  console.log("\n[1] Health Check");
  const ok = await api.healthCheck();
  console.log(ok ? "  OK (인증 통과)" : "  실패 — 키/클러스터/서명 확인 (오류 메시지는 docs/06 2장 참고)");
  if (!ok) process.exit(1);

  console.log("\n[2] 매장 목록");
  const shops = await api.listShops(50, 0);
  for (const s of shops.list ?? []) console.log(`  shop_id=${s.id}  ${s.name}`);

  console.log("\n[3] 로봇 목록");
  const robots = await api.listRobots({ limit: 100 });
  for (const r of robots.list ?? []) {
    console.log(`  sn=${r.sn}  product_code=${r.product_code}  → 내부 모델 ${mapProductCode(r.product_code) ?? "미확인(문서에 없는 코드)"}  shop=${r.shop_id} ${r.shop_name}  nickname=${r.nickname ?? ""}`);
  }

  const sn = process.argv[2];
  if (sn) {
    console.log(`\n[4] 상태 V2 (${sn})`);
    const v2 = await api.statusV2(sn);
    console.log("  ", JSON.stringify(v2));
    console.log(`\n[5] 청소로봇 상세 (${sn})`);
    const d = await api.cleanDetail(sn);
    console.log("  battery:", d.battery, " map:", JSON.stringify(d.map), " position:", JSON.stringify(d.position));
    console.log("  cleanbot.task:", d.cleanbot?.task, "→", mapCleanbotTaskCode(d.cleanbot?.task).label, " rising:", d.cleanbot?.rising, " sewage:", d.cleanbot?.sewage);
    console.log("  clean:", JSON.stringify(d.cleanbot?.clean ?? null).slice(0, 400));
    console.log(`\n[6] 등록 작업 (${sn})`);
    const tasks = await api.listCleanTasks({ sn });
    for (const t of tasks.item ?? tasks.list ?? []) console.log(`  task_id=${t.task_id} version=${t.version} name=${t.name} mode=${t.mode} product=${t.product}`);
    console.log(`\n[7] 예약 (${sn})`);
    const cron = await api.listCron(sn);
    for (const c of cron.list ?? []) console.log(`  cron_id=${c.cron_id} ${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")} weeks=${c.weeks.join(",")} ${c.cron_status} tasks=${c.task_list.map((t) => t.name).join("|")}`);
    console.log(`\n[8] 소모품 (${sn})`);
    const comp = await api.listComponents(sn);
    for (const c of comp.list ?? []) console.log(`  ${c.name}(${c.type}) cost_time=${c.cost_time} life_time=${c.life_time}`);
  }
  console.log("\n완료. 실기 검증 체크리스트는 docs/06-PUDU-API-검토.md 8장.");
}

main().catch((e) => {
  console.error("실패:", e?.message ?? e);
  process.exit(1);
});
