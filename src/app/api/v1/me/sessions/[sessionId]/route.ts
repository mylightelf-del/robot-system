import { withAuth } from "@/lib/api/http";
import { revokeMySession } from "@/lib/services/auth";

/** 내 기기 끊기. 현재 기기를 끊으면 이 토큰도 즉시 무효가 된다. */
export const DELETE = withAuth<{ sessionId: string }>(async ({ user, params }) => {
  await revokeMySession(user, decodeURIComponent(params.sessionId));
  return { ok: true };
});
