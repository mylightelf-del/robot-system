import React from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Link, router } from "expo-router";
import { api, type DashboardData, type TodoData } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useFetch } from "../../lib/useFetch";
import { fmtDateTime, num, pct, relative } from "../../lib/format";
import { Card, C, Empty, ErrorBox, Loading, SampleBanner, s, statusColor } from "../../components/ui";
import { STATUS_LABEL } from "../../../../src/lib/domain/status";
import type { CommonStatus } from "../../../../src/lib/domain/types";

const ORDER: CommonStatus[] = ["CLEANING", "CHARGING", "IDLE", "PAUSED", "RETURNING", "ERROR", "OFFLINE", "UNKNOWN"];

/** 홈: 오늘 할 일 + 전체 현황 + 사업장별 카드(웹 종합 대시보드와 같은 데이터). */
export default function HomeScreen() {
  const { me } = useAuth();
  const q = useFetch(async () => {
    const [dash, todo] = await Promise.all([api<DashboardData>("GET", "/dashboard"), api<TodoData>("GET", "/todo")]);
    return { dash, todo };
  }, []);
  const isSample = !!me?.sites.some((x) => x.isSample);
  if (q.loading && !q.data) return <Loading />;
  if (!q.data) return <ErrorBox text={q.error ?? "불러오지 못했습니다."} onRetry={q.reload} />;
  const { dash, todo } = q.data;
  const t = dash.totals;
  const todoCount = todo.missedRuns.length + todo.unacknowledgedIncidents + todo.lowConsumables.length + todo.staleRobots.length;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content} refreshControl={<RefreshControl refreshing={q.refreshing} onRefresh={q.reload} />}>
      <SampleBanner show={isSample} />
      {q.error && <ErrorBox text={`최근 갱신 실패: ${q.error}`} />}
      <Text style={s.sub}>
        {me?.user.name} · 사업장 {dash.sites.length}곳 · 기준 {fmtDateTime(dash.now)}
      </Text>

      <Card title={`오늘 할 일 ${todoCount ? `(${todoCount})` : ""}`}>
        {todoCount === 0 && <Text style={s.sub}>지금 처리할 것이 없습니다. 오늘 예정 {todo.plannedToday.total}회 중 남은 회차 {todo.plannedToday.remaining}회.</Text>}
        {todo.unacknowledgedIncidents > 0 && (
          <Pressable onPress={() => router.push("/incidents")}>
            <Text style={[s.body, { color: C.red }]}>• 미확인 장애 {todo.unacknowledgedIncidents}건 → 장애 탭</Text>
          </Pressable>
        )}
        {todo.missedRuns.slice(0, 5).map((m) => (
          <Pressable key={m.id} onPress={() => router.push(`/robots/${encodeURIComponent(m.robotId)}`)}>
            <Text style={s.body}>
              • 예정 작업 미실행: {m.siteName} · {m.robotName} · {m.taskName} ({fmtDateTime(m.plannedAt)})
            </Text>
          </Pressable>
        ))}
        {todo.lowConsumables.slice(0, 5).map((c, i) => (
          <Pressable key={`${c.robotId}-${i}`} onPress={() => router.push(`/robots/${encodeURIComponent(c.robotId)}`)}>
            <Text style={s.body}>
              • 소모품 {c.name} {c.remainingPct}%: {c.siteName} · {c.robotName}
            </Text>
          </Pressable>
        ))}
        {todo.staleRobots.slice(0, 5).map((r) => (
          <Pressable key={r.robotId} onPress={() => router.push(`/robots/${encodeURIComponent(r.robotId)}`)}>
            <Text style={s.body}>
              • 상태 미수신: {r.siteName} · {r.robotName} (마지막 {relative(r.lastReceivedAt)})
            </Text>
          </Pressable>
        ))}
        {todoCount > 0 && (
          <Text style={s.sub}>
            오늘 예정 {todo.plannedToday.total}회 · 남은 회차 {todo.plannedToday.remaining}회
          </Text>
        )}
      </Card>

      <View style={[s.row, { gap: 8 }]}>
        <Stat label="로봇" value={String(t.robotCount)} />
        <Stat label="청소 중" value={String(t.byStatus.CLEANING)} tone={C.blue} />
        <Stat label="오류" value={String(t.byStatus.ERROR)} tone={t.byStatus.ERROR ? C.red : undefined} />
        <Stat label="통신 끊김·불명" value={String(t.byStatus.OFFLINE + t.byStatus.UNKNOWN)} tone={t.byStatus.OFFLINE + t.byStatus.UNKNOWN ? C.amber : undefined} />
        <Stat label="미조치 장애" value={String(t.openIncidents)} hint={t.unacknowledgedIncidents ? `미확인 ${t.unacknowledgedIncidents}` : undefined} tone={t.openIncidents ? C.red : undefined} />
        <Stat label="당일 실적" value={`${t.todayRuns}건`} hint={`${num(t.todayAreaM2)}㎡`} />
      </View>

      <Card title="최근 7일 (전주 대비)">
        <Kpi label="작업" a={dash.week.runs} b={dash.prevWeek.runs} unit="건" />
        <Kpi label="청소 면적" a={dash.week.areaM2} b={dash.prevWeek.areaM2} unit="㎡" />
        <Kpi label="계획 완료율" a={dash.week.completionRatePct} b={dash.prevWeek.completionRatePct} unit="%" />
        <Kpi label="생산성" a={dash.week.productivityM2PerHour} b={dash.prevWeek.productivityM2PerHour} unit="㎡/h" />
        <Text style={s.sub}>30일 평균 조치 시간: {dash.mttrMin30d === null ? "해당 없음" : `${dash.mttrMin30d}분`}</Text>
      </Card>

      <Card title="사업장별 현황">
        {dash.sites.length === 0 && <Empty text="접근 가능한 사업장이 없습니다." />}
        {dash.sites.map((site) => (
          <Link key={site.siteId} href={`/sites/${encodeURIComponent(site.siteId)}`} asChild>
            <Pressable style={s.listItem}>
              <View style={[s.row, { justifyContent: "space-between" }]}>
                <Text style={s.h2}>{site.siteName}</Text>
                <Text style={s.sub}>{site.robotCount}대</Text>
              </View>
              <View style={s.row}>
                {ORDER.filter((k) => site.byStatus[k] > 0).map((k) => {
                  const c = statusColor(k);
                  return (
                    <Text key={k} style={{ color: c.fg, backgroundColor: c.bg, borderRadius: 6, paddingHorizontal: 6, fontSize: 12 }}>
                      {c.icon} {STATUS_LABEL[k]} {site.byStatus[k]}
                    </Text>
                  );
                })}
              </View>
              <Text style={s.sub}>
                당일 {site.todayRuns}건 · {num(site.todayAreaM2)}㎡ · 7일 완료율 {pct(site.week.completionRatePct)}
                {site.openIncidents ? ` · 미조치 장애 ${site.openIncidents}건${site.unacknowledgedIncidents ? `(미확인 ${site.unacknowledgedIncidents})` : ""}` : ""}
              </Text>
            </Pressable>
          </Link>
        ))}
      </Card>
    </ScrollView>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <View style={s.stat}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={[s.statValue, tone ? { color: tone } : null]}>{value}</Text>
      {hint && <Text style={s.statLabel}>{hint}</Text>}
    </View>
  );
}

function Kpi({ label, a, b, unit }: { label: string; a: number | null; b: number | null; unit: string }) {
  const diff = a !== null && b !== null ? Math.round((a - b) * 10) / 10 : null;
  const tone = diff === null || diff === 0 ? C.sub : diff > 0 ? C.green : C.red;
  return (
    <View style={[s.row, { justifyContent: "space-between" }]}>
      <Text style={s.sub}>{label}</Text>
      <Text style={s.body}>
        {a === null ? "해당 없음" : `${a.toLocaleString("ko-KR")}${unit}`} <Text style={{ color: tone, fontSize: 12 }}>{diff === null ? "" : diff === 0 ? "(변동 없음)" : `(${diff > 0 ? "+" : ""}${diff}${unit})`}</Text>
      </Text>
    </View>
  );
}
