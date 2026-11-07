import { getOptionalUser } from "@/lib/auth/session";
import { getIncidentPhotoData } from "@/lib/services/incidents";
import { AppError } from "@/lib/util/errors";

/** 장애 조치 사진 보기. 장애의 사업장 접근 권한을 따르고, 고객은 비내부 사진만 본다. */
export async function GET(_req: Request, ctx: { params: Promise<{ photoId: string }> }) {
  const user = await getOptionalUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const { photoId } = await ctx.params;
  try {
    const p = await getIncidentPhotoData(user, decodeURIComponent(photoId));
    return new Response(new Uint8Array(p.data), { status: 200, headers: { "Content-Type": p.contentType, "Content-Length": String(p.data.length), "Cache-Control": "private, max-age=86400" } });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: e.code === "NOT_FOUND" ? 404 : 403 });
    throw e;
  }
}
