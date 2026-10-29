import { getOptionalUser } from "@/lib/auth/session";
import { getMapImage } from "@/lib/services/sites";
import { AppError } from "@/lib/util/errors";

/**
 * 보관된 제조사 지도 이미지. 세션 쿠키가 있고 그 층의 사업장에 접근 권한이 있는 사용자에게만 준다(고객사는 자기 사업장 지도만).
 * 브라우저 캐시는 1시간(private). 이미지가 바뀌면 지도 버전 ID 가 달라지므로 오래 캐시해도 안전하다.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ mapVersionId: string }> }) {
  const user = await getOptionalUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const { mapVersionId } = await ctx.params;
  try {
    const img = await getMapImage(user, decodeURIComponent(mapVersionId));
    return new Response(new Uint8Array(img.bytes), {
      status: 200,
      headers: { "Content-Type": img.contentType, "Content-Length": String(img.size), "Cache-Control": "private, max-age=3600", "Last-Modified": new Date(img.fetchedAt).toUTCString() },
    });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: e.code === "NOT_FOUND" ? 404 : 403 });
    throw e;
  }
}
