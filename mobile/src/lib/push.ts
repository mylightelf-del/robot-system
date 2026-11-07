import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import { api, getAuthToken } from "./api";
import { APP_VERSION } from "./config";

/**
 * 푸시(FCM) 기기 등록.
 * - 안드로이드 13+ 는 알림 채널을 먼저 만들어야 권한 창이 뜬다 → 채널 'alerts' 생성 → 권한 요청 → FCM 등록 토큰 → 서버 /devices 등록.
 * - 토큰은 현재 앱 세션에 묶이므로 로그아웃·기기 끊기 때 서버가 함께 지운다. 알림 끄기는 unregisterPushDevice.
 * - 서버는 알림창에 제목·요약만 보내고 data 에 kind·refId·siteId·url 을 싣는다(딥링크는 _layout 에서 처리).
 */
export const CHANNEL_ID = "alerts";

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

let lastToken: string | null = null;

export async function ensureChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, { name: "관제 알림(장애·미실행·보고서)", importance: Notifications.AndroidImportance.HIGH, vibrationPattern: [0, 250, 250, 250], lightColor: "#1e3a8a" });
}

export type PushStatus = { granted: boolean; token: string | null; reason: string };

/** 권한을 묻고 FCM 토큰을 받아 서버에 등록한다. 에뮬레이터·권한 거부·FCM 미구성이면 reason 에 이유를 남기고 실패로 돌려준다. */
export async function registerPushDevice(): Promise<PushStatus> {
  if (!getAuthToken()) return { granted: false, token: null, reason: "로그인 전" };
  if (!Device.isDevice) return { granted: false, token: null, reason: "실제 기기에서만 푸시를 받을 수 있습니다." };
  await ensureChannel();
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== "granted") return { granted: false, token: null, reason: "알림 권한이 꺼져 있습니다(설정 → 앱 → 알림에서 허용)." };
  let token: string;
  try {
    token = (await Notifications.getDevicePushTokenAsync()).data as string;
  } catch (e) {
    return { granted: true, token: null, reason: `푸시 토큰을 받지 못했습니다: ${(e as Error).message}` };
  }
  await api("POST", "/devices", { token, platform: Platform.OS === "ios" ? "ios" : "android", appVersion: APP_VERSION, deviceName: [Device.manufacturer, Device.modelName].filter(Boolean).join(" ") });
  lastToken = token;
  return { granted: true, token, reason: "등록됨" };
}

/** 서버에서 이 기기의 푸시 토큰을 지운다(알림 끄기·로그아웃 전). */
export async function unregisterPushDevice(): Promise<void> {
  let token = lastToken;
  if (!token) {
    try {
      token = (await Notifications.getDevicePushTokenAsync()).data as string;
    } catch {
      return;
    }
  }
  await api("DELETE", "/devices", { token });
  lastToken = null;
}

/** 알림 data → 앱 안의 경로. */
export function routeForNotification(data: Record<string, unknown> | undefined): string {
  const kind = String(data?.kind ?? "");
  const refId = String(data?.refId ?? "");
  if ((kind === "INCIDENT" || kind === "ESCALATION") && refId) return `/incidents/${encodeURIComponent(refId)}`;
  if (kind === "REPORT" && refId) return `/reports/${encodeURIComponent(refId)}`;
  if (kind === "NO_ACTIVITY" && refId) return `/robots/${encodeURIComponent(refId)}`;
  return "/notifications";
}
