# FlashBot(에이전트로 연결된 배송로봇)이 우리 PUDU 오픈플랫폼(클라우드 API) 계정에서도 보이는지 확인(조회만, 명령 없음).
# 보이면 클라우드 배송 지시(받는 사람 번호 → 로봇 문자)로 바꿀 수 있다. 공개 기록에는 있음/없음·제품 코드만.
cd /opt/robot-system
docker compose exec -T worker npx tsx -e '
(async () => {
  const { getDb, schema } = await import("./src/lib/db/client");
  const { macToRobotId } = await import("./src/lib/delivery/openplatform");
  const { createPuduApi } = await import("./src/lib/vendors/pudu/puduAdapter");
  const mine = await getDb().select().from(schema.deliveryRobots);
  const agentIds = new Set(mine.filter((r) => r.source !== "openplatform").map((r) => r.agentRobotId));
  console.log("PUBLIC: 에이전트 배송로봇", agentIds.size + "대, 오픈플랫폼 배송로봇", mine.length - agentIds.size + "대");
  const api = createPuduApi();
  // 대리점 키라 다른 고객사 로봇도 보인다 → 세기만 하고 우리 로봇(MAC 일치)만 표시
  let total = 0; const hit = [];
  for (let off = 0; off < 20000; off += 50) {
    const p = await api.listRobots({ limit: 50, offset: off });
    const list = p.list || []; total += list.length;
    for (const r of list) if (r.mac && agentIds.has(macToRobotId(r.mac))) hit.push((r.product_code || "?") + (r.shop_id ? "" : "·매장없음"));
    if (list.length < 50) break;
  }
  console.log("PUBLIC: 클라우드 계정 로봇", total + "대 조회");
  console.log("PUBLIC: FlashBot 클라우드 계정에서", hit.length ? "보임(제품 " + hit.join(",") + ")" : "안 보임");
  process.exit(0);
})().catch((e) => { console.log("PUBLIC: 오류", e.message); process.exit(1); });' 2>&1 | grep '^PUBLIC:'
echo "결과: 완료"
