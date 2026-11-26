# CENOBOT 과거 실적 적재(설치일 2026-05-12부터, 멱등). 공개 기록에는 요약만.
cd /opt/robot-system
docker compose exec -T worker npx tsx scripts/cenobots-backfill.ts --from 2026-05-12 2>&1 | sed 's/^/PUBLIC: /' | tail -15
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select '"'"'PUBLIC: '"'"' || r.id || '"'"' 실적 '"'"' || count(a.*) || '"'"'건 · 첫 '"'"' || coalesce(to_char(min(a.started_at) at time zone '"'"'Asia/Seoul'"'"','"'"'YYYY-MM-DD'"'"'),'"'"'-'"'"') || '"'"' · 마지막 '"'"' || coalesce(to_char(max(a.started_at) at time zone '"'"'Asia/Seoul'"'"','"'"'YYYY-MM-DD HH24:MI'"'"'),'"'"'-'"'"') from robots r left join actual_runs a on a.robot_id=r.id where r.vendor='"'"'CENOBOTS'"'"' group by r.id order by r.id;"'
