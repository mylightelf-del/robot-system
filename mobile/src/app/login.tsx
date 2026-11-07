import React, { useState } from "react";
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../lib/auth";
import { errorText } from "../lib/api";
import { APP_VERSION, DEFAULT_API_BASE } from "../lib/config";
import { Button, C, s } from "../components/ui";

/** 로그인. 웹과 같은 계정(이메일·비밀번호). 실패 사유는 서버가 구분하지 않는다. */
export default function LoginScreen() {
  const { login, apiBaseUrl, changeApiBase } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showServer, setShowServer] = useState(false);
  const [server, setServer] = useState(apiBaseUrl);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={[s.screen, { backgroundColor: C.navy }]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 20 }} keyboardShouldPersistTaps="handled">
          <View style={{ marginBottom: 24 }}>
            <Text style={{ color: C.white, fontSize: 26, fontWeight: "800" }}>와이드봇 관제</Text>
            <Text style={{ color: "#c7d2fe", marginTop: 4 }}>청소로봇 통합관제 · 현장용 앱</Text>
          </View>
          <View style={[s.card, { gap: 10 }]}>
            <Text style={s.sub}>이메일</Text>
            <TextInput style={s.input} autoCapitalize="none" autoComplete="email" keyboardType="email-address" value={email} onChangeText={setEmail} placeholder="name@example.com" placeholderTextColor={C.sub} />
            <Text style={s.sub}>비밀번호</Text>
            <TextInput style={s.input} secureTextEntry autoComplete="password" value={password} onChangeText={setPassword} placeholder="비밀번호" placeholderTextColor={C.sub} onSubmitEditing={submit} />
            {error && <Text style={{ color: C.red }}>{error}</Text>}
            <Button title={busy ? "로그인 중…" : "로그인"} onPress={submit} disabled={busy || !email || !password} />
            <Text style={[s.sub, { fontSize: 12 }]}>계정은 본사 관리자가 초대 링크로 만들어 줍니다. 비밀번호 설정·변경은 웹에서 합니다.</Text>
          </View>
          <Pressable onPress={() => Linking.openURL(`${apiBaseUrl}/privacy`)} style={{ marginTop: 16, alignSelf: "center" }}>
            <Text style={{ color: "#c7d2fe", fontSize: 12, textDecorationLine: "underline" }}>개인정보처리방침</Text>
          </Pressable>
          <Pressable onPress={() => setShowServer((v) => !v)} style={{ marginTop: 8, alignSelf: "center" }}>
            <Text style={{ color: "#c7d2fe", fontSize: 12 }}>
              서버: {apiBaseUrl.replace(/^https?:\/\//, "")} · 앱 {APP_VERSION} {showServer ? "▲" : "▼"}
            </Text>
          </Pressable>
          {showServer && (
            <View style={[s.card, { marginTop: 8, gap: 8 }]}>
              <Text style={s.sub}>서버 주소(시험 서버로 바꿀 때만. 바꾸면 로그아웃됩니다)</Text>
              <TextInput style={s.input} autoCapitalize="none" value={server} onChangeText={setServer} placeholder={DEFAULT_API_BASE} placeholderTextColor={C.sub} />
              <View style={s.row}>
                <Button
                  title="적용"
                  small
                  onPress={async () => {
                    try {
                      await changeApiBase(server);
                      setError(null);
                      setShowServer(false);
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                />
                <Button title="기본값" small variant="secondary" onPress={() => setServer(DEFAULT_API_BASE)} />
              </View>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
