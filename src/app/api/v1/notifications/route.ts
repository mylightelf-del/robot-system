import { withAuth, query, int } from "@/lib/api/http";
import { myNotifications } from "@/lib/services/notify";

/** 내 알림함: 나에게 보낸 통보 기록(이메일·카카오톡·푸시 공통). ?since=ISO&limit=. 장애 통보는 incidentId 로 상세에 연결. */
export const GET = withAuth(async ({ req, user }) => {
  const q = query(req);
  return { notifications: await myNotifications(user, { since: q.get("since") ?? undefined, limit: int(q.get("limit"), 50, 1, 200) }) };
});
