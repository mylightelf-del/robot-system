import React from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Link } from "expo-router";
import { api, type ReportRow } from "../../lib/api";
import { useFetch } from "../../lib/useFetch";
import { fmtDateTime } from "../../lib/format";
import { Badge, C, Empty, ErrorBox, Loading, s } from "../../components/ui";
import { REPORT_STATUS_LABEL } from "../../../../src/lib/domain/status";

const TONE: Record<ReportRow["status"], { fg: string; bg: string }> = { DRAFT: { fg: C.gray, bg: C.grayBg }, REVIEW: { fg: C.amber, bg: C.amberBg }, CONFIRMED: { fg: C.blue, bg: C.blueBg }, PUBLISHED: { fg: C.green, bg: C.greenBg } };

/** 보고서 탭: 목록(고객은 확정·공개본만 온다). 작성·수정은 웹에서. */
export default function ReportsScreen() {
  const q = useFetch(() => api<{ reports: ReportRow[] }>("GET", "/reports"), [], { intervalMs: null });
  if (q.loading && !q.data) return <Loading />;
  if (!q.data) return <ErrorBox text={q.error ?? "불러오지 못했습니다."} onRetry={q.reload} />;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content} refreshControl={<RefreshControl refreshing={q.refreshing} onRefresh={q.reload} />}>
      <Text style={s.sub}>보고서 작성·검토·수치 보정·PPT/Excel 은 웹에서 합니다. 앱에서는 열람만 합니다.</Text>
      {q.data.reports.length === 0 && <Empty text="보고서가 없습니다." />}
      {q.data.reports.map((r) => (
        <Link key={r.id} href={`/reports/${encodeURIComponent(r.id)}`} asChild>
          <Pressable style={s.card}>
            <View style={s.row}>
              <Badge text={REPORT_STATUS_LABEL[r.status]} fg={TONE[r.status].fg} bg={TONE[r.status].bg} />
              <Text style={s.sub}>v{r.version}{r.isLatestVersion ? "" : " (이전 버전)"}</Text>
            </View>
            <Text style={s.h2}>
              {r.siteName} · {r.title}
            </Text>
            <Text style={s.sub}>
              기간 {r.periodStart} ~ {r.periodEnd} · 작성 {fmtDateTime(r.createdAt)}
              {r.publishedAt ? ` · 공개 ${fmtDateTime(r.publishedAt)}` : ""}
            </Text>
          </Pressable>
        </Link>
      ))}
    </ScrollView>
  );
}
