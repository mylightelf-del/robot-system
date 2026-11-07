import React from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Link } from "expo-router";
import { api, type RobotRow, type Site } from "../../lib/api";
import { useFetch } from "../../lib/useFetch";
import { relative } from "../../lib/format";
import { Card, C, Empty, ErrorBox, Loading, s, StatusBadge } from "../../components/ui";

/** 사업장 탭: 사업장 목록 + 로봇 요약. 누르면 사업장 관제(지도). */
export default function SitesScreen() {
  const q = useFetch(async () => {
    const [sites, robots] = await Promise.all([api<{ sites: Site[] }>("GET", "/sites"), api<{ robots: RobotRow[] }>("GET", "/robots")]);
    return { sites: sites.sites, robots: robots.robots };
  }, []);
  if (q.loading && !q.data) return <Loading />;
  if (!q.data) return <ErrorBox text={q.error ?? "불러오지 못했습니다."} onRetry={q.reload} />;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content} refreshControl={<RefreshControl refreshing={q.refreshing} onRefresh={q.reload} />}>
      {q.data.sites.length === 0 && <Empty text="접근 가능한 사업장이 없습니다." />}
      {q.data.sites.map((site) => {
        const rows = q.data!.robots.filter((r) => r.robot.siteId === site.id);
        return (
          <Card
            key={site.id}
            title={site.name}
            right={
              <Link href={`/sites/${encodeURIComponent(site.id)}`} asChild>
                <Pressable hitSlop={8}>
                  <Text style={{ color: C.navy, fontWeight: "600" }}>지도 보기 ›</Text>
                </Pressable>
              </Link>
            }
          >
            <Text style={s.sub}>
              {site.address} · {site.remoteControlEnabled ? "원격 제어 켜짐" : "원격 제어 꺼짐"} · 로봇 {rows.length}대
            </Text>
            {rows.map((r) => (
              <Link key={r.robot.id} href={`/robots/${encodeURIComponent(r.robot.id)}`} asChild>
                <Pressable style={s.listItem}>
                  <View style={[s.row, { justifyContent: "space-between" }]}>
                    <Text style={s.body}>
                      {r.robot.name} <Text style={s.sub}>{r.robot.model} · {r.floor.name}</Text>
                    </Text>
                    <StatusBadge status={r.status.common} />
                  </View>
                  <Text style={s.sub}>
                    배터리 {r.status.batteryPct === null ? "미수신" : `${r.status.batteryPct}%`} · 마지막 수신 {relative(r.status.lastReceivedAt)}
                    {r.status.progressPct !== null ? ` · 진행 ${r.status.progressPct}%` : ""}
                  </Text>
                </Pressable>
              </Link>
            ))}
          </Card>
        );
      })}
    </ScrollView>
  );
}
