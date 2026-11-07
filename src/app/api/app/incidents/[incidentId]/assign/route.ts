import { withAuth, readJson, str } from "@/lib/api/http";
import { assignIncident, getIncidentView } from "@/lib/services/incidents";

/** 담당자 지정. 본문 { assigneeId }. */
export const POST = withAuth<{ incidentId: string }>(async ({ req, user, params }) => {
  const id = decodeURIComponent(params.incidentId);
  const b = await readJson(req);
  await assignIncident(user, id, str(b.assigneeId, "assigneeId", { required: true, max: 100 }));
  return getIncidentView(user, id);
});
