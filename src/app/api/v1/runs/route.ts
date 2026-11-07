import { error, json, parseRange, runsPayload, withToken } from "@/lib/api/v1";

/** GET /api/v1/runs?site=&from=YYYY-MM-DD&to=YYYY-MM-DD — 청소 실적(시작 시각 기준, 최대 31일·1000건). */
export async function GET(req: Request) {
  return withToken(req, async ({ siteIds, q }) => {
    const range = parseRange(q);
    if ("error" in range) return error(400, range.error);
    const runs = await runsPayload(siteIds, range.fromIso, range.toIso);
    return json({ ok: true, from: range.fromIso, to: range.toIso, count: runs.length, runs });
  });
}
