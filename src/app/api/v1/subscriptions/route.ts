import { withAuth, readJson, str, json } from "@/lib/api/http";
import type { NotifyChannel, NotifyKind } from "@/lib/domain/types";
import { mySubscriptions, subscribeMe } from "@/lib/services/notify";
import { HttpError } from "@/lib/api/http";

/** 내 알림 구독(웹의 '내 알림 구독' 과 같은 데이터). */
export const GET = withAuth(async ({ user }) => ({ subscriptions: await mySubscriptions(user) }));

/** 구독 추가. 본문 { siteId, channel: "EMAIL"|"KAKAO"|"PUSH", kinds? }. PUSH 는 등록된 앱 기기가 있어야 한다. */
export const POST = withAuth(async ({ req, user }) => {
  const b = await readJson(req);
  const channel = str(b.channel, "channel", { required: true, max: 10 }) as NotifyChannel;
  if (!["EMAIL", "KAKAO", "PUSH"].includes(channel)) throw new HttpError(400, "channel 은 EMAIL·KAKAO·PUSH 중 하나여야 합니다.", "VALIDATION");
  const kinds = Array.isArray(b.kinds) ? (b.kinds.filter((k) => typeof k === "string") as NotifyKind[]) : undefined;
  await subscribeMe(user, str(b.siteId, "siteId", { required: true, max: 100 }), channel, kinds);
  return json({ subscriptions: await mySubscriptions(user) }, 201);
});
