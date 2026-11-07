import { withAuth } from "@/lib/api/http";
import { listMySessions } from "@/lib/services/auth";

/** 내 로그인된 기기(웹·앱). 토큰 원문은 없다. */
export const GET = withAuth(async ({ user, session }) => ({ sessions: await listMySessions(user, session.id) }));
