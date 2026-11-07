import { getOptionalUser } from "@/lib/auth/session";
import { getRunImage } from "@/lib/services/coverage";
import { AppError } from "@/lib/util/errors";

/** 실적의 결과 지도(청소 범위 증빙) 이미지. ?kind=result|heatmap. 로봇 접근 권한을 따른다. 보관본이 없으면 제조사에서 받아 보관한 뒤 준다. */
export async function GET(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const user = await getOptionalUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const { runId } = await ctx.params;
  const kind = new URL(req.url).searchParams.get("kind") === "heatmap" ? "HEATMAP" : "RESULT";
  try {
    const img = await getRunImage(user, decodeURIComponent(runId), kind);
    return new Response(new Uint8Array(img.data), { status: 200, headers: { "Content-Type": img.contentType, "Content-Length": String(img.data.length), "Cache-Control": "private, max-age=86400", "Last-Modified": new Date(img.fetchedAt).toUTCString() } });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: e.code === "NOT_FOUND" ? 404 : 403 });
    throw e;
  }
}
