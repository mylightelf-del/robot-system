import { cookies } from "next/headers";
import { getOptionalUser } from "@/lib/auth/session";
import { linkKakao } from "@/lib/notify/kakao";
import { audit } from "@/lib/services/audit";

/** 카카오 로그인 콜백: state 확인 → 토큰 교환·저장(암호화) → 내 계정으로 돌아간다. 실패 사유는 화면에 짧게만 보여 준다. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (q: string) => Response.redirect(new URL(`/account?kakao=${q}`, process.env.APP_BASE_URL || url.origin), 302);
  const user = await getOptionalUser();
  if (!user) return Response.redirect(new URL("/login?next=/account", process.env.APP_BASE_URL || url.origin), 302);
  const jar = await cookies();
  const expected = jar.get("kakao_state")?.value;
  jar.delete({ name: "kakao_state", path: "/api/kakao" });
  if (url.searchParams.get("error")) return back("denied");
  const code = url.searchParams.get("code");
  if (!code || !expected || url.searchParams.get("state") !== expected) return back("state");
  try {
    const r = await linkKakao(user.id, code);
    await audit(user, { siteId: null, robotId: null, action: "NOTIFY:KAKAO_LINK", params: { kakaoUserId: r.kakaoUserId }, result: "OK", detail: null, vendorTraceId: null });
    return back("linked");
  } catch (e) {
    console.error("[kakao] 연결 실패:", (e as Error).message);
    await audit(user, { siteId: null, robotId: null, action: "NOTIFY:KAKAO_LINK", params: {}, result: "ERROR", detail: (e as Error).message.slice(0, 200), vendorTraceId: null });
    return back("error");
  }
}
