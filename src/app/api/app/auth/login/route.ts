import { withoutAuth, readJson, str, json, publicUser } from "@/lib/api/http";
import { login } from "@/lib/services/auth";
import { getUser } from "@/lib/db/repo";
import { hashToken } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db/client";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";

/**
 * 앱 로그인. 본문 { email, password, deviceName? } → { token, expiresAt, user }.
 * 토큰은 앱의 암호 저장소에만 보관하고 이후 모든 요청에 `Authorization: Bearer <token>` 으로 보낸다.
 * 실패 사유는 구분하지 않는다(계정 존재 여부 비노출). 연속 실패 잠금·감사 기록은 웹 로그인과 같은 함수.
 */
export const POST = withoutAuth(async ({ req }) => {
  const b = await readJson(req);
  const email = str(b.email, "email", { required: true, max: 200 });
  const password = str(b.password, "password", { required: true, max: 200 });
  const deviceName = str(b.deviceName, "deviceName", { max: 80 });
  const ua = req.headers.get("user-agent") ?? "";
  const r = await login(email, password, ua, { kind: "app", deviceName });
  if (!r.ok) return json({ error: { code: "UNAUTHORIZED", message: r.error } }, 401);
  const s = await getDb().query.sessions.findFirst({ where: eq(schema.sessions.id, hashToken(r.token)) });
  const user = (await getUser(s!.userId))!;
  return { token: r.token, sessionId: r.sessionId, expiresAt: r.expiresAt, user: publicUser(user) };
});
