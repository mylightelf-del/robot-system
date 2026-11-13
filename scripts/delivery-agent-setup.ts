/**
 * 배송로봇 에이전트 초기 설정(docs/23): 에이전트에 장치(장치 ID·비밀키·리전)를 등록하고, 알림을 보낼 우리 주소를 등록한다.
 * 에이전트 자체 설정만 하며 로봇에는 아무것도 보내지 않는다. 비밀키는 서버 .env 에서만 읽고 출력하지 않는다.
 * 사용(서버): docker compose run --rm worker npx tsx scripts/delivery-agent-setup.ts
 * 필요: PUDU_AGENT_MODE=live, PUDU_AGENT_URL, PUDU_AGENT_DEVICE_ID, PUDU_AGENT_DEVICE_SECRET, PUDU_AGENT_REGION, PUDU_AGENT_NOTIFY_TOKEN
 */
import { AgentClient, httpTransport } from "../src/lib/delivery/agent";

async function main() {
  const need = ["PUDU_AGENT_URL", "PUDU_AGENT_DEVICE_ID", "PUDU_AGENT_DEVICE_SECRET", "PUDU_AGENT_REGION", "PUDU_AGENT_NOTIFY_TOKEN"];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`서버 .env 에 없음: ${missing.join(", ")}`);
  const client = new AgentClient(httpTransport(process.env.PUDU_AGENT_URL!), process.env.PUDU_AGENT_DEVICE_ID!);
  const devices = await client.devices();
  if (devices.some((d) => d.deviceId === client.deviceId)) console.log(`장치 이미 등록됨: ${client.deviceId.slice(0, 4)}*** (${devices.length}개)`);
  else {
    await client.addDevice({ deviceId: client.deviceId, deviceSecret: process.env.PUDU_AGENT_DEVICE_SECRET!, region: process.env.PUDU_AGENT_REGION!, deviceName: "widebot" });
    console.log(`장치 등록 완료: ${client.deviceId.slice(0, 4)}***`);
  }
  // 에이전트 → 우리 앱(내부 네트워크). 토큰은 출력하지 않는다.
  const notifyBase = process.env.PUDU_AGENT_NOTIFY_BASE ?? "http://web:3000";
  await client.setNotifyUrl(`${notifyBase}/api/webhooks/pudu-agent?token=${encodeURIComponent(process.env.PUDU_AGENT_NOTIFY_TOKEN!)}`);
  console.log(`알림 주소 등록 완료: ${notifyBase}/api/webhooks/pudu-agent?token=***`);
  const groups = await client.groups();
  console.log(`로봇 그룹 ${groups.length}개: ${groups.map((g) => `${g.name || g.id}`).join(", ") || "없음"}`);
  for (const g of groups) {
    const robots = await client.robots(g.id);
    console.log(`  ${g.name || g.id}: 로봇 ${robots.length}대 ${robots.map((r) => r.name).join(", ")}`);
  }
}

main().catch((e) => {
  console.error("실패:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
