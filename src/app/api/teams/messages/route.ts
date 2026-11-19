import { handleBotActivity, replyText, teamsBotConfig, verifyBotRequest, type BotActivity } from "@/lib/notify/teamsBot";

/**
 * Teams 봇 수신 주소(Azure Bot 의 메시징 엔드포인트: https://<도메인>/api/teams/messages, docs/24).
 * Bot Framework 서명(JWT)을 검증하고, 개인 채팅의 설치·메시지에서 직원별 채팅 주소를 저장한다. 알림 발송 자체는 이 경로를 쓰지 않는다.
 */
export async function POST(req: Request) {
  const cfg = teamsBotConfig();
  if (!cfg) return Response.json({ error: "teams bot not configured" }, { status: 503 });
  let a: BotActivity;
  try {
    const text = await req.text();
    if (text.length > 256 * 1024) return Response.json({ error: "payload too large" }, { status: 413 });
    a = JSON.parse(text) as BotActivity;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const why = await verifyBotRequest(req.headers.get("authorization"), cfg, a.serviceUrl);
  if (why) return Response.json({ error: "unauthorized" }, { status: 401 });
  const r = await handleBotActivity(cfg, a);
  if (r.reply) await replyText(cfg, a, r.reply);
  return new Response(null, { status: 200 });
}

export async function GET() {
  return Response.json({ ok: true, endpoint: "teams-bot-messages", method: "POST", configured: !!teamsBotConfig() });
}
