import React, { useEffect } from "react";
import { Redirect, Stack, router, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Notifications from "expo-notifications";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider, useAuth } from "../lib/auth";
import { routeForNotification } from "../lib/push";
import { C, Loading } from "../components/ui";

/**
 * 루트: 로그인 상태에 따라 로그인 화면/탭으로 보낸다. 푸시 알림을 누르면 data(kind·refId)로 해당 화면을 연다.
 * 화면 안 코드는 src/app/*, 그 밖의 코드는 src/lib·src/components.
 */
function Gate() {
  const { loading, user } = useAuth();
  const segments = useSegments();
  const onLogin = segments[0] === "login";

  // 알림 탭 → 딥링크(앱이 떠 있을 때와 꺼져 있다가 열릴 때 모두)
  const last = Notifications.useLastNotificationResponse();
  useEffect(() => {
    if (!user || !last) return;
    router.push(routeForNotification(last.notification.request.content.data as Record<string, unknown>) as never);
  }, [last, user]);

  if (loading) return <Loading text="로그인 확인 중…" />;
  if (!user && !onLogin) return <Redirect href="/login" />;
  if (user && onLogin) return <Redirect href="/" />;
  return (
    <Stack screenOptions={{ headerStyle: { backgroundColor: C.navy }, headerTintColor: C.white, headerTitleStyle: { fontWeight: "700" }, contentStyle: { backgroundColor: C.bg } }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="sites/[siteId]" options={{ title: "사업장 관제" }} />
      <Stack.Screen name="robots/[robotId]" options={{ title: "로봇 상세" }} />
      <Stack.Screen name="incidents/[incidentId]" options={{ title: "장애 상세" }} />
      <Stack.Screen name="reports/[reportId]" options={{ title: "보고서" }} />
      <Stack.Screen name="notifications" options={{ title: "알림함" }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="light" />
        <Gate />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
