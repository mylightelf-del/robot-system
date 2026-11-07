import { withAuth, publicUser } from "@/lib/api/http";
import { channelModes } from "@/lib/notify/notifier";
import { listSites } from "@/lib/services/robots";

/** 현재 사용자·세션·접근 가능한 사업장·알림 채널 상태(비밀값 없음). 앱이 시작할 때 한 번 부른다. */
export const GET = withAuth(async ({ user, session }) => ({
  user: publicUser(user),
  session: { id: session.id, kind: session.kind, deviceName: session.deviceName, createdAt: session.createdAt, expiresAt: session.expiresAt },
  sites: (await listSites(user)).map((s) => ({ id: s.id, name: s.name, timezone: s.timezone, remoteControlEnabled: s.remoteControlEnabled, isSample: s.isSample })),
  notify: { modes: channelModes() },
}));
