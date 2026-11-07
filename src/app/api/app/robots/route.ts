import { withAuth, query, bool } from "@/lib/api/http";
import { listRobots } from "@/lib/services/robots";

/** 로봇 목록(상태 포함). ?siteId= 필터, ?includeInactive=1 로 사용 중지 로봇 포함(담당자). */
export const GET = withAuth(async ({ req, user }) => {
  const q = query(req);
  return { robots: await listRobots(user, q.get("siteId") ?? undefined, { includeInactive: bool(q.get("includeInactive")) }) };
});
