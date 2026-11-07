import { withAuth } from "@/lib/api/http";
import { getIncidentView } from "@/lib/services/incidents";

/** 장애 상세(타임라인·조치·알림 기록). 푸시 딥링크가 여기로 온다. */
export const GET = withAuth<{ incidentId: string }>(async ({ user, params }) => getIncidentView(user, decodeURIComponent(params.incidentId)));
