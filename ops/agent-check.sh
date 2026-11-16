# 배송 에이전트 점검(PUDU_API정의서·PUDU_Interface 기준). 공개 기록용: 결과 요약만 PUBLIC: 로 찍는다.
cd /opt/robot-system
echo "PUBLIC: 에이전트 컨테이너 $(docker compose ps pudu-agent --format '{{.Status}}' | head -1)"
docker compose exec -T worker node -e '
const u="http://pudu-agent:9050",d=process.env.PUDU_AGENT_DEVICE_ID;
const j=async(n,p)=>{const t=Date.now();try{const b=await (await fetch(u+p)).json();console.log("PUBLIC:",n,"code="+b.code,(Date.now()-t)+"ms");return b}catch(e){console.log("PUBLIC:",n,"요청 실패")}};
(async()=>{await j("장치 조회","/api/devices");
const g=await j("그룹 조회","/api/robot/groups?device="+d);const gid=g?.data?.robotGroups?.[0]?.id;
const r=await j("로봇 목록","/api/robots?device="+d+"&group_id="+gid);const rid=r?.data?.robots?.[0]?.id;
console.log("PUBLIC: 그룹 "+(g?.data?.robotGroups?.length??0)+"개 · 로봇 "+(r?.data?.robots?.length??0)+"대");
await j("그룹 상태(로봇 응답)","/api/robot/state?device_id="+d+"&group_id="+gid+"&timeout=10&count=5");
await j("로봇 상태(로봇 응답)","/api/robot/status?device_id="+d+"&robot_id="+rid);
await j("목적지(로봇 응답)","/api/destinations?device="+d+"&robot_id="+rid+"&page_size=200&page_index=1");})()'
L=agent/log/pudulogs/all_logs.log
echo "PUBLIC: 장치 재접속 $(grep -ciE 'reconnect' $L)회 · 로봇 응답 성공 $(grep -E 'user/sub : (query_state|request_data)' $L | grep -c 'doCallBack :  {')회 · 시간초과 $(grep -c 'timeout no resp' $L)회"
