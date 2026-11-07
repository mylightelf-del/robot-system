import { json, robotsPayload, withToken } from "@/lib/api/v1";

/** GET /api/v1/robots?site= — 사용 중인 로봇과 현재 상태. */
export async function GET(req: Request) {
  return withToken(req, async ({ siteIds }) => json({ ok: true, robots: await robotsPayload(siteIds) }));
}
