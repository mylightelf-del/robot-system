import React, { useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Link } from "expo-router";
import { api, type IncidentView } from "../../lib/api";
import { useFetch } from "../../lib/useFetch";
import { useAuth } from "../../lib/auth";
import { fmtDateTime, relative } from "../../lib/format";
import { Empty, ErrorBox, IncidentStatusBadge, Loading, s, SeverityBadge } from "../../components/ui";
import { Chip } from "../../components/Chip";

/** 장애 탭: 미조치 우선 목록, 사업장 필터, 복구 포함 토글. 고객에게는 고객용 문구만 온다(서버에서 걸러짐). */
export default function IncidentsScreen() {
  const { me } = useAuth();
  const [siteId, setSiteId] = useState<string>("");
  const [includeResolved, setIncludeResolved] = useState(false);
  const q = useFetch(() => api<{ incidents: IncidentView[] }>("GET", `/incidents?${new URLSearchParams({ ...(siteId ? { siteId } : {}), ...(includeResolved ? { includeResolved: "1" } : {}) })}`), [siteId, includeResolved]);
  return (
    <View style={s.screen}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 10, gap: 6 }} style={{ flexGrow: 0 }}>
        <Chip label="전체 사업장" active={!siteId} onPress={() => setSiteId("")} />
        {me?.sites.map((x) => (
          <Chip key={x.id} label={x.name} active={siteId === x.id} onPress={() => setSiteId(x.id)} />
        ))}
        <Chip label={includeResolved ? "복구 포함" : "미조치만"} active={includeResolved} onPress={() => setIncludeResolved((v) => !v)} />
      </ScrollView>
      {q.loading && !q.data ? (
        <Loading />
      ) : !q.data ? (
        <ErrorBox text={q.error ?? "불러오지 못했습니다."} onRetry={q.reload} />
      ) : (
        <ScrollView contentContainerStyle={s.content} refreshControl={<RefreshControl refreshing={q.refreshing} onRefresh={q.reload} />}>
          {q.data.incidents.length === 0 && <Empty text={includeResolved ? "장애 기록이 없습니다." : "미조치 장애가 없습니다."} />}
          {q.data.incidents.map((i) => (
            <Link key={i.id} href={`/incidents/${encodeURIComponent(i.id)}`} asChild>
              <Pressable style={s.card}>
                <View style={s.row}>
                  <SeverityBadge severity={i.severity} />
                  <IncidentStatusBadge status={i.status} />
                  <Text style={s.sub}>{relative(i.occurredAt)}</Text>
                  {i.occurrences > 1 && <Text style={s.sub}>· {i.occurrences}회 반복</Text>}
                </View>
                <Text style={s.h2}>
                  {i.robotName} <Text style={s.sub}>{i.siteName}</Text>
                </Text>
                <Text style={s.body}>{i.customerMessage}</Text>
                <Text style={s.sub}>
                  발생 {fmtDateTime(i.occurredAt)}
                  {i.assigneeName ? ` · 담당 ${i.assigneeName}` : ""}
                  {i.status !== "RESOLVED" ? ` · ${Math.round(i.minutesOpen)}분째 미조치` : ""}
                </Text>
              </Pressable>
            </Link>
          ))}
        </ScrollView>
      )}
    </View>
  );
}
