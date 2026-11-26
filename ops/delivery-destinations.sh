# 배송로봇 목적지 이름·종류 목록(지도 지점 이름만, 개인정보 없음)
cd /opt/robot-system
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select '"'"'PUBLIC: '"'"' || r.name || '"'"' ['"'"' || r.source || '"'"'] '"'"' || string_agg((d->>'"'"'name'"'"') || '"'"'('"'"' || (d->>'"'"'type'"'"') || '"'"')'"'"', '"'"', '"'"') from delivery_robots r, jsonb_array_elements(r.destinations) d group by r.name, r.source;"'
