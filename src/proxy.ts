import { NextResponse, type NextRequest } from "next/server";

/**
 * 인증 전 단계의 낙관적 검사: 세션 쿠키가 없으면 로그인 화면으로 보낸다.
 * 실제 세션 검증(DB 조회·만료·비활성)은 각 화면의 getCurrentUser() 가 수행한다.
 */
const PUBLIC_PREFIXES = ["/login", "/invite", "/_next", "/favicon.ico", "/api/health"];

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
