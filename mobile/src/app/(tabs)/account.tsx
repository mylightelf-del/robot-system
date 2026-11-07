import React, { useState } from "react";
import { Alert, Linking, Pressable, RefreshControl, ScrollView, Switch, Text, View } from "react-native";
import { api, errorText, type SessionRow, type Subscription } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useFetch } from "../../lib/useFetch";
import { registerPushDevice, unregisterPushDevice } from "../../lib/push";
import { fmtDateTime } from "../../lib/format";
import { APP_VERSION } from "../../lib/config";
import { Button, Card, C, Empty, ErrorBox, KV, Loading, s } from "../../components/ui";
import { ROLE_LABEL } from "../../../../src/lib/domain/status";
import { NOTIFY_CHANNEL_LABEL, NOTIFY_KIND_LABEL, NOTIFY_KINDS, type NotifyKind } from "../../../../src/lib/domain/types";

type Devices = { devices: { id: string; platform: string; deviceName: string; appVersion: string; lastSeenAt: string; disabledAt: string | null; lastError: string | null }[] };

/** 내 계정: 푸시 켜기/끄기, 내 알림 구독(앱 푸시), 로그인된 기기, 로그아웃. 비밀번호·카카오 연결은 웹에서. */
export default function AccountScreen() {
  const { me, logout, apiBaseUrl } = useAuth();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const q = useFetch(async () => {
    const [d, subs, sess] = await Promise.all([api<Devices>("GET", "/devices"), api<{ subscriptions: Subscription[] }>("GET", "/subscriptions"), api<{ sessions: SessionRow[] }>("GET", "/me/sessions")]);
    return { devices: d.devices, subs: subs.subscriptions, sessions: sess.sessions };
  }, [], { intervalMs: null });

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setMsg(null);
    try {
      const m = await fn();
      if (m) setMsg(m);
      await q.reloadSilent();
    } catch (e) {
      setMsg(errorText(e) === "처리 중 오류가 발생했습니다." && e instanceof Error ? e.message : errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!me) return <Loading />;
  const pushOn = !!q.data?.devices.some((d) => !d.disabledAt);
  const pushMode = me.notify.modes.PUSH;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content} refreshControl={<RefreshControl refreshing={q.refreshing} onRefresh={q.reload} />}>
      <Card title="계정">
        <KV k="이름" v={me.user.name} />
        <KV k="이메일" v={me.user.email} />
        <KV k="역할" v={ROLE_LABEL[me.user.role]} />
        <KV k="사업장" v={me.sites.map((x) => x.name).join(", ") || "없음"} />
        <KV k="이 기기" v={me.session.deviceName || "-"} />
      </Card>

      <Card title="푸시 알림(이 기기)">
        <View style={[s.row, { justifyContent: "space-between" }]}>
          <Text style={s.body}>{pushOn ? "켜짐" : "꺼짐"}</Text>
          <Switch
            value={pushOn}
            disabled={busy}
            onValueChange={(v) =>
              run(async () => {
                if (v) {
                  const r = await registerPushDevice();
                  return r.token ? "이 기기를 푸시 수신 기기로 등록했습니다. 아래 '내 알림 구독'에서 사업장을 고르세요." : r.reason;
                }
                await unregisterPushDevice();
                return "이 기기의 푸시를 껐습니다.";
              })
            }
          />
        </View>
        {pushMode === "mock" && <Text style={{ color: C.amber, fontSize: 12 }}>서버에 FCM 설정이 아직 없어 푸시는 모의 발송으로만 기록됩니다.</Text>}
        {q.data?.devices.map((d) => (
          <Text key={d.id} style={s.sub}>
            • {d.deviceName || d.platform} · 앱 {d.appVersion || "-"} · 최근 {fmtDateTime(d.lastSeenAt)}
            {d.disabledAt ? " · 비활성(토큰 무효 — 다시 켜기)" : d.lastError ? ` · 최근 오류: ${d.lastError}` : ""}
          </Text>
        ))}
      </Card>

      <Card title="내 알림 구독">
        {q.loading && !q.data ? (
          <Loading />
        ) : q.error && !q.data ? (
          <ErrorBox text={q.error} onRetry={q.reload} />
        ) : (
          <>
            {q.data!.subs.length === 0 && <Empty text="받는 알림이 없습니다. 아래에서 사업장을 골라 앱 푸시를 추가하세요." />}
            {q.data!.subs.map((sub) => (
              <SubRow key={sub.id} sub={sub} busy={busy} run={run} />
            ))}
            <Text style={[s.sub, { marginTop: 6 }]}>앱 푸시로 받을 사업장 추가(푸시를 먼저 켜세요)</Text>
            <View style={s.row}>
              {me.sites
                .filter((x) => !q.data!.subs.some((sub) => sub.siteId === x.id && sub.channel === "PUSH"))
                .map((x) => (
                  <Button key={x.id} title={`+ ${x.name}`} small variant="secondary" disabled={busy || !pushOn} onPress={() => run(async () => {
                    await api("POST", "/subscriptions", { siteId: x.id, channel: "PUSH" });
                    return `${x.name} 알림을 앱 푸시로 받습니다.`;
                  })} />
                ))}
            </View>
          </>
        )}
      </Card>

      <Card title="로그인된 기기 (웹·앱)">
        {q.data?.sessions.map((x) => (
          <View key={x.id} style={[s.row, { justifyContent: "space-between" }]}>
            <Text style={[s.body, { flex: 1 }]}>
              <Text style={{ color: x.kind === "app" ? C.blue : C.gray, fontSize: 12 }}>[{x.kind === "app" ? "앱" : "웹"}]</Text> {x.deviceName || "이름 없음"}
              {x.current ? <Text style={{ color: C.green, fontSize: 12 }}> · 이 기기</Text> : null}
              {"\n"}
              <Text style={s.sub}>최근 {fmtDateTime(x.lastSeenAt)}{x.pushDevices ? ` · 푸시 ${x.pushDevices}대` : ""}</Text>
            </Text>
            {!x.current && (
              <Button
                title="끊기"
                small
                variant="danger"
                disabled={busy}
                onPress={() => Alert.alert("기기 끊기", `'${x.deviceName || "이 기기"}' 의 로그인을 끊을까요?`, [{ text: "취소", style: "cancel" }, { text: "끊기", style: "destructive", onPress: () => run(async () => { await api("DELETE", `/me/sessions/${encodeURIComponent(x.id)}`); return "끊었습니다."; }) }])}
              />
            )}
          </View>
        ))}
      </Card>

      {msg && (
        <View style={[s.card, { backgroundColor: C.blueBg, borderColor: C.blueBg }]}>
          <Text style={{ color: C.navyDark }}>{msg}</Text>
        </View>
      )}

      <Card title="웹에서 하는 일">
        <Pressable onPress={() => Linking.openURL(`${apiBaseUrl}/account`)}>
          <Text style={{ color: C.navy }}>비밀번호 변경 · 카카오톡 연결 · 이메일 구독 → 웹 내 계정 열기 ›</Text>
        </Pressable>
        <Pressable onPress={() => Linking.openURL(`${apiBaseUrl}/`)}>
          <Text style={{ color: C.navy }}>관리 설정 · 보고서 작성 → 웹 관제 화면 열기 ›</Text>
        </Pressable>
        <Pressable onPress={() => Linking.openURL(`${apiBaseUrl}/privacy`)}>
          <Text style={{ color: C.navy }}>개인정보처리방침 ›</Text>
        </Pressable>
      </Card>

      <Button title="로그아웃" variant="danger" onPress={() => Alert.alert("로그아웃", "이 기기의 로그인을 끝내고 푸시도 끕니다.", [{ text: "취소", style: "cancel" }, { text: "로그아웃", style: "destructive", onPress: () => void logout() }])} />
      <Text style={[s.sub, { textAlign: "center" }]}>와이드봇 관제 앱 {APP_VERSION} · 서버 {apiBaseUrl.replace(/^https?:\/\//, "")}</Text>
    </ScrollView>
  );
}

function SubRow({ sub, busy, run }: { sub: Subscription; busy: boolean; run: (fn: () => Promise<string | void>) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [kinds, setKinds] = useState<NotifyKind[]>(sub.kinds);
  const toggle = (k: NotifyKind) => setKinds((v) => (v.includes(k) ? v.filter((x) => x !== k) : [...v, k]));
  return (
    <View style={s.listItem}>
      <View style={[s.row, { justifyContent: "space-between" }]}>
        <Text style={s.body}>
          {sub.siteName} <Text style={s.sub}>· {NOTIFY_CHANNEL_LABEL[sub.channel]} · {sub.hoursFrom}~{sub.hoursTo}</Text>
        </Text>
        <View style={s.row}>
          <Button title={editing ? "닫기" : "종류"} small variant="secondary" onPress={() => setEditing((v) => !v)} />
          <Button title="해제" small variant="danger" disabled={busy} onPress={() => Alert.alert("구독 해제", `'${sub.siteName}' ${NOTIFY_CHANNEL_LABEL[sub.channel]} 알림을 해제할까요?`, [{ text: "취소", style: "cancel" }, { text: "해제", style: "destructive", onPress: () => run(async () => { await api("DELETE", `/subscriptions/${encodeURIComponent(sub.id)}`); return "해제했습니다."; }) }])} />
        </View>
      </View>
      {!editing && <Text style={s.sub}>{sub.kinds.length === NOTIFY_KINDS.length ? "모든 통보" : sub.kinds.map((k) => NOTIFY_KIND_LABEL[k]).join(" · ")}</Text>}
      {editing && (
        <View style={{ gap: 4 }}>
          {NOTIFY_KINDS.map((k) => (
            <View key={k} style={[s.row, { justifyContent: "space-between" }]}>
              <Text style={s.body}>{NOTIFY_KIND_LABEL[k]}</Text>
              <Switch value={kinds.includes(k)} onValueChange={() => toggle(k)} />
            </View>
          ))}
          <Button title="저장" small disabled={busy || kinds.length === 0} onPress={() => run(async () => { await api("PATCH", `/subscriptions/${encodeURIComponent(sub.id)}`, { kinds }); setEditing(false); return "저장했습니다."; })} />
        </View>
      )}
    </View>
  );
}
