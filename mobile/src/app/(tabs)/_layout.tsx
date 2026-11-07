import React from "react";
import { Tabs, router } from "expo-router";
import { Pressable, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { C } from "../../components/ui";

/** 하단 탭 5개: 홈 · 사업장 · 장애 · 보고서 · 내 계정. 알림함은 머리말 종 아이콘. */
export default function TabsLayout() {
  const bell = () => (
    <Pressable onPress={() => router.push("/notifications")} hitSlop={10} style={{ paddingHorizontal: 14 }} accessibilityLabel="알림함">
      <Ionicons name="notifications-outline" size={22} color={C.white} />
    </Pressable>
  );
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: C.navy },
        headerTintColor: C.white,
        headerTitleStyle: { fontWeight: "700" },
        headerRight: bell,
        tabBarActiveTintColor: C.navy,
        tabBarInactiveTintColor: C.sub,
        tabBarLabel: ({ color, children }) => <Text style={{ color, fontSize: 11, fontWeight: "600" }}>{children}</Text>,
        sceneStyle: { backgroundColor: C.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "홈", tabBarIcon: ({ color, size }) => <Ionicons name="home-outline" size={size} color={String(color)} /> }} />
      <Tabs.Screen name="sites" options={{ title: "사업장", tabBarIcon: ({ color, size }) => <Ionicons name="business-outline" size={size} color={String(color)} /> }} />
      <Tabs.Screen name="incidents" options={{ title: "장애", tabBarIcon: ({ color, size }) => <Ionicons name="warning-outline" size={size} color={String(color)} /> }} />
      <Tabs.Screen name="reports" options={{ title: "보고서", tabBarIcon: ({ color, size }) => <Ionicons name="document-text-outline" size={size} color={String(color)} /> }} />
      <Tabs.Screen name="account" options={{ title: "내 계정", tabBarIcon: ({ color, size }) => <Ionicons name="person-circle-outline" size={size} color={String(color)} /> }} />
    </Tabs>
  );
}
