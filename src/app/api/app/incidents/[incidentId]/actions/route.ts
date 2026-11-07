import { withAuth, readJson, str } from "@/lib/api/http";
import { addIncidentAction, getIncidentView } from "@/lib/services/incidents";

/** 조치 등록. 본문 { note, internal? } — internal=true 면 고객에게 보이지 않는 내부 메모. */
export const POST = withAuth<{ incidentId: string }>(async ({ req, user, params }) => {
  const id = decodeURIComponent(params.incidentId);
  const b = await readJson(req);
  await addIncidentAction(user, id, str(b.note, "note", { required: true, max: 2000 }), b.internal === true);
  return getIncidentView(user, id);
});
