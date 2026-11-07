import type { User } from "@/lib/domain/types";
import { bearerToken, resolveSession, type AuthContext, type SessionInfo } from "@/lib/auth/session";
import { AppError } from "@/lib/util/errors";

/**
 * 앱용 JSON API(`/api/v1`) 공통 처리.
 * - 인증: `Authorization: Bearer <토큰>` 만 받는다. 쿠키는 보지 않는다(브라우저가 자동으로 붙이는 쿠키로 상태 변경 요청이 들어오는 CSRF 를 원천 차단).
 * - 오류: 서비스 계층의 AppError 를 상태 코드로 바꾸고 `{ error: { code, message } }` 로 돌려준다. 그 밖의 오류는 500 + 일반 문구(내부 원문 비노출).
 * - 응답은 캐시하지 않는다(private, no-store). 시간은 ISO UTC 문자열이며 화면 표시는 앱이 사업장 시간대로 한다.
 * - 업무 규칙·권한 검사는 전부 `src/lib/services/*` 에 있다. 여기서는 입력을 읽고 넘기기만 한다.
 */
export type ApiHandler<P> = (ctx: { req: Request; user: User; session: SessionInfo; params: P }) => Promise<Response | object>;
export type PublicHandler<P> = (ctx: { req: Request; params: P }) => Promise<Response | object>;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = "HTTP",
  ) {
    super(message);
  }
}

const STATUS: Record<AppError["code"], number> = { FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, VALIDATION: 400, UNSUPPORTED: 400 };

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store", ...headers } });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: { code: e.code, message: e.message } }, e.status);
  if (e instanceof AppError) return json({ error: { code: e.code, message: e.message } }, STATUS[e.code] ?? 400);
  console.error("[api] 처리 오류:", e);
  return json({ error: { code: "INTERNAL", message: "처리 중 오류가 발생했습니다." } }, 500);
}

export const unauthorized = () => json({ error: { code: "UNAUTHORIZED", message: "로그인이 필요합니다(토큰이 없거나 만료되었습니다)." } }, 401, { "WWW-Authenticate": "Bearer" });

/** Bearer 토큰으로 사용자·세션을 찾는다. 쿠키는 보지 않는다. */
export async function authenticate(req: Request): Promise<AuthContext | null> {
  return resolveSession(bearerToken(req.headers));
}

type RouteCtx<P> = { params: Promise<P> };

/** 로그인 필수 라우트. */
export function withAuth<P = Record<string, string>>(handler: ApiHandler<P>) {
  return async (req: Request, ctx?: RouteCtx<P>): Promise<Response> => {
    try {
      const auth = await authenticate(req);
      if (!auth) return unauthorized();
      const params = (ctx ? await ctx.params : {}) as P;
      const out = await handler({ req, user: auth.user, session: auth.session, params });
      return out instanceof Response ? out : json(out);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

/** 로그인 전 라우트(로그인 자체). */
export function withoutAuth<P = Record<string, string>>(handler: PublicHandler<P>) {
  return async (req: Request, ctx?: RouteCtx<P>): Promise<Response> => {
    try {
      const params = (ctx ? await ctx.params : {}) as P;
      const out = await handler({ req, params });
      return out instanceof Response ? out : json(out);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

const MAX_BODY = 256 * 1024;

/** JSON 본문(객체)을 읽는다. 비어 있으면 {}. 너무 크거나 JSON 이 아니면 400. */
export async function readJson<T extends Record<string, unknown> = Record<string, unknown>>(req: Request): Promise<T> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "요청 본문이 너무 큽니다.", "TOO_LARGE");
  if (!text.trim()) return {} as T;
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as T;
  } catch {
    throw new HttpError(400, "요청 본문은 JSON 객체여야 합니다.", "BAD_JSON");
  }
}

export function query(req: Request): URLSearchParams {
  return new URL(req.url).searchParams;
}

export function str(v: unknown, name: string, opts: { required?: boolean; max?: number } = {}): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (opts.required && !s) throw new HttpError(400, `${name} 이(가) 필요합니다.`, "VALIDATION");
  return s.slice(0, opts.max ?? 2000);
}

export function bool(v: string | null | undefined): boolean {
  return v === "1" || v === "true";
}

export function int(v: string | null | undefined, dflt: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** 앱에 돌려주는 사용자 정보(비밀번호 해시·초대 토큰 등 없음). */
export function publicUser(u: User) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, sitePermissions: u.sitePermissions };
}
