import { getOptionalUser } from "@/lib/auth/session";
import { addIncidentPhoto, INCIDENT_PHOTO_MAX_BYTES } from "@/lib/services/incidents";
import { AppError } from "@/lib/util/errors";

/** 장애 조치 사진 올리기(담당자). multipart/form-data: file, caption, internal(1/0). 화면이 긴 변 1600px JPEG 로 줄여 보낸다. */
export async function POST(req: Request, ctx: { params: Promise<{ incidentId: string }> }) {
  const user = await getOptionalUser();
  if (!user) return Response.json({ ok: false, error: "로그인이 필요합니다." }, { status: 401 });
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return Response.json({ ok: false, error: "허용되지 않은 요청입니다." }, { status: 403 });
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > INCIDENT_PHOTO_MAX_BYTES + 64 * 1024) return Response.json({ ok: false, error: "사진이 너무 큽니다." }, { status: 413 });
  const { incidentId } = await ctx.params;
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ ok: false, error: "사진 파일이 없습니다." }, { status: 400 });
    const photo = await addIncidentPhoto(user, decodeURIComponent(incidentId), { caption: String(form.get("caption") ?? ""), internal: String(form.get("internal") ?? "1") !== "0", data: Buffer.from(await file.arrayBuffer()) });
    return Response.json({ ok: true, id: photo.id });
  } catch (e) {
    if (e instanceof AppError) return Response.json({ ok: false, error: e.message }, { status: e.code === "NOT_FOUND" ? 404 : e.code === "FORBIDDEN" ? 403 : 400 });
    console.error("[incident-photos] 업로드 오류:", e);
    return Response.json({ ok: false, error: "처리 중 오류가 발생했습니다." }, { status: 500 });
  }
}
