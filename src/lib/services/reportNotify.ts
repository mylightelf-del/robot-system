import type { User } from "@/lib/domain/types";
import { getDb, schema } from "@/lib/db/client";
import { getNotificationSetting, getSite } from "@/lib/db/repo";
import { assertActive, isCustomer } from "@/lib/auth/authz";
import { ForbiddenError, ValidationError } from "@/lib/util/errors";
import { nowIso } from "@/lib/util/time";
import { notifyRecipients } from "@/lib/notify/notifier";
import { buildPptx, buildXlsx } from "@/lib/reports/export";
import { audit } from "./audit";
import { defaultContent, effectiveAggregates, getReport, loadPhotosWithData } from "./reports";

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * 보고서 발송: 사업장 수신자 중 '보고서 발행' 종류를 받는 사람에게 이메일(PPT·Excel 첨부)·카카오톡(요약+링크)으로 보낸다.
 * - 고객 공개(publish) 때 자동, 그 뒤 담당자가 수동으로 다시 보낼 수 있다(확정본·공개본만).
 * - 첨부는 고객용(보정 내역 시트 없음). 수신 시간대는 적용하지 않는다(보고서는 밤에 받아도 된다).
 * - 발송 기록은 notification_logs(kind=REPORT, refId=보고서 ID)와 감사 기록 REPORT:NOTIFY 에 남는다.
 */
export async function sendReportNotifications(user: User, reportId: string, trigger: "PUBLISH" | "MANUAL"): Promise<{ sent: number; suppressed: number; failed: number; recipients: number }> {
  assertActive(user);
  if (isCustomer(user)) throw new ForbiddenError("보고서 발송은 현장/본사 담당자만 할 수 있습니다.");
  const r = await getReport(user, reportId);
  if (r.status !== "CONFIRMED" && r.status !== "PUBLISHED") throw new ValidationError("확정된 보고서만 발송할 수 있습니다.");
  const db = getDb();
  const site = await getSite(r.siteId, db);
  const setting = await getNotificationSetting(r.siteId, db);
  const now = nowIso();
  const tz = site?.timezone ?? "Asia/Seoul";
  const base = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  const period = r.periodStart === r.periodEnd ? r.periodStart : `${r.periodStart}~${r.periodEnd}`;
  const a = effectiveAggregates(r);
  const fmt = (n: number) => n.toLocaleString("ko-KR");
  const logs = await notifyRecipients(setting, r.siteId, now, tz, { kind: "REPORT", label: "보고서 발행", applyHours: false, refId: r.id }, async () => {
    const input = { report: r, agg: a, content: { ...defaultContent(r), ...r.content }, photos: await loadPhotosWithData(r.id), includeAdjustLog: false };
    const safe = `${r.siteName}_${r.title}_${period.replace("~", "_")}_v${r.version}`.replace(/[\\/:*?"<>|]/g, "_");
    const [pptx, xlsx] = await Promise.all([buildPptx(input), buildXlsx(input)]);
    return {
      subject: `[청소로봇 보고서] ${r.siteName} ${r.title} (${period}) v${r.version}`.slice(0, 150),
      title: `[보고서 발행] ${r.siteName} · ${r.title}`,
      lines: [
        `기간: ${period}`,
        `운영 대수: ${fmt(a.robotCount)}대`,
        `계획 완료율: ${a.completionRatePct === null ? "해당 없음" : `${a.completionRatePct}%`} (${fmt(a.plannedCompleted)}/${fmt(a.validPlanned)}회)`,
        `총 작업: ${fmt(a.totalRuns)}회 · 청소 면적 ${fmt(a.cumulativeAreaM2)}㎡ · 작업 시간 ${fmt(a.totalDurationMin)}분`,
        `장애: ${fmt(a.incidents.length)}건`,
        ...(r.comments.overallOpinion ? [`종합 의견: ${r.comments.overallOpinion.slice(0, 300)}`] : []),
        "첨부: PPT·Excel(이메일에만). 카카오톡은 링크에서 내려받으세요.",
      ],
      url: `${base}/reports/${encodeURIComponent(r.id)}`,
      attachments: [
        { filename: `${safe}.pptx`, contentType: PPTX, data: pptx },
        { filename: `${safe}.xlsx`, contentType: XLSX, data: xlsx },
      ],
    };
  });
  if (logs.length) await db.insert(schema.notificationLogs).values(logs.map((l) => ({ ...l, incidentId: null })));
  const counts = { sent: logs.filter((l) => l.status === "SENT" || l.status === "MOCK_SENT").length, suppressed: logs.filter((l) => l.status === "SUPPRESSED").length, failed: logs.filter((l) => l.status === "FAILED").length, recipients: setting?.recipients.length ?? 0 };
  await audit(user, { siteId: r.siteId, robotId: null, action: "REPORT:NOTIFY", params: { reportId: r.id, trigger, ...counts }, result: counts.failed && !counts.sent ? "ERROR" : "OK", detail: logs.map((l) => `${l.recipient}: ${l.status}`).join(", ").slice(0, 300) || "수신자 없음", vendorTraceId: null }, db);
  return counts;
}

/** 이 보고서의 발송 기록(화면 표시용, 담당자만). */
export async function reportNotifyLogs(reportId: string) {
  const db = getDb();
  return db.query.notificationLogs.findMany({ where: (t, { and, eq }) => and(eq(t.kind, "REPORT"), eq(t.refId, reportId)), orderBy: (t, { desc }) => desc(t.at) });
}
