import { json, sitesPayload, withToken } from "@/lib/api/v1";

/** GET /api/v1/sites — 토큰 범위의 사업장 목록. */
export async function GET(req: Request) {
  return withToken(req, async ({ siteIds }) => json({ ok: true, sites: await sitesPayload(siteIds) }));
}
