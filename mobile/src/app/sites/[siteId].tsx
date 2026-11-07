import React, { useState } from "react";
import { Image, Pressable, RefreshControl, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { Link, Stack, useLocalSearchParams } from "expo-router";
import { api, getAuthToken, serverUrl, type SiteView } from "../../lib/api";
import { useFetch } from "../../lib/useFetch";
import { relative } from "../../lib/format";
import { Chip } from "../../components/Chip";
import { Card, C, ErrorBox, Loading, s, StatusBadge, statusColor } from "../../components/ui";

/**
 * 사업장 관제: 층 선택 → 지도 이미지 위에 로봇 위치(배터리 숫자, 점선=오프라인 마지막 위치) → 로봇 목록.
 * 좌표는 지도 이미지 px(서버 FloorMap 과 같은 규칙). 지도 이미지는 /api/maps/{id} 를 Bearer 로 받는다.
 */
export default function SiteScreen() {
  const { siteId } = useLocalSearchParams<{ siteId: string }>();
  const [floorId, setFloorId] = useState<string | undefined>(undefined);
  const { width } = useWindowDimensions();
  const q = useFetch(() => api<SiteView>("GET", `/sites/${encodeURIComponent(siteId)}${floorId ? `?floorId=${encodeURIComponent(floorId)}` : ""}`), [siteId, floorId]);
  if (q.loading && !q.data) return <Loading />;
  if (!q.data) return <ErrorBox text={q.error ?? "불러오지 못했습니다."} onRetry={q.reload} />;
  const v = q.data;
  const W = width - 24 - 24;
  const scale = W / v.map.widthPx;
  const H = v.map.heightPx * scale;
  const token = getAuthToken();
  return (
    <>
      <Stack.Screen options={{ title: v.site.name }} />
      <ScrollView style={s.screen} contentContainerStyle={s.content} refreshControl={<RefreshControl refreshing={q.refreshing} onRefresh={q.reload} />}>
        <Text style={s.sub}>
          {v.site.address} · {v.site.remoteControlEnabled ? "원격 제어 켜짐" : "원격 제어 꺼짐"}
        </Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }} style={{ flexGrow: 0 }}>
          {v.floors.map((f) => (
            <Chip key={f.id} label={f.name} active={f.id === v.selectedFloor.id} onPress={() => setFloorId(f.id)} />
          ))}
        </ScrollView>
        <Card title={`${v.selectedFloor.name} 지도`}>
          <View style={{ width: W, height: H, backgroundColor: "#e2e8f0", borderRadius: 8, overflow: "hidden" }}>
            {v.map.imageUrl && token ? (
              <Image source={{ uri: v.map.imageUrl.startsWith("http") ? v.map.imageUrl : serverUrl(v.map.imageUrl), headers: { Authorization: `Bearer ${token}` } }} style={{ width: W, height: H }} resizeMode="stretch" alt={`${v.selectedFloor.name} 지도`} accessibilityLabel={`${v.selectedFloor.name} 지도`} />
            ) : (
              <Text style={[s.sub, { padding: 8 }]}>샘플 지도(이미지 없음)</Text>
            )}
            {v.zones.map((z) => {
              const xs = z.polygon.map((p) => p[0]);
              const ys = z.polygon.map((p) => p[1]);
              const left = Math.min(...xs) * scale;
              const top = Math.min(...ys) * scale;
              return (
                <View key={z.id} pointerEvents="none" style={{ position: "absolute", left, top, width: (Math.max(...xs) - Math.min(...xs)) * scale, height: (Math.max(...ys) - Math.min(...ys)) * scale, borderWidth: 1, borderColor: "#94a3b8", backgroundColor: v.map.imageUrl ? "rgba(226,232,240,0.25)" : "rgba(226,232,240,0.6)", justifyContent: "flex-end" }}>
                  <Text style={{ fontSize: 9, color: C.sub, paddingLeft: 2 }} numberOfLines={1}>{z.name}</Text>
                </View>
              );
            })}
            {v.robots.map((r) => {
              if (!r.status.pose) return null;
              const c = statusColor(r.status.common);
              const x = r.status.pose.x * scale;
              const y = r.status.pose.y * scale;
              return (
                <View key={r.robot.id} pointerEvents="none" style={{ position: "absolute", left: x - 14, top: y - 14, width: 28, height: 28, borderRadius: 14, backgroundColor: r.status.poseIsLastKnown ? C.white : c.fg, borderWidth: 2, borderColor: c.fg, borderStyle: r.status.poseIsLastKnown ? "dashed" : "solid", alignItems: "center", justifyContent: "center" }}>
                  <Text style={{ fontSize: 10, fontWeight: "700", color: r.status.poseIsLastKnown ? c.fg : C.white }}>{r.status.batteryPct ?? "?"}</Text>
                </View>
              );
            })}
          </View>
          <Text style={[s.sub, { fontSize: 11 }]}>
            {v.map.imageUrl ? `제조사 지도 ${v.map.vendorMapName ?? ""}` : "샘플 지도"} · 원 안 숫자=배터리% · 점선 원=마지막 보고 위치(오프라인) · 기준 {relative(v.now)}
          </Text>
        </Card>
        <Card title={`로봇 ${v.robots.length}대`}>
          {v.robots.map((r) => (
            <Link key={r.robot.id} href={`/robots/${encodeURIComponent(r.robot.id)}`} asChild>
              <Pressable style={s.listItem}>
                <View style={[s.row, { justifyContent: "space-between" }]}>
                  <Text style={s.body}>
                    {r.robot.name} <Text style={s.sub}>{r.robot.model}</Text>
                  </Text>
                  <StatusBadge status={r.status.common} />
                </View>
                <Text style={s.sub}>
                  배터리 {r.status.batteryPct === null ? "미수신" : `${r.status.batteryPct}%`} · 마지막 수신 {relative(r.status.lastReceivedAt, v.now)}
                  {r.status.progressPct !== null ? ` · 진행 ${r.status.progressPct}%` : ""}
                  {!r.status.pose ? " · 위치 없음" : r.status.poseIsLastKnown ? " · 마지막 위치" : ""}
                </Text>
              </Pressable>
            </Link>
          ))}
        </Card>
      </ScrollView>
    </>
  );
}
