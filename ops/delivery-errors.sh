# 배송 지시·동기화 오류 확인: 최근 지시 기록·감사 기록·web 로그·web→에이전트 연결. 공개 기록에는 요약만.
cd /opt/robot-system
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
select '"'"'PUBLIC: 지시 '"'"' || to_char(requested_at at time zone '"'"'Asia/Seoul'"'"','"'"'MM-DD HH24:MI:SS'"'"') || '"'"' '"'"' || kind || '"'"' '"'"' || status || '"'"' — '"'"' || left(message,160) from delivery_orders order by requested_at desc limit 5;
select '"'"'PUBLIC: 감사 '"'"' || to_char(at at time zone '"'"'Asia/Seoul'"'"','"'"'MM-DD HH24:MI:SS'"'"') || '"'"' '"'"' || action || '"'"' '"'"' || result || '"'"' — '"'"' || left(coalesce(detail,'"'"''"'"'),160) from audit_logs where action like '"'"'DELIVERY%'"'"' or action like '"'"'SYNC%'"'"' order by at desc limit 6;"'
echo "PUBLIC: web 로그(30분) 배송·에이전트 오류: $(docker compose logs --since 30m web 2>&1 | grep -iE '에이전트|agent|delivery' | sed -E 's/token=[^& ]+/token=***/g' | sed 's/.*| //' | tail -5 | cut -c1-200 | tr '\n' '|')"
echo "PUBLIC: web→에이전트 연결 시험: $(docker compose exec -T web node -e 'fetch("http://pudu-agent:9050/api/devices",{signal:AbortSignal.timeout(5000)}).then(r=>r.text()).then(t=>console.log("OK",t.slice(0,40).replace(/[0-9]{8,}/g,"<id>"))).catch(e=>console.log("실패",e.message,e.cause?.code||""))' 2>&1 | tail -1)"
echo "PUBLIC: worker→에이전트 연결 시험: $(docker compose exec -T worker node -e 'fetch("http://pudu-agent:9050/api/devices",{signal:AbortSignal.timeout(5000)}).then(r=>r.text()).then(t=>console.log("OK",t.slice(0,40).replace(/[0-9]{8,}/g,"<id>"))).catch(e=>console.log("실패",e.message,e.cause?.code||""))' 2>&1 | tail -1)"
echo "PUBLIC: web 의 PUDU_AGENT 설정: $(docker compose exec -T web sh -c 'echo MODE=$PUDU_AGENT_MODE URL=$PUDU_AGENT_URL')"
echo "PUBLIC: 에이전트가 받은 POST(30분): $(awk -v t="$(date -u -d '-30 min' '+%Y-%m-%d %H:%M')" '$0>=t' agent/log/pudulogs/all_logs.log | grep -E 'POST /api/robot' | grep -E 'resp -' | sed -E 's/[0-9]{10,}/<id>/g' | cut -c1-200 | tail -4 | tr '\n' '|')"
