import { withAuth, readJson, str } from "@/lib/api/http";
import type { NotifyKind } from "@/lib/domain/types";
import { mySubscriptions, unsubscribeMe, updateMySubscription } from "@/lib/services/notify";

/** 내 구독의 종류·시간대 변경. 본문 { kinds?, hoursFrom?, hoursTo? }. */
export const PATCH = withAuth<{ recipientId: string }>(async ({ req, user, params }) => {
  const b = await readJson(req);
  const kinds = Array.isArray(b.kinds) ? (b.kinds.filter((k) => typeof k === "string") as NotifyKind[]) : undefined;
  await updateMySubscription(user, decodeURIComponent(params.recipientId), { kinds, hoursFrom: str(b.hoursFrom, "hoursFrom", { max: 5 }) || undefined, hoursTo: str(b.hoursTo, "hoursTo", { max: 5 }) || undefined });
  return { subscriptions: await mySubscriptions(user) };
});

/** 구독 해제. */
export const DELETE = withAuth<{ recipientId: string }>(async ({ user, params }) => {
  await unsubscribeMe(user, decodeURIComponent(params.recipientId));
  return { ok: true };
});
