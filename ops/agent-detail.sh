# 배송 에이전트 상세 점검: 재접속 발생 시각대·로봇 상태·받은 알림 종류. 공개 기록에는 요약만.
cd /opt/robot-system
L=agent/log/pudulogs/all_logs.log
echo "PUBLIC: 재접속 줄 날짜별: $(grep -i 'reconnect' $L | grep -oE '^20[0-9-]{8}' | sort | uniq -c | tr '\n' ' ')"
echo "PUBLIC: 재접속 줄 예(형태): $(grep -i 'reconnect' $L | tail -1 | sed -E 's/[0-9]{10,}/<id>/g; s/[A-Za-z0-9]{20,}/<x>/g' | cut -c1-160)"
echo "PUBLIC: 최근 5분 재접속 $(awk -v t="$(date -u -d '-5 min' '+%Y-%m-%d %H:%M')" '$0>=t' $L | grep -ci reconnect)회 · 연결 $(awk -v t="$(date -u -d '-5 min' '+%Y-%m-%d %H:%M')" '$0>=t' $L | grep -c 'iot connected')회"
echo "PUBLIC: 로봇 응답 성공 시각: $(grep -E 'user/sub : (query_state|request_data)' $L | grep 'doCallBack :  {' | grep -oE '^20[0-9: -]{17}' | tail -5 | tr '\n' ',')"
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
select '"'"'PUBLIC: 받은 알림 '"'"' || msg_type || '"'"' '"'"' || count(*) || '"'"'건 (마지막 '"'"' || to_char(max(received_at) at time zone '"'"'Asia/Seoul'"'"','"'"'MM-DD HH24:MI:SS'"'"') || '"'"')'"'"' from delivery_events group by msg_type;
select '"'"'PUBLIC: 로봇 '"'"' || name || '"'"' · '"'"' || source || '"'"' · 상태 '"'"' || coalesce(last_state->>'"'"'robotState'"'"','"'"'-'"'"') || '"'"' · 이동 '"'"' || coalesce(last_state->>'"'"'moveState'"'"','"'"'-'"'"') || '"'"' · 배터리 '"'"' || coalesce(last_state->>'"'"'robotPower'"'"','"'"'-'"'"') || '"'"' · 목적지 '"'"' || jsonb_array_length(destinations) || '"'"'개 · 마지막 수신 '"'"' || coalesce(to_char(last_seen_at at time zone '"'"'Asia/Seoul'"'"','"'"'MM-DD HH24:MI'"'"'),'"'"'-'"'"') from delivery_robots order by source;
select '"'"'PUBLIC: 목적지 종류 '"'"' || string_agg(distinct d->>'"'"'type'"'"', '"'"','"'"') from delivery_robots, jsonb_array_elements(destinations) d where source='"'"'agent'"'"';"'
