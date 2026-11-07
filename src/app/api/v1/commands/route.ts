import { withAuth, query, int } from "@/lib/api/http";
import { listCommands } from "@/lib/services/commands";

/** 명령 이력. ?siteId=&robotId=&limit=(기본 50, 최대 200). 고객은 본인이 낸 명령만. */
export const GET = withAuth(async ({ req, user }) => {
  const q = query(req);
  return { commands: await listCommands(user, { siteId: q.get("siteId") ?? undefined, robotId: q.get("robotId") ?? undefined, limit: int(q.get("limit"), 50, 1, 200) }) };
});
