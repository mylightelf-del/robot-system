# 로봇 현황·일정 즉시 업데이트(관리자 버튼과 같은 동작, 시스템 실행). 공개 기록에는 단계별 결과만.
cd /opt/robot-system
docker compose exec -T worker npx tsx -e '
import("./src/lib/services/refresh").then(async (m) => {
  const r = await m.refreshRobotsAndSchedules();
  for (const s of r.steps) console.log("PUBLIC:", s.ok ? "OK" : "실패", s.name, "—", s.detail);
  process.exit(0);
}).catch((e) => { console.log("PUBLIC: 오류", e.message); process.exit(1); });' 2>&1 | grep -E "^PUBLIC:"
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select '"'"'PUBLIC: 로봇 '"'"' || count(*) || '"'"'대 상태 갱신, 가장 오래된 수신 '"'"' || coalesce(to_char(min(last_received_at) at time zone '"'"'Asia/Seoul'"'"','"'"'MM-DD HH24:MI'"'"'),'"'"'-'"'"') from robot_status s join robots r on r.id=s.robot_id where r.active and r.vendor='"'"'PUDU'"'"'; select '"'"'PUBLIC: 활성 예약 '"'"' || count(*) || '"'"'건'"'"' from schedules where enabled; select '"'"'PUBLIC: 오늘·내일 예정 회차 '"'"' || count(*) || '"'"'건'"'"' from planned_runs where planned_at >= now() - interval '"'"'1 hour'"'"' and planned_at < now() + interval '"'"'2 days'"'"';"'
