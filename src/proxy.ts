import { NextResponse, type NextRequest } from "next/server";

/**
 * 인증 전 단계의 낙관적 검사: 세션 쿠키가 없으면 로그인 화면으로 보낸다.
 * 실제 세션 검증(DB 조회·만료·비활성)은 각 화면의 getCurrentUser() 가 수행한다.
 */
// /api/webhooks/* 는 제조사 서버가 호출한다(세션 없음). 각 라우트가 자체 비밀값(예: PUDU CallbackCode)으로 검증한다.
// /sw.js·/manifest.webmanifest·/icons/ 는 홈 화면 추가(PWA)용 정적 파일 — 로그인 전에도 받을 수 있어야 한다(리디렉션되면 서비스 워커 등록 실패).
// /api/ 전체: 각 라우트가 세션(쿠키 또는 앱의 Bearer 토큰)을 스스로 검사해 401 을 돌려준다. 앱은 쿠키가 없으므로 여기서 로그인 화면으로 보내면 안 된다.
const PUBLIC_PREFIXES = ["/login", "/invite", "/_next", "/favicon.ico", "/api/", "/sw.js", "/manifest.webmanifest", "/icons/"];

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isPublic = PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`) || pathname.startsWith(p));
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", pathname + search);
  if (!isPublic && !request.cookies.get("rc_session")?.value) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
