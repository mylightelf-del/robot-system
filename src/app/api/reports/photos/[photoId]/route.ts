import { getOptionalUser } from "@/lib/auth/session";
import { getPhotoData } from "@/lib/services/reports";
import { AppError } from "@/lib/util/errors";

/** 보고서 사진 보기. 보고서 접근 권한을 따른다(고객은 공개된 보고서의 사진만). 사진은 바뀌지 않으므로 오래 캐시한다(private). */
export async function GET(_req: Request, ctx: { params: Promise<{ photoId: string }> }) {
  const user = await getOptionalUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const { photoId } = await ctx.params;
  try {
    const p = await getPhotoData(user, decodeURIComponent(photoId));
    return new Response(new Uint8Array(p.data), { status: 200, headers: { "Content-Type": p.contentType, "Content-Length": String(p.data.length), "Cache-Control": "private, max-age=86400" } });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: e.code === "NOT_FOUND" ? 404 : 403 });
    throw e;
  }
}
