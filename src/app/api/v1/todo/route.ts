import { withAuth } from "@/lib/api/http";
import { getTodo } from "@/lib/services/dashboard";

/** 오늘 할 일(미실행 회차·미확인 장애·소모품·상태 미수신). */
export const GET = withAuth(async ({ user }) => getTodo(user));
