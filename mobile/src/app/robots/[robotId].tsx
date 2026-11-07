import React, { useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Link, Stack, useLocalSearchParams } from "expo-router";
import { api, errorText, type CommandResponse, type CommandType, type RobotDetail } from "../../lib/api";
import { useFetch } from "../../lib/useFetch";
import { fmtDateTime, num, relative } from "../../lib/format";
import { Button, Card, C, CommandStateBadge, ErrorBox, IncidentStatusBadge, KV, Loading, s, SeverityBadge, StatusBadge } from "../../components/ui";
import { COMMAND_LABEL, RUN_RESULT_LABEL } from "../../../../src/lib/domain/status";
import { MODEL_LABEL, VENDOR_LABEL } from "../../../../src/lib/domain/commands";

/**
 * 로봇 상세 + 명령.
 * - 명령 버튼은 서버가 준 allowedCommands(역할·사업장 스위치·명령 권한 반영)만 보인다. 그래도 최종 판정은 서버가 한다.
 * - 버튼 → 확인 대화상자 → 전송(멱등 키 1회 생성, 재시도에도 같은 키) → "접수됨" 표시 → 상태 재조회로 실행 확인.
 * - HTTP 접수를 완료로 표시하지 않는다(웹과 같은 규칙).
 */
export default function RobotScreen() {
  const { robotId } = useLocalSearchParams<{ robotId: string }>();
  const q = useFetch(() => api<RobotDetail>("GET", `/robots/${encodeURIComponent(robotId)}`), [robotId], { intervalMs: 15_000 });
  const [sending, setSending] = useState(false);
  const [lastMsg, setLastMsg] = useState<string | null>(null);
  if (q.loading && !q.data) return <Loading />;
  if (!q.data) return <ErrorBox text={q.error ?? "불러오지 못했습니다."} onRetry={q.reload} />;
  const d = q.data;
  const tz = d.site.timezone;

  const send = (type: CommandType, params?: Record<string, unknown>) => {
    const label = COMMAND_LABEL[type];
    Alert.alert(`${label} 명령`, `${d.robot.name}(${d.site.name})에 '${label}' 을 보낼까요?${d.isSimulation ? "\n(시뮬레이션 — 실제 로봇에는 전송되지 않습니다)" : "\n실제 로봇이 움직입니다. 현장 안전을 확인하세요."}`, [
      { text: "취소", style: "cancel" },
      {
        text: "보내기",
        style: type === "STOP" ? "destructive" : "default",
        onPress: async () => {
          setSending(true);
          setLastMsg(null);
          const idempotencyKey = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
          try {
            const r = await api<CommandResponse>("POST", `/robots/${encodeURIComponent(d.robot.id)}/commands`, { type, params: params ?? {}, idempotencyKey });
            setLastMsg(`${label}: ${r.message}`);
          } catch (e) {
            setLastMsg(`${label} 실패: ${errorText(e)}`);
          } finally {
            setSending(false);
            void q.reloadSilent();
          }
        },
      },
    ]);
  };

  const startTask = () => {
    if (d.tasks.length === 0) return Alert.alert("등록 작업 없음", "이 로봇에 등록된 작업이 없습니다. 웹의 작업·일정에서 등록하세요.");
    if (d.tasks.length === 1) return send("START_TASK", { taskId: d.tasks[0].id });
    Alert.alert("실행할 작업", undefined, [...d.tasks.slice(0, 6).map((t) => ({ text: t.name, onPress: () => send("START_TASK", { taskId: t.id }) })), { text: "취소", style: "cancel" as const }]);
  };

  const commandButtons = d.allowedCommands.filter((c) => c !== "AREA_CLEAN"); // 영역 지정은 지도 조작이 필요해 웹에서만
  return (
    <>
      <Stack.Screen options={{ title: d.robot.name }} />
      <ScrollView style={s.screen} contentContainerStyle={s.content} refreshControl={<RefreshControl refreshing={q.refreshing} onRefresh={q.reload} />}>
        <Card title={d.robot.name} right={<StatusBadge status={d.status.common} />}>
          <KV k="사업장 · 층" v={`${d.site.name} · ${d.floor.name}`} />
          <KV k="제조사 · 모델" v={`${VENDOR_LABEL[d.robot.vendor as keyof typeof VENDOR_LABEL] ?? d.robot.vendor} · ${MODEL_LABEL[d.robot.model as keyof typeof MODEL_LABEL] ?? d.robot.model}`} />
          <KV k="배터리" v={d.status.batteryPct === null ? "미수신" : `${d.status.batteryPct}%`} />
          <KV k="진행" v={d.status.progressPct === null ? "-" : `${d.status.progressPct}%`} />
          <KV k="마지막 수신" v={`${fmtDateTime(d.status.lastReceivedAt, tz)} (${relative(d.status.lastReceivedAt, d.now)})`} />
          <KV k="위치" v={!d.status.pose ? "없음" : d.status.poseIsLastKnown ? "마지막 보고 위치(오프라인)" : "현재 위치"} />
          {d.mapMismatch && <Text style={{ color: C.amber, fontSize: 12 }}>로봇이 보고한 지도 버전이 현재 지도와 다릅니다(영역 명령 차단).</Text>}
          {!d.robot.active && <Text style={{ color: C.red, fontSize: 12 }}>사용 중지된 로봇입니다.</Text>}
          {d.robot.internalNote ? <Text style={s.sub}>내부 메모: {d.robot.internalNote}</Text> : null}
        </Card>

        <Card title="명령">
          {!d.site.remoteControlEnabled ? (
            <Text style={s.sub}>이 사업장은 원격 제어가 꺼져 있습니다. 본사 관리자가 웹 관리 설정 → 원격 제어에서 켤 수 있습니다.</Text>
          ) : commandButtons.length === 0 ? (
            <Text style={s.sub}>이 계정은 이 로봇에 명령 권한이 없습니다.</Text>
          ) : (
            <>
              <Text style={s.sub}>{d.isSimulation ? "시뮬레이션 로봇 — 실제 전송 없음" : "실제 로봇입니다. 확인 대화상자 뒤에 전송됩니다."}</Text>
              <View style={s.row}>
                {commandButtons.map((c) => (
                  <Button key={c} title={COMMAND_LABEL[c]} small variant={c === "STOP" ? "danger" : c === "START_TASK" || c === "RESUME" ? "primary" : "secondary"} disabled={sending} onPress={() => (c === "START_TASK" ? startTask() : send(c))} />
                ))}
              </View>
            </>
          )}
          {lastMsg && <Text style={[s.body, { color: lastMsg.includes("실패") ? C.red : C.navy }]}>{lastMsg}</Text>}
          <Text style={[s.sub, { fontSize: 11 }]}>접수(ACCEPTED)는 제조사 서버가 받았다는 뜻이며 실행 확인은 아래 명령 이력·로봇 상태로 합니다. 15초마다 자동 갱신.</Text>
        </Card>

        <Card title="명령 이력">
          {d.commands.length === 0 && <Text style={s.sub}>없음</Text>}
          {d.commands.slice(0, 10).map((c) => (
            <View key={c.id} style={s.listItem}>
              <View style={[s.row, { justifyContent: "space-between" }]}>
                <Text style={s.body}>
                  {COMMAND_LABEL[c.type]} {c.origin?.channel === "app" ? <Text style={{ color: C.blue, fontSize: 11 }}>앱{c.origin.device ? ` · ${c.origin.device}` : ""}</Text> : null}
                </Text>
                <CommandStateBadge state={c.state} />
              </View>
              <Text style={s.sub}>
                {fmtDateTime(c.requestedAt, tz)}
                {c.message ? ` · ${c.message}` : ""}
              </Text>
            </View>
          ))}
        </Card>

        <Card title={`장애 (${d.incidents.length})`}>
          {d.incidents.length === 0 && <Text style={s.sub}>없음</Text>}
          {d.incidents.slice(0, 10).map((i) => (
            <Link key={i.id} href={`/incidents/${encodeURIComponent(i.id)}`} asChild>
              <Pressable style={s.listItem}>
                <View style={s.row}>
                  <SeverityBadge severity={i.severity} />
                  <IncidentStatusBadge status={i.status} />
                  <Text style={s.sub}>{fmtDateTime(i.occurredAt, tz)}</Text>
                </View>
                <Text style={s.body}>{i.customerMessage}</Text>
              </Pressable>
            </Link>
          ))}
        </Card>

        <Card title="최근 작업 실적">
          {d.runs.length === 0 && <Text style={s.sub}>없음</Text>}
          {d.runs.slice(0, 10).map((r) => (
            <View key={r.id} style={s.listItem}>
              <Text style={s.body}>
                {fmtDateTime(r.startedAt, tz)} · {RUN_RESULT_LABEL[r.result] ?? r.result}
              </Text>
              <Text style={s.sub}>
                {num(r.areaM2)}㎡ · {num(r.durationMin)}분{r.endReason ? ` · ${r.endReason}` : ""}
              </Text>
            </View>
          ))}
        </Card>

        <Card title="소모품 · 점검">
          {d.maintenance.map((m) => (
            <KV key={m.name} k={m.name} v={m.remainingPct === null ? (m.source === "UNSUPPORTED" ? "미지원" : "미수신") : `${m.remainingPct}%`} />
          ))}
          {d.inspections.filter((i) => !i.doneAt).slice(0, 5).map((i) => (
            <Text key={i.id} style={s.sub}>
              • 점검 예정: {i.item} ({fmtDateTime(i.dueAt, tz)}) — 완료 처리는 웹에서
            </Text>
          ))}
        </Card>
      </ScrollView>
    </>
  );
}
