import { withAuth } from "@/lib/api/http";
import { isCustomer } from "@/lib/auth/authz";
import { defaultContent, effectiveAggregates, getReport } from "@/lib/services/reports";

/** 보고서 한 건: 집계(보정 반영)·내용·상태. 고객에게는 보정 내역을 주지 않는다. */
export const GET = withAuth<{ reportId: string }>(async ({ user, params }) => {
  const r = await getReport(user, decodeURIComponent(params.reportId));
  const { adjustments, ...rest } = r;
  return { report: { ...rest, aggregates: effectiveAggregates(r), content: { ...defaultContent(r), ...r.content }, ...(isCustomer(user) ? {} : { adjustments }) } };
});
