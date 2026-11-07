import { withAuth, query, bool } from "@/lib/api/http";
import { listIncidents } from "@/lib/services/incidents";

/** 장애 목록(미조치 우선). ?siteId=&includeResolved=1&dismissed=1(담당자: 삭제한 알림). 고객에게는 원시 오류·내부 메모가 빠진다. */
export const GET = withAuth(async ({ req, user }) => {
  const q = query(req);
  return { incidents: await listIncidents(user, { siteId: q.get("siteId") ?? undefined, includeResolved: bool(q.get("includeResolved")), dismissed: bool(q.get("dismissed")) }) };
});
