# CENOBOT 실연동 전환(키는 sync-secrets 로 먼저 넣는다): 허용 장비(Open ID+번호판)·live 모드 → 재시작 → 장비 조회·연결·상태 동기화.
# 끄기: CENOBOTS_MODE=unconfigured (또는 mock) 로 바꾸고 재시작. 공개 기록에는 요약만.
cd /opt/robot-system
grep -q '^CENOBOTS_ACCESS_KEY=.\+' .env && grep -q '^CENOBOTS_SECRET_KEY=.\+' .env || { echo "PUBLIC: 키 없음 — GitHub Secrets 등록 후 sync-secrets 를 먼저 실행하세요"; exit 1; }
set_env() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi; }
set_env CENOBOTS_ALLOWED_DEVICE_OPEN_IDS "CRV9NEH7UP,8HB3ZLZU3G,L4-05590,L4-05408"
set_env CENOBOTS_MODE live
docker compose up -d --force-recreate web worker >/dev/null 2>&1
sleep 20
echo "PUBLIC: $(grep '^CENOBOTS_MODE=' .env) · 허용 $(grep '^CENOBOTS_ALLOWED_DEVICE_OPEN_IDS=' .env | cut -d= -f2)"
docker compose exec -T worker npx tsx -e '
(async () => {
  const { createCenobotsApi } = await import("./src/lib/vendors/cenobots/cenobotsAdapter");
  const api = createCenobotsApi();
  try {
    const devs = await api.listDevices();
    // 계정에 다른 고객사 장비도 보인다 → 허용 장비만 출력(공개 기록)
    const allow = (process.env.CENOBOTS_ALLOWED_DEVICE_OPEN_IDS || "").split(",");
    const mine = devs.filter((d) => allow.includes(d.deviceOpenId) || allow.includes(d.licensePlate ?? ""));
    console.log("PUBLIC: 장비 조회 OK — 우리 장비", mine.length + "대:", mine.map((d) => `${d.licensePlate ?? "-"}=${d.deviceOpenId}`).join(", "));
  } catch (e) { console.log("PUBLIC: 장비 조회 실패", e.message); }
  const w = await import("./src/worker/cenobots");
  const r1 = await w.syncCenobotsCatalog(api);
  console.log("PUBLIC: 번호판 연결", r1.ok ? "OK" : "실패", "—", r1.detail);
  // 실제 Open ID 로 연결된 로봇만 다시 사용(docs/22 4.7) — JSON 키 이름은 인자로 넘겨 따옴표 문제를 피한다
  const { getDb, schema } = await import("./src/lib/db/client");
  const { and, eq, isNotNull, sql } = await import("drizzle-orm");
  const k = (name) => sql`${schema.robots.vendorMeta} ->> ${name}`;
  const on = await getDb().update(schema.robots).set({ active: true }).where(and(eq(schema.robots.vendor, "CENOBOTS"), sql`${k("boundMode")} = ${"live"}`, isNotNull(k("deviceOpenId")))).returning({ id: schema.robots.id });
  console.log("PUBLIC: 다시 사용", on.map((x) => x.id).join(", ") || "없음");
  for (const [n, f] of [["장비·작업·예약", () => w.syncCenobotsCatalog(api)], ["상태", () => w.syncCenobotsStatus()], ["작업 이력(48시간)", () => w.syncCenobotsReports(api)], ["오류", () => w.syncCenobotsErrors(api)]]) {
    const r = await f(); console.log("PUBLIC:", n, r.ok ? "OK" : "실패", "—", r.detail);
  }
  process.exit(0);
})().catch((e) => { console.log("PUBLIC: 오류", e.message); process.exit(1); });' 2>&1 | grep '^PUBLIC:'
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select '"'"'PUBLIC: 로봇 '"'"' || r.id || '"'"' '"'"' || coalesce(r.vendor_meta->>'"'"'licensePlate'"'"','"'"'-'"'"') || '"'"' openId='"'"' || coalesce(r.vendor_meta->>'"'"'deviceOpenId'"'"','"'"'미연결'"'"') || '"'"' 사용='"'"' || r.active || '"'"' 상태='"'"' || coalesce(s.common,'"'"'-'"'"') || '"'"' 배터리='"'"' || coalesce(s.battery_pct::text,'"'"'-'"'"') from robots r left join robot_status s on s.robot_id=r.id where r.vendor='"'"'CENOBOTS'"'"';"'
