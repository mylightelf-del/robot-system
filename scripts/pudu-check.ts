/**
 * PUDU 연결 확인(키 발급 후 첫 시험). DB 를 건드리지 않고 읽기 API 만 호출한다. 비밀값은 출력하지 않는다.
 * 사용:
 *   npm run pudu:check                       → Health Check, 허용 매장(PUDU_SHOP_IDS)별 로봇 목록. 허용 매장이 없으면 키가 보는 전체 규모만 출력
 *   npm run pudu:check -- --shops 포스코     → 매장 이름에 검색어가 들어간 매장의 shop_id 목록(PUDU_SHOP_IDS 에 넣을 값 찾기)
 *   npm run pudu:check -- <SN>               → 해당 SN 의 상태 V2·상세·등록 작업·예약·소모품
 * 필요한 환경변수: PUDU_API_APP_KEY, PUDU_API_APP_SECRET, PUDU_API_CLUSTER(cn|sea|de|us)
 * 실기 메모(2026-10): 대리점 키는 다른 고객사 매장 수천 곳이 보인다. 매장 목록은 검색어로만 출력하고 전체를 뿌리지 않는다.
 */
import { PuduApi } from "../src/lib/vendors/pudu/api";
import { configFromEnv, PuduClient } from "../src/lib/vendors/pudu/client";
import { mapCleanbotTaskCode, mapProductCode, productParamFor } from "../src/lib/vendors/pudu/mapping";

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

  const args = process.argv.slice(2);
  const shopsIdx = args.indexOf("--shops");
  if (shopsIdx >= 0) {
    const q = (args[shopsIdx + 1] ?? "").toLowerCase();
    if (!q) {
      console.error("검색어를 주세요: npm run pudu:check -- --shops 포스코");
      process.exit(2);
    }
    console.log(`\n[2] 매장 검색 "${q}" (이름에 포함)`);
    let total = 0;
    let hits = 0;
    for (let offset = 0; offset < 100000; offset += 100) {
      const page = await api.listShops(100, offset);
      total = page.count ?? page.total ?? 0;
      for (const s of page.list ?? []) {
        if (`${s.shop_name} ${s.company_name ?? ""}`.toLowerCase().includes(q)) {
          hits += 1;
          console.log(`  shop_id=${s.shop_id}  ${s.shop_name}  (${s.company_name ?? ""})`);
        }
      }
      if ((page.list ?? []).length < 100) break;
    }
    console.log(`  → 전체 ${total}곳 중 ${hits}곳 일치. 쓸 매장의 shop_id 를 PUDU_SHOP_IDS 에 콤마로 적으세요.`);
    return;
  }

  const sn = args.find((a) => !a.startsWith("--"));
  if (!sn) {
    if (cfg.shopIds.length === 0) {
      const shops = await api.listShops(1, 0);
      const robots = await api.listRobots({ limit: 1 });
      console.log(`\n[2] 허용 매장(PUDU_SHOP_IDS) 미설정 — 이 키가 보는 범위: 매장 ${shops.count ?? "?"}곳, 로봇 ${robots.count ?? "?"}대`);
      console.log("  다른 고객사가 섞여 있으므로 목록을 출력하지 않습니다. `-- --shops 검색어` 로 우리 매장의 shop_id 를 찾아 .env 에 넣으세요.");
      return;
    }
    console.log(`\n[2] 허용 매장 ${cfg.shopIds.length}곳의 로봇`);
    for (const shopId of cfg.shopIds) {
      const page = await api.listRobots({ shop_id: shopId, limit: 100 });
      const list = (page.list ?? []).filter((r) => String(r.shop_id) === shopId);
      console.log(`  shop_id=${shopId} ${list[0]?.shop_name ?? "(로봇 없음 또는 매장 없음)"} — ${list.length}대`);
      for (const r of list) console.log(`    sn=${r.sn}  product_code=${r.product_code} → 내부 모델 ${mapProductCode(r.product_code) ?? "미확인(문서에 없는 코드)"}  nickname=${r.nickname ?? ""}`);
    }
    console.log("\n완료. 관리 설정 → PUDU 패널에서 '연결 확인 + 로봇 조회' 후 등록하세요.");
    return;
  }

  console.log(`\n[3] 상태 V2 (${sn})`);
  const v2 = await api.statusV2(sn);
  console.log("  ", JSON.stringify(v2));
  console.log(`\n[4] 청소로봇 상세 (${sn})`);
  const d = await api.cleanDetail(sn);
  console.log("  online:", d.online, " battery:", d.battery, " map:", JSON.stringify(d.map), " position:", JSON.stringify(d.position));
  console.log("  cleanbot.task:", d.cleanbot?.task, "→", mapCleanbotTaskCode(d.cleanbot?.task).label, " rising:", d.cleanbot?.rising, " sewage:", d.cleanbot?.sewage);
  console.log("  clean:", JSON.stringify(d.cleanbot?.clean ?? null).slice(0, 400));
  console.log(`\n[5] 소모품 (${sn})`);
  const comp = await api.listComponents(sn);
  for (const c of comp.list ?? []) console.log(`  ${c.name}(${c.type}) product=${c.product} cost_time=${c.cost_time} life_time=${c.life_time}`);
  const product = comp.list?.[0]?.product ?? productParamFor(v2.product_code);
  console.log(`\n[6] 등록 작업 (${sn}, product=${product ?? "미확인"})`);
  if (product) {
    const tasks = await api.listCleanTasks({ sn, product });
    for (const t of tasks.item ?? tasks.list ?? []) console.log(`  task_id=${t.task_id} version=${t.version} name=${t.name} mode=${t.config?.mode ?? t.mode}`);
    console.log(`  (${tasks.count ?? 0}건)`);
  } else {
    console.log("  product 값을 알 수 없어 건너뜀");
  }
  console.log(`\n[7] 예약 (${sn})`);
  const cron = await api.listCron(sn);
  for (const c of cron.list ?? []) console.log(`  cron_id=${c.cron_id} ${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")} weeks=${c.weeks.join(",")} ${c.cron_status} tasks=${c.task_list.map((t) => `${t.name}(${t.task_id}@${t.task_version})`).join("|")}`);
  console.log("\n완료. 실기 검증 체크리스트는 docs/06-PUDU-API-검토.md 8장.");
}

main().catch((e) => {
  console.error("실패:", e?.message ?? e);
  process.exit(1);
});
