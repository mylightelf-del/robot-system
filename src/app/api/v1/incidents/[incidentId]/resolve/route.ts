import { withAuth, readJson, str } from "@/lib/api/http";
import { getIncidentView, resolveIncident } from "@/lib/services/incidents";

/** 복구 처리. 본문 { note }. 복구 통보는 서비스가 수신자 설정대로 보낸다. */
export const POST = withAuth<{ incidentId: string }>(async ({ req, user, params }) => {
  const id = decodeURIComponent(params.incidentId);
  const b = await readJson(req);
  await resolveIncident(user, id, str(b.note, "note", { max: 2000 }));
  return getIncidentView(user, id);
});
