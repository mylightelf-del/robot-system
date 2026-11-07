import React from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { api, type InboxItem } from "../lib/api";
import { useFetch } from "../lib/useFetch";
import { fmtDateTime } from "../lib/format";
import { routeForNotification } from "../lib/push";
import { C, Empty, ErrorBox, Loading, s } from "../components/ui";
import { NOTIFY_CHANNEL_LABEL, NOTIFY_KIND_LABEL } from "../../../src/lib/domain/types";

/** 알림함: 나에게 보낸 통보 기록(이메일·카카오톡·푸시 공통). 누르면 해당 화면으로. */
export default function NotificationsScreen() {
  const q = useFetch(() => api<{ notifications: InboxItem[] }>("GET", "/notifications?limit=100"), []);
  if (q.loading && !q.data) return <Loading />;
  if (!q.data) return <ErrorBox text={q.error ?? "불러오지 못했습니다."} onRetry={q.reload} />;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content} refreshControl={<RefreshControl refreshing={q.refreshing} onRefresh={q.reload} />}>
      {q.data.notifications.length === 0 && <Empty text="받은 알림이 없습니다. 내 계정에서 푸시를 켜고 사업장을 구독하세요." />}
      {q.data.notifications.map((n) => (
        <Pressable key={n.id} style={s.card} onPress={() => router.push(routeForNotification({ kind: n.kind, refId: n.incidentId ?? n.refId ?? "" }) as never)}>
          <View style={[s.row, { justifyContent: "space-between" }]}>
            <Text style={s.body}>{NOTIFY_KIND_LABEL[n.kind] ?? n.kind}</Text>
            <Text style={s.sub}>{fmtDateTime(n.at)}</Text>
          </View>
          <Text style={s.sub}>
            {NOTIFY_CHANNEL_LABEL[n.channel] ?? n.channel} · {n.status === "SENT" ? "발송" : n.status === "MOCK_SENT" ? "모의 발송" : "실패"} · {n.summary}
          </Text>
          <Text style={{ color: C.navy, fontSize: 12 }}>열기 ›</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
