import React from "react";
import { Pressable, Text } from "react-native";
import { C } from "./ui";

export function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: active ? C.navy : C.white, borderWidth: 1, borderColor: active ? C.navy : C.border }}>
      <Text style={{ color: active ? C.white : C.text, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}
