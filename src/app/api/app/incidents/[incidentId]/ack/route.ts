import { withAuth } from "@/lib/api/http";
import { acknowledgeIncident, getIncidentView } from "@/lib/services/incidents";

/** 장애 확인. */
export const POST = withAuth<{ incidentId: string }>(async ({ user, params }) => {
  const id = decodeURIComponent(params.incidentId);
  await acknowledgeIncident(user, id);
  return getIncidentView(user, id);
});
