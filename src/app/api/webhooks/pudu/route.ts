import { ingestPuduCallback } from "@/lib/vendors/pudu/webhook";

/**
 * PUDU 콜백 수신 endpoint.
 * - PUDU 는 등록된 Callback URL 로 POST { callback_type, data } 를 보내고 헤더 CallbackCode(발급 비밀)·TraceId 를 붙인다.
 * - 5초 안에 200 을 돌려줘야 하므로 원문을 DB(vendor_events)에 저장만 하고 처리는 워커가 비동기로 한다.
 * - CallbackCode 가 다르면 401. 중복(같은 이벤트 키)은 저장하지 않고 200.
 */
export async function POST(req: Request) {
  const expected = process.env.PUDU_CALLBACK_CODE;
  if (!expected) return Response.json({ ok: false, error: "callback not configured" }, { status: 503 });
  const code = req.headers.get("callbackcode") ?? req.headers.get("CallbackCode");
  if (!code || code !== expected) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const traceId = req.headers.get("traceid") ?? req.headers.get("TraceId");
  const result = await ingestPuduCallback(body, traceId);
  return Response.json({ ok: true, stored: result.stored, duplicate: result.duplicate });
}

export async function GET() {
  return Response.json({ ok: true, endpoint: "pudu-callback", method: "POST" });
}
