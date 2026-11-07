import { withAuth } from "@/lib/api/http";
import { canHandleIncidents } from "@/lib/auth/authz";
import { listAssignableUsers } from "@/lib/services/incidents";
import { ForbiddenError } from "@/lib/util/errors";

/** 담당자 지정에 고를 수 있는 사용자(현장/본사만 조회 가능). */
export const GET = withAuth(async ({ user }) => {
  if (!canHandleIncidents(user)) throw new ForbiddenError("장애 조치는 현장/본사 담당자만 할 수 있습니다.");
  return { users: await listAssignableUsers() };
});
