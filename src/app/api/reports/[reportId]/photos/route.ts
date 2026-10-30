import { getOptionalUser } from "@/lib/auth/session";
import { addPhoto, PHOTO_MAX_BYTES } from "@/lib/services/reports";
import { AppError } from "@/lib/util/errors";

/**
 * 보고서 사진 올리기(초안·검토 상태, 현장/본사 담당자). multipart/form-data: file, caption.
 * 화면이 긴 변 1600px JPEG 로 줄여 보낸다. 서버 액션 본문 한도(1MB)를 피하려고 라우트로 받는다.
 * 세션 쿠키는 SameSite=Lax 라 다른 사이트의 POST 에는 실리지 않고, Origin 도 같은 호스트인지 확인한다.
 */
export async function POST(req: Request, ctx: { params: Promise<{ reportId: string }> }) {
  const user = await getOptionalUser();
  if (!user) return Response.json({ ok: false, error: "로그인이 필요합니다." }, { status: 401 });
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return Response.json({ ok: false, error: "허용되지 않은 요청입니다." }, { status: 403 });
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > PHOTO_MAX_BYTES + 64 * 1024) return Response.json({ ok: false, error: "사진이 너무 큽니다." }, { status: 413 });
  const { reportId } = await ctx.params;
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ ok: false, error: "사진 파일이 없습니다." }, { status: 400 });
    const photo = await addPhoto(user, decodeURIComponent(reportId), { caption: String(form.get("caption") ?? ""), data: Buffer.from(await file.arrayBuffer()) });
    return Response.json({ ok: true, id: photo.id });
  } catch (e) {
    if (e instanceof AppError) return Response.json({ ok: false, error: e.message }, { status: e.code === "NOT_FOUND" ? 404 : e.code === "FORBIDDEN" ? 403 : 400 });
    console.error("[photos] 업로드 오류:", e);
    return Response.json({ ok: false, error: "처리 중 오류가 발생했습니다." }, { status: 500 });
  }
}
