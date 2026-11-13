import { timingSafeEqual } from "node:crypto";
import { agentMode } from "@/lib/delivery/agent";
import { ingestAgentNotify } from "@/lib/services/delivery";

/**
 * 배송로봇 에이전트 알림 수신(docs/23). 에이전트는 서버 내부(docker 네트워크)에서 http://web:3000/api/webhooks/pudu-agent?token=… 로 보낸다.
 * 이 경로는 Caddy 를 통해 밖에서도 닿으므로 토큰(PUDU_AGENT_NOTIFY_TOKEN)으로 막는다. 원문만 저장하고 바로 응답, 처리는 워커(3초).
 */
function tokenOk(given: string | null): boolean {
  const expected = process.env.PUDU_AGENT_NOTIFY_TOKEN ?? "";
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  if (agentMode() === "unconfigured") return Response.json({ code: 503, msg: "delivery agent not configured" }, { status: 503 });
  if (!tokenOk(new URL(req.url).searchParams.get("token"))) return Response.json({ code: 401, msg: "unauthorized" }, { status: 401 });
  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > 256 * 1024) return Response.json({ code: 413, msg: "payload too large" }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return Response.json({ code: 400, msg: "invalid json" }, { status: 400 });
  }
  const r = await ingestAgentNotify(body);
  return Response.json({ code: 0, msg: "success", data: { success: true, stored: r.stored, duplicate: r.duplicate } });
}

export async function GET() {
  return Response.json({ ok: true, endpoint: "pudu-agent-notify", method: "POST" });
}
