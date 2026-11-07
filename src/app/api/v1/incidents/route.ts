import { error, incidentsPayload, json, parseRange, withToken } from "@/lib/api/v1";

/** GET /api/v1/incidents?site=&from=&to=&status=open|resolved — 장애(요약 메시지·외부 공개 조치만). */
export async function GET(req: Request) {
  return withToken(req, async ({ siteIds, q }) => {
    const range = parseRange(q);
    if ("error" in range) return error(400, range.error);
    const incidents = await incidentsPayload(siteIds, range.fromIso, range.toIso, q.get("status"));
    return json({ ok: true, from: range.fromIso, to: range.toIso, count: incidents.length, incidents });
  });
}
