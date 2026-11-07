import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import type { CommonStatus, Severity, IncidentStatus, CommandState } from "../../../src/lib/domain/types";
import { COMMAND_STATE_LABEL, INCIDENT_STATUS_LABEL, SEVERITY_LABEL, STATUS_LABEL } from "../../../src/lib/domain/status";

/** 색상: 화이트·네이비 기본, 상태색은 글자와 함께 쓴다(색만으로 구분하지 않음). 웹과 같은 규칙. */
export const C = {
  navy: "#1e3a8a",
  navyDark: "#172554",
  text: "#0f172a",
  sub: "#64748b",
  border: "#e2e8f0",
  bg: "#f8fafc",
  white: "#ffffff",
  red: "#b91c1c",
  redBg: "#fee2e2",
  amber: "#b45309",
  amberBg: "#fef3c7",
  green: "#15803d",
  greenBg: "#dcfce7",
  blue: "#1d4ed8",
  blueBg: "#dbeafe",
  gray: "#475569",
  grayBg: "#f1f5f9",
  purple: "#6d28d9",
  purpleBg: "#ede9fe",
};

export function Card({ title, children, right, style }: { title?: string; children: React.ReactNode; right?: React.ReactNode; style?: ViewStyle }) {
  return (
    <View style={[s.card, style]}>
      {(title || right) && (
        <View style={s.cardHead}>
          <Text style={s.cardTitle}>{title}</Text>
          {right}
        </View>
      )}
      {children}
    </View>
  );
}

export function Badge({ text, fg, bg }: { text: string; fg: string; bg: string }) {
  return (
    <View style={[s.badge, { backgroundColor: bg }]}>
      <Text style={[s.badgeText, { color: fg }]}>{text}</Text>
    </View>
  );
}

const STATUS_COLORS: Record<CommonStatus, { fg: string; bg: string; icon: string }> = {
  ERROR: { fg: C.red, bg: C.redBg, icon: "✖" },
  OFFLINE: { fg: C.gray, bg: C.grayBg, icon: "⊘" },
  CLEANING: { fg: C.blue, bg: C.blueBg, icon: "▶" },
  PAUSED: { fg: C.amber, bg: C.amberBg, icon: "❚❚" },
  RETURNING: { fg: C.purple, bg: C.purpleBg, icon: "↩" },
  CHARGING: { fg: C.green, bg: C.greenBg, icon: "⚡" },
  IDLE: { fg: C.gray, bg: C.grayBg, icon: "■" },
  UNKNOWN: { fg: C.purple, bg: C.purpleBg, icon: "?" },
};
export function statusColor(st: CommonStatus) {
  return STATUS_COLORS[st] ?? STATUS_COLORS.UNKNOWN;
}
export function StatusBadge({ status }: { status: CommonStatus }) {
  const c = statusColor(status);
  return <Badge text={`${c.icon} ${STATUS_LABEL[status] ?? status}`} fg={c.fg} bg={c.bg} />;
}

const SEV_COLORS: Record<Severity, { fg: string; bg: string }> = { LOW: { fg: C.gray, bg: C.grayBg }, MEDIUM: { fg: C.amber, bg: C.amberBg }, HIGH: { fg: C.red, bg: C.redBg }, CRITICAL: { fg: C.white, bg: C.red } };
export function SeverityBadge({ severity }: { severity: Severity }) {
  const c = SEV_COLORS[severity] ?? SEV_COLORS.MEDIUM;
  return <Badge text={SEVERITY_LABEL[severity] ?? severity} fg={c.fg} bg={c.bg} />;
}
const INC_COLORS: Record<IncidentStatus, { fg: string; bg: string }> = { OPEN: { fg: C.red, bg: C.redBg }, ACKED: { fg: C.amber, bg: C.amberBg }, ASSIGNED: { fg: C.blue, bg: C.blueBg }, IN_PROGRESS: { fg: C.blue, bg: C.blueBg }, RESOLVED: { fg: C.green, bg: C.greenBg } };
export function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  const c = INC_COLORS[status] ?? INC_COLORS.OPEN;
  return <Badge text={INCIDENT_STATUS_LABEL[status] ?? status} fg={c.fg} bg={c.bg} />;
}
const CMD_COLORS: Record<CommandState, { fg: string; bg: string }> = { REQUESTED: { fg: C.gray, bg: C.grayBg }, ACCEPTED: { fg: C.blue, bg: C.blueBg }, EXECUTING: { fg: C.blue, bg: C.blueBg }, COMPLETED: { fg: C.green, bg: C.greenBg }, FAILED: { fg: C.red, bg: C.redBg }, UNKNOWN: { fg: C.amber, bg: C.amberBg } };
export function CommandStateBadge({ state }: { state: CommandState }) {
  const c = CMD_COLORS[state] ?? CMD_COLORS.UNKNOWN;
  return <Badge text={COMMAND_STATE_LABEL[state] ?? state} fg={c.fg} bg={c.bg} />;
}

export function Button({ title, onPress, variant = "primary", disabled, small }: { title: string; onPress: () => void; variant?: "primary" | "secondary" | "danger"; disabled?: boolean; small?: boolean }) {
  const bg = variant === "primary" ? C.navy : variant === "danger" ? C.red : C.white;
  const fg = variant === "secondary" ? C.navy : C.white;
  return (
    <Pressable onPress={onPress} disabled={disabled} style={({ pressed }) => [s.btn, small && s.btnSmall, { backgroundColor: bg, borderColor: variant === "secondary" ? C.navy : bg, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 }]}>
      <Text style={[s.btnText, small && s.btnTextSmall, { color: fg }]}>{title}</Text>
    </Pressable>
  );
}

export function Loading({ text = "불러오는 중…" }: { text?: string }) {
  return (
    <View style={s.center}>
      <ActivityIndicator color={C.navy} />
      <Text style={s.sub}>{text}</Text>
    </View>
  );
}

export function ErrorBox({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <View style={s.errorBox}>
      <Text style={{ color: C.red }}>{text}</Text>
      {onRetry && <Button title="다시 시도" onPress={onRetry} variant="secondary" small />}
    </View>
  );
}

export function Empty({ text }: { text: string }) {
  return <Text style={[s.sub, { padding: 12, textAlign: "center" }]}>{text}</Text>;
}

export function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <View style={s.kv}>
      <Text style={s.kvK}>{k}</Text>
      {typeof v === "string" || typeof v === "number" ? <Text style={s.kvV}>{v}</Text> : <View style={{ flex: 1, alignItems: "flex-end" }}>{v}</View>}
    </View>
  );
}

export function SampleBanner({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <View style={s.sample}>
      <Text style={{ color: C.amber, fontSize: 12 }}>샘플 데이터 · 시뮬레이션 모드 — 실제 로봇 명령은 전송되지 않습니다.</Text>
    </View>
  );
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  content: { padding: 12, gap: 10, paddingBottom: 40 },
  card: { backgroundColor: C.white, borderRadius: 12, borderWidth: 1, borderColor: C.border, padding: 12, gap: 8 },
  cardHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardTitle: { fontSize: 15, fontWeight: "700", color: C.text },
  badge: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, alignSelf: "flex-start" },
  badgeText: { fontSize: 12, fontWeight: "600" },
  btn: { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  btnSmall: { paddingHorizontal: 10, paddingVertical: 6 },
  btnText: { fontSize: 15, fontWeight: "600" },
  btnTextSmall: { fontSize: 13 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8, padding: 24 },
  sub: { color: C.sub, fontSize: 13 },
  title: { fontSize: 20, fontWeight: "700", color: C.text },
  h2: { fontSize: 16, fontWeight: "700", color: C.text },
  body: { fontSize: 14, color: C.text },
  errorBox: { backgroundColor: C.redBg, borderRadius: 8, padding: 12, gap: 8 },
  kv: { flexDirection: "row", justifyContent: "space-between", gap: 8, paddingVertical: 3, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  kvK: { color: C.sub, fontSize: 13 },
  kvV: { color: C.text, fontSize: 13, flex: 1, textAlign: "right" },
  row: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  input: { borderWidth: 1, borderColor: C.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, backgroundColor: C.white, color: C.text },
  sample: { backgroundColor: C.amberBg, paddingHorizontal: 12, paddingVertical: 6 },
  stat: { flex: 1, minWidth: 90, backgroundColor: C.white, borderRadius: 10, borderWidth: 1, borderColor: C.border, padding: 10 },
  statLabel: { color: C.sub, fontSize: 12 },
  statValue: { fontSize: 22, fontWeight: "700", color: C.text },
  listItem: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border, gap: 4 },
});
