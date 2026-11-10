import { vendorMode } from "@/lib/vendors";
import { decryptCzWebhook, ingestCzEvent, timestampFresh, WebhookDecryptError, type CzEvent } from "@/lib/vendors/cenobots/webhook";

/**
 * CZ Robots(CenoBots) 웹훅 수신 endpoint. 문서: docs/vendors/cenobots/openapi_v1.0.18.txt 「Webhook Integration Guide」.
 * - 3초 안에 연결, 5초 안에 응답해야 하고 리다이렉트를 따르지 않는다 → 원문 저장만 하고 바로 200, 처리는 워커.
 * - 시크릿(CENOBOTS_WEBHOOK_SECRET) 없음 또는 연동 꺼짐(CENOBOTS_MODE=unconfigured) → 503(업체가 한 번 재시도 후 포기).
 * - 시각 헤더 5분 초과·복호화 실패 → 401(재시도 없음).
 */
export async function POST(req: Request) {
  const secret = process.env.CENOBOTS_WEBHOOK_SECRET;
  if (!secret || vendorMode("CENOBOTS") === "unconfigured" || vendorMode("CENOBOTS") === "sample") return Response.json({ ok: false, error: "webhook not configured" }, { status: 503 });
  const traceId = req.headers.get("x-webhook-id");
  if (!traceId || !timestampFresh(req.headers.get("x-webhook-timestamp"))) {
    console.warn(`[cenobots-webhook ${new Date().toISOString()}] 거부 401 — ${traceId ? "시각 헤더 5분 초과(서버 시계 확인)" : "X-Webhook-Id 없음"}`);
    return Response.json({ error: "stale or missing webhook headers" }, { status: 401 });
  }
  const MAX = 256 * 1024;
  if (Number(req.headers.get("content-length") ?? 0) > MAX) return Response.json({ error: "payload too large" }, { status: 413 });
  let msg;
  try {
    const text = await req.text();
    if (text.length > MAX) return Response.json({ error: "payload too large" }, { status: 413 });
    msg = decryptCzWebhook(secret, JSON.parse(text));
  } catch (e) {
    console.warn(`[cenobots-webhook ${new Date().toISOString()}] 거부 401 — ${e instanceof WebhookDecryptError ? "복호화 실패(시크릿 불일치 또는 변조)" : "JSON 형식 오류"}`);
    return Response.json({ error: "unable to decrypt webhook message" }, { status: 401 });
  }
  if (msg.messageType === "challenge") {
    console.log(`[cenobots-webhook ${new Date().toISOString()}] 구독 검증(challenge) 응답`);
    return Response.json({ challenge: (msg.data as { challenge?: unknown })?.challenge ?? "" });
  }
  const ev = msg.data as unknown as CzEvent;
  const r = await ingestCzEvent(ev, traceId);
  if (!r.ignored) console.log(`[cenobots-webhook ${new Date().toISOString()}] 수신 ${ev.type} — ${r.stored ? "저장" : "중복"}`);
  return Response.json({ received: true, stored: r.stored, duplicate: r.duplicate });
}

export async function GET() {
  return Response.json({ ok: true, endpoint: "cenobots-webhook", method: "POST" });
}
