import { withAuth } from "@/lib/api/http";
import { bearerToken } from "@/lib/auth/session";
import { logout } from "@/lib/services/auth";

/** 앱 로그아웃: 이 토큰의 세션만 지운다. 묶인 푸시 기기도 함께 지워져 더 이상 푸시가 오지 않는다. */
export const POST = withAuth(async ({ req, user }) => {
  await logout(bearerToken(req.headers) ?? undefined, { id: user.id, name: user.name }, "app");
  return { ok: true };
});
