import { withAuth, readJson, str, json } from "@/lib/api/http";
import { listMyDevices, registerDevice, unregisterDevice } from "@/lib/notify/push";
import { audit } from "@/lib/services/audit";

/** 내 푸시 기기 목록(토큰 제외). */
export const GET = withAuth(async ({ user }) => ({ devices: await listMyDevices(user) }));

/**
 * 푸시 기기 등록. 본문 { token, platform: "android"|"ios", appVersion?, deviceName? }.
 * 앱이 로그인 직후와 FCM 토큰이 바뀔 때 호출한다. 현재 세션에 묶이므로 로그아웃·기기 끊기 때 함께 지워진다.
 */
export const POST = withAuth(async ({ req, user, session }) => {
  const b = await readJson(req);
  const d = await registerDevice(user, session.id, { token: str(b.token, "token", { required: true, max: 4096 }), platform: str(b.platform, "platform", { required: true, max: 10 }) as "android" | "ios", appVersion: str(b.appVersion, "appVersion", { max: 40 }), deviceName: str(b.deviceName, "deviceName", { max: 80 }) || session.deviceName });
  await audit(user, { siteId: null, robotId: null, action: "NOTIFY:REGISTER_DEVICE", params: { platform: d.platform, device: d.deviceName, sessionId: session.id }, result: "OK", detail: null, vendorTraceId: null });
  return json({ device: { id: d.id, platform: d.platform, deviceName: d.deviceName, appVersion: d.appVersion } }, 201);
});

/** 푸시 기기 해제(앱에서 알림 끄기). 본문 { token }. */
export const DELETE = withAuth(async ({ req, user }) => {
  const b = await readJson(req);
  const removed = await unregisterDevice(user, str(b.token, "token", { required: true, max: 4096 }));
  return { ok: true, removed };
});
