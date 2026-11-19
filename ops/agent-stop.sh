# 배송 에이전트(pudu-agent) 끄기 + 워커의 에이전트 연동도 끔(PUDU_AGENT_MODE=unconfigured). 신형(오픈플랫폼) 경로는 그대로.
# 다시 켜기: .env 의 PUDU_AGENT_MODE=live 로 바꾸고 `docker compose --profile delivery up -d pudu-agent` 후 web·worker 재시작.
cd /opt/robot-system
docker compose --profile delivery stop pudu-agent >/dev/null 2>&1
echo "PUBLIC: 에이전트 컨테이너 $(docker compose --profile delivery ps -a pudu-agent --format '{{.Status}}' | head -1)"
if grep -q '^PUDU_AGENT_MODE=' .env; then sed -i 's/^PUDU_AGENT_MODE=.*/PUDU_AGENT_MODE=unconfigured/' .env; else echo 'PUDU_AGENT_MODE=unconfigured' >> .env; fi
echo "PUBLIC: $(grep '^PUDU_AGENT_MODE=' .env)"
docker compose up -d --force-recreate web worker >/dev/null 2>&1
sleep 15
echo "PUBLIC: health $(curl -s http://127.0.0.1:3000/api/health)"
echo "PUBLIC: 워커 배송 로그 $(docker compose logs --since 1m worker 2>&1 | grep -E '배송' | sed 's/.*\] //' | tr '\n' '|')"
