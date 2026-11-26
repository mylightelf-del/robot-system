# 배송 연결 상태 카드의 근거(vendor_sync_state)와 최근 워커 배송 로그. 공개 기록에는 요약만.
cd /opt/robot-system
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select '"'"'PUBLIC: '"'"' || id || '"'"' · 마지막 실행 '"'"' || coalesce(to_char(last_run_at at time zone '"'"'Asia/Seoul'"'"','"'"'MM-DD HH24:MI:SS'"'"'),'"'"'-'"'"') || '"'"' · 마지막 성공 '"'"' || coalesce(to_char(last_ok_at at time zone '"'"'Asia/Seoul'"'"','"'"'MM-DD HH24:MI:SS'"'"'),'"'"'-'"'"') || '"'"' · 오류 '"'"' || coalesce(left(last_error,140),'"'"'없음'"'"') from vendor_sync_state where id like '"'"'PUDU:delivery%'"'"' order by id;"'
echo "PUBLIC: 워커 배송 로그(10분) $(docker compose logs --since 10m worker 2>&1 | grep -E 'DELIVERY (state|catalog)' | sed 's/.*\] //' | tail -8 | tr '\n' '|')"
L=agent/log/pudulogs/all_logs.log
echo "PUBLIC: 최근 10분 상태 조회 응답: 성공 $(awk -v t="$(date -u -d '-10 min' '+%Y-%m-%d %H:%M')" '$0>=t' $L | grep '/api/robot/state' | grep -c 'resp - {"code":0')건 · 실패 $(awk -v t="$(date -u -d '-10 min' '+%Y-%m-%d %H:%M')" '$0>=t' $L | grep '/api/robot/state' | grep -c 'resp - {"code":1')건"
echo "PUBLIC: 최근 상태 조회 응답 소요: $(grep '/api/robot/state' $L | grep -oE ' - [0-9]+ms' | tail -6 | tr '\n' ',')"
