import { getOptionalUser } from "@/lib/auth/session";
import { isCustomer } from "@/lib/auth/authz";
import { defaultContent, effectiveAggregates, getReport, loadPhotosWithData } from "@/lib/services/reports";
import { buildPptx, buildXlsx } from "@/lib/reports/export";
import { AppError } from "@/lib/util/errors";
import { audit } from "@/lib/services/audit";

export const runtime = "nodejs";

const TYPES = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;

/** 보고서 내려받기(.pptx/.xlsx). 보고서 접근 권한을 따른다(고객은 공개본만). PDF 는 화면의 'PDF 출력(인쇄)' 을 쓴다. */
export async function GET(req: Request, ctx: { params: Promise<{ reportId: string }> }) {
  const user = await getOptionalUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const format = new URL(req.url).searchParams.get("format");
  if (format !== "pptx" && format !== "xlsx") return new Response("format=pptx|xlsx", { status: 400 });
  const { reportId } = await ctx.params;
  try {
    const r = await getReport(user, decodeURIComponent(reportId));
    const input = {
      report: r,
      agg: effectiveAggregates(r),
      content: { ...defaultContent(r), ...r.content },
      photos: await loadPhotosWithData(r.id),
      includeAdjustLog: !isCustomer(user),
    };
    const buf = format === "pptx" ? await buildPptx(input) : await buildXlsx(input);
    await audit(user, { siteId: r.siteId, robotId: null, action: "REPORT:EXPORT", params: { reportId: r.id, format }, result: "OK", detail: null, vendorTraceId: null });
    const period = r.periodStart === r.periodEnd ? r.periodStart : `${r.periodStart}_${r.periodEnd}`;
    const name = `${r.siteName}_${r.title}_${period}_v${r.version}.${format}`.replace(/[\\/:*?"<>|]/g, "_");
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: { "Content-Type": TYPES[format], "Content-Length": String(buf.length), "Content-Disposition": `attachment; filename="report.${format}"; filename*=UTF-8''${encodeURIComponent(name)}`, "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: e.code === "NOT_FOUND" ? 404 : 403 });
    console.error("[export] 오류:", e);
    return new Response("내보내기 중 오류가 발생했습니다.", { status: 500 });
  }
}
