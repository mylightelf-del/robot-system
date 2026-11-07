import React from "react";
import { Linking, RefreshControl, ScrollView, Text } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { api, type ReportAggregates, type ReportContent, type ReportRow } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useFetch } from "../../lib/useFetch";
import { fmtDateTime, num, pct } from "../../lib/format";
import { Button, Card, ErrorBox, KV, Loading, s } from "../../components/ui";
import { REPORT_STATUS_LABEL } from "../../../../src/lib/domain/status";

type Report = Omit<ReportRow, "adjustments" | "content" | "aggregates"> & { aggregates: ReportAggregates; content: ReportContent; adjustments?: unknown };

/** 보고서 열람(집계 요약·의견). 파일(PPT·Excel)은 웹에서 내려받는다. */
export default function ReportScreen() {
  const { reportId } = useLocalSearchParams<{ reportId: string }>();
  const { apiBaseUrl } = useAuth();
  const q = useFetch(() => api<{ report: Report }>("GET", `/reports/${encodeURIComponent(reportId)}`), [reportId], { intervalMs: null });
  if (q.loading && !q.data) return <Loading />;
  if (!q.data) return <ErrorBox text={q.error ?? "불러오지 못했습니다."} onRetry={q.reload} />;
  const r = q.data.report;
  const a = r.aggregates;
  return (
    <>
      <Stack.Screen options={{ title: r.title }} />
      <ScrollView style={s.screen} contentContainerStyle={s.content} refreshControl={<RefreshControl refreshing={q.refreshing} onRefresh={q.reload} />}>
        <Card title={`${r.siteName} · ${r.title}`}>
          <KV k="상태" v={`${REPORT_STATUS_LABEL[r.status]} · v${r.version}`} />
          <KV k="기간" v={`${r.periodStart} ~ ${r.periodEnd}`} />
          <KV k="작성" v={fmtDateTime(r.createdAt)} />
          {r.confirmedAt && <KV k="확정" v={fmtDateTime(r.confirmedAt)} />}
          {r.publishedAt && <KV k="고객 공개" v={fmtDateTime(r.publishedAt)} />}
          {r.lateRuns > 0 && <Text style={s.sub}>집계 이후 수신된 실적 {r.lateRuns}건(웹에서 재집계/새 버전)</Text>}
        </Card>
        <Card title="주요 실적">
          <KV k="운영 대수" v={`${a.robotCount}대`} />
          <KV k="계획 완료율" v={`${pct(a.completionRatePct)} (${a.plannedCompleted}/${a.validPlanned})`} />
          <KV k="미실행 · 취소 · 제외" v={`${a.missed} · ${a.cancelled} · ${a.excluded}`} />
          <KV k="총 작업" v={`${a.totalRuns}건 (즉시 지시 ${a.adhocRuns}건)`} />
          <KV k="누적 청소 면적" v={`${num(a.cumulativeAreaM2)}㎡ (중복 포함)`} />
          <KV k="총 작업 시간" v={`${num(a.totalDurationMin)}분`} />
          <KV k="물 · 세제" v={`${a.waterL === null ? "미제공" : `${a.waterL}L`} · ${a.detergentMl === null ? "미제공" : `${a.detergentMl}mL`}`} />
        </Card>
        {a.byFloor.length > 0 && (
          <Card title="층별">
            {a.byFloor.map((f) => (
              <KV key={f.floorId} k={f.floorName} v={`${f.runs}건 · ${num(f.areaM2)}㎡ · ${num(f.durationMin)}분`} />
            ))}
          </Card>
        )}
        <Card title="의견">
          <KV k="종합 의견" v={r.comments.overallOpinion || "-"} />
          <KV k="미완료 사유" v={r.comments.incompleteReasons || "-"} />
          <KV k="개선 사항" v={r.comments.improvements || "-"} />
          <KV k="집중 관리 구역" v={r.comments.focusZones || "-"} />
          <KV k="차월 계획" v={r.comments.nextMonthPlan || "-"} />
        </Card>
        <Button title="웹에서 전체 보고서 · PPT/Excel 열기" variant="secondary" onPress={() => Linking.openURL(`${apiBaseUrl}/reports/${encodeURIComponent(r.id)}`)} />
      </ScrollView>
    </>
  );
}
