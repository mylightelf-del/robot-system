import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { getOptionalUser } from "@/lib/auth/session";
import { kakaoAuthorizeUrl, kakaoConfig } from "@/lib/notify/kakao";

/** 내 계정 → '카카오톡 연결': 카카오 로그인(동의 항목 talk_message)으로 보낸다. state 는 10분짜리 쿠키로 확인(위조 콜백 차단). */
export async function GET(req: Request) {
  const user = await getOptionalUser();
  const base = new URL(req.url);
  if (!user) return Response.redirect(new URL("/login?next=/account", base), 302);
  const cfg = kakaoConfig();
  if (!cfg) return Response.redirect(new URL("/account?kakao=unconfigured", base), 302);
  const state = randomBytes(16).toString("hex");
  (await cookies()).set("kakao_state", state, { httpOnly: true, sameSite: "lax", secure: process.env.APP_ENV === "production", path: "/api/kakao", maxAge: 600 });
  return Response.redirect(kakaoAuthorizeUrl(cfg, state), 302);
}
