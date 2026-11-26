# 배송 에이전트 다시 켜기 + 연결 점검(agent-stop.sh 의 반대). 공개 기록에는 요약만.
cd /opt/robot-system
if grep -q '^PUDU_AGENT_MODE=' .env; then sed -i 's/^PUDU_AGENT_MODE=.*/PUDU_AGENT_MODE=live/' .env; else echo 'PUDU_AGENT_MODE=live' >> .env; fi
docker compose --profile delivery up -d pudu-agent >/dev/null 2>&1
docker compose up -d --force-recreate web worker >/dev/null 2>&1
sleep 40
echo "PUBLIC: $(grep '^PUDU_AGENT_MODE=' .env) · 에이전트 $(docker compose --profile delivery ps pudu-agent --format '{{.Status}}' | head -1)"
echo "PUBLIC: health $(curl -s http://127.0.0.1:3000/api/health)"
L=agent/log/pudulogs/all_logs.log
START=$(date -u +%Y-%m-%d)
echo "PUBLIC: 클라우드 접속 기록(오늘) $(grep "$START" $L | grep -c 'iot connected')회"
if [ -f ops/agent-check.sh ]; then bash ops/agent-check.sh; fi
echo "PUBLIC: 워커 배송 로그 $(docker compose logs --since 2m worker 2>&1 | grep -E 'DELIVERY|배송' | sed 's/.*\] //' | tail -6 | tr '\n' '|')"
