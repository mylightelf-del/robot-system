# BIB·CENOBOT 로봇이 있는 사업장의 층 이름·현재 지도(층 이름만, 개인정보 없음)
cd /opt/robot-system
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select '"'"'PUBLIC: '"'"' || f.site_id || '"'"' 층='"'"' || f.name || '"'"' 지도v'"'"' || m.version || '"'"' '"'"' || coalesce(m.vendor,'"'"'샘플'"'"') || '"'"' '"'"' || coalesce(m.vendor_map_name,'"'"''"'"') from floors f join map_versions m on m.id=f.current_map_version_id where f.site_id in (select distinct site_id from robots where vendor in ('"'"'BIB'"'"','"'"'CENOBOTS'"'"')) order by f.site_id, f.name;"'
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select '"'"'PUBLIC: 로봇 '"'"' || id || '"'"' '"'"' || vendor || '"'"' 사업장='"'"' || site_id from robots where vendor in ('"'"'BIB'"'"','"'"'CENOBOTS'"'"');"'
echo "결과: 완료"
