import React, { useState } from "react";
import { Alert, RefreshControl, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { Link, Stack, useLocalSearchParams } from "expo-router";
import { api, errorText, type IncidentView } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useFetch } from "../../lib/useFetch";
import { fmtDateTime } from "../../lib/format";
import { Button, Card, C, ErrorBox, IncidentStatusBadge, KV, Loading, s, SeverityBadge } from "../../components/ui";
import { NOTIFY_CHANNEL_LABEL } from "../../../../src/lib/domain/types";

/**
 * 장애 상세·조치. 현장/본사만 확인·담당·조치·복구 버튼이 보인다(서버가 다시 검사).
 * 되돌리기·삭제는 웹에서만. 고객에게는 고객용 문구와 외부 조치만 온다.
 */
export default function IncidentScreen() {
  const { incidentId } = useLocalSearchParams<{ incidentId: string }>();
  const { me } = useAuth();
  const staff = me?.user.role === "HQ_ADMIN" || me?.user.role === "SITE_MANAGER";
  const q = useFetch(() => api<IncidentView>("GET", `/incidents/${encodeURIComponent(incidentId)}`), [incidentId]);
  const [note, setNote] = useState("");
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (q.loading && !q.data) return <Loading />;
  if (!q.data) return <ErrorBox text={q.error ?? "불러오지 못했습니다."} onRetry={q.reload} />;
  const i = q.data;

  const act = async (path: string, body?: unknown, done?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await api("POST", `/incidents/${encodeURIComponent(i.id)}/${path}`, body);
      setMsg(done ?? "처리했습니다.");
      setNote("");
      await q.reloadSilent();
    } catch (e) {
      setMsg(`실패: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const assign = async () => {
    try {
      const { users } = await api<{ users: { id: string; name: string }[] }>("GET", "/incidents/assignees");
      Alert.alert("담당자 지정", undefined, [...users.slice(0, 8).map((u) => ({ text: u.name, onPress: () => void act("assign", { assigneeId: u.id }, `${u.name} 에게 지정했습니다.`) })), { text: "취소", style: "cancel" as const }]);
    } catch (e) {
      setMsg(`실패: ${errorText(e)}`);
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: `${i.robotName} 장애` }} />
      <ScrollView style={s.screen} contentContainerStyle={s.content} refreshControl={<RefreshControl refreshing={q.refreshing} onRefresh={q.reload} />}>
        <Card>
          <View style={s.row}>
            <SeverityBadge severity={i.severity} />
            <IncidentStatusBadge status={i.status} />
            {i.occurrences > 1 && <Text style={s.sub}>{i.occurrences}회 반복</Text>}
          </View>
          <Text style={s.h2}>{i.customerMessage}</Text>
          {i.rawMessage ? <Text style={s.sub}>원시 메시지: {i.rawMessage}</Text> : null}
          <KV k="사업장" v={i.siteName} />
          <KV
            k="로봇"
            v={
              <Link href={`/robots/${encodeURIComponent(i.robotId)}`}>
                <Text style={{ color: C.navy }}>{i.robotName} ›</Text>
              </Link>
            }
          />
          <KV k="코드" v={i.code} />
          <KV k="발생" v={fmtDateTime(i.occurredAt)} />
          {i.lastOccurredAt && <KV k="최근 발생" v={fmtDateTime(i.lastOccurredAt)} />}
          <KV k="확인" v={i.acknowledgedAt ? fmtDateTime(i.acknowledgedAt) : "-"} />
          <KV k="담당자" v={i.assigneeName ?? "-"} />
          <KV k="복구" v={i.resolvedAt ? fmtDateTime(i.resolvedAt) : `${Math.round(i.minutesOpen)}분째 미조치`} />
        </Card>

        {staff && i.status !== "RESOLVED" && (
          <Card title="조치">
            <View style={s.row}>
              {i.status === "OPEN" && <Button title="확인" small disabled={busy} onPress={() => act("ack", undefined, "확인 처리했습니다.")} />}
              <Button title="담당자 지정" small variant="secondary" disabled={busy} onPress={assign} />
            </View>
            <TextInput style={[s.input, { minHeight: 70, textAlignVertical: "top" }]} multiline placeholder="조치 내용(예: 현장 확인 후 장애물 제거)" placeholderTextColor={C.sub} value={note} onChangeText={setNote} />
            <View style={[s.row, { justifyContent: "space-between" }]}>
              <Text style={s.sub}>내부 메모(고객 비노출)</Text>
              <Switch value={internal} onValueChange={setInternal} />
            </View>
            <View style={s.row}>
              <Button title="조치 등록" small variant="secondary" disabled={busy || !note.trim()} onPress={() => act("actions", { note: note.trim(), internal }, "조치를 등록했습니다.")} />
              <Button
                title="복구 처리"
                small
                disabled={busy}
                onPress={() => Alert.alert("복구 처리", "장애를 복구 상태로 바꾸고 수신자에게 복구 통보를 보냅니다.", [{ text: "취소", style: "cancel" }, { text: "복구", onPress: () => void act("resolve", { note: note.trim() }, "복구 처리했습니다.") }])}
              />
            </View>
            {msg && <Text style={{ color: msg.startsWith("실패") ? C.red : C.navy }}>{msg}</Text>}
            <Text style={[s.sub, { fontSize: 11 }]}>되돌리기·알림 삭제는 웹에서 합니다.</Text>
          </Card>
        )}

        <Card title={`조치 기록 (${i.actions.length})`}>
          {i.actions.length === 0 && <Text style={s.sub}>없음</Text>}
          {i.actions.map((a) => (
            <View key={a.id} style={s.listItem}>
              <Text style={s.body}>
                {a.note} {a.internal ? <Text style={{ color: C.amber, fontSize: 11 }}>내부</Text> : null}
              </Text>
              <Text style={s.sub}>{fmtDateTime(a.at)}</Text>
            </View>
          ))}
        </Card>

        {i.notifications.length > 0 && (
          <Card title="알림 발송 기록">
            {i.notifications.slice(0, 10).map((n) => (
              <Text key={n.id} style={s.sub}>
                • {fmtDateTime(n.at)} · {NOTIFY_CHANNEL_LABEL[n.channel] ?? n.channel} · {n.status === "SENT" ? "발송" : n.status === "MOCK_SENT" ? "모의" : n.status === "SUPPRESSED" ? "억제" : "실패"} · {n.reason}
              </Text>
            ))}
          </Card>
        )}
      </ScrollView>
    </>
  );
}
