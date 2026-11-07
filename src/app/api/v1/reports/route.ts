import { json, reportsPayload, withToken } from "@/lib/api/v1";

/** GET /api/v1/reports?site= — 고객 공개된 보고서 목록과 요약(내려받기 링크는 로그인 세션이 필요). */
export async function GET(req: Request) {
  return withToken(req, async ({ siteIds }) => json({ ok: true, reports: await reportsPayload(siteIds) }));
}
