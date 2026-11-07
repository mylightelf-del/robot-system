import { and, eq, inArray, or } from "drizzle-orm";
import { NOTIFY_KINDS, type NotificationRecipient, type NotifyKind, type User } from "@/lib/domain/types";
import { accessibleSiteIds, assertActive, assertAdmin, assertSiteAccess } from "@/lib/auth/authz";
import { getDb, schema } from "@/lib/db/client";
import { listSitesByIds } from "@/lib/db/repo";
import { channelModes, KAKAO_USER_PREFIX, sendTestMessage } from "@/lib/notify/notifier";
import { kakaoConfig, kakaoLinkStatus, unlinkKakao } from "@/lib/notify/kakao";
import { emailConfig } from "@/lib/notify/email";
import { NotFoundError, ValidationError } from "@/lib/util/errors";
import { audit } from "./audit";

/** 알림 채널 상태(화면 표시용, 비밀값 없음). */
export function notifyStatus() {
  const e = emailConfig();
  return { modes: channelModes(), emailFrom: e?.from ?? null, kakaoConfigured: !!kakaoConfig() };
}

/** 내 이메일·내 카카오톡으로 시험 발송(누구나 자기 자신에게만). */
export async function testSelf(user: User, channel: "EMAIL" | "KAKAO") {
  assertActive(user);
  const r = channel === "EMAIL" ? { channel, address: user.email } : { channel, address: `${KAKAO_USER_PREFIX}${user.id}` };
  const res = await sendTestMessage(r, user.name);
  await audit(user, { siteId: null, robotId: null, action: "NOTIFY:TEST", params: { channel, self: true, status: res.status }, result: res.status === "FAILED" ? "ERROR" : "OK", detail: res.reason.slice(0, 200), vendorTraceId: null });
  return res;
}

/** 사업장 수신자에게 시험 발송(본사 관리자). */
export async function testRecipient(user: User, siteId: string, recipientId: string) {
  assertActive(user);
  assertAdmin(user);
  const r = await getDb().query.notificationRecipients.findFirst({ where: eq(schema.notificationRecipients.id, recipientId) });
  if (!r || r.siteId !== siteId) throw new NotFoundError("수신자를 찾을 수 없습니다.");
  const res = await sendTestMessage(r, user.name);
  await audit(user, { siteId, robotId: null, action: "NOTIFY:TEST", params: { channel: r.channel, recipientId, status: res.status }, result: res.status === "FAILED" ? "ERROR" : "OK", detail: res.reason.slice(0, 200), vendorTraceId: null });
  return res;
}

export async function myKakaoStatus(user: User) {
  return { configured: !!kakaoConfig(), ...(await kakaoLinkStatus(user.id)) };
}

export async function unlinkMyKakao(user: User) {
  assertActive(user);
  await unlinkKakao(user.id);
  await audit(user, { siteId: null, robotId: null, action: "NOTIFY:KAKAO_UNLINK", params: {}, result: "OK", detail: null, vendorTraceId: null });
}

/** 카카오톡 수신자로 고를 수 있는 사용자(활성) + 연결 여부. */
export async function kakaoCandidates(): Promise<{ id: string; name: string; linked: boolean }[]> {
  const db = getDb();
  const users = await db.select({ id: schema.users.id, name: schema.users.name, active: schema.users.active }).from(schema.users);
  const links = new Set((await db.select({ id: schema.kakaoLinks.userId }).from(schema.kakaoLinks)).map((l) => l.id));
  return users.filter((u) => u.active).map((u) => ({ id: u.id, name: u.name, linked: links.has(u.id) }));
}

/** 카카오톡 수신 주소 검증: "user:<활성 사용자 ID>". */
export async function assertKakaoAddress(address: string) {
  if (!address.startsWith(KAKAO_USER_PREFIX)) return; // 전화번호(알림톡)는 모의
  const id = address.slice(KAKAO_USER_PREFIX.length);
  const u = await getDb().query.users.findFirst({ where: eq(schema.users.id, id) });
  if (!u || !u.active) throw new ValidationError("카카오톡 수신자는 활성 사용자여야 합니다.");
}

/** 내 구독: 내 이메일 또는 내 카카오톡(user:나)이 수신자로 등록된 사업장(접근 가능한 사업장만). */
export async function mySubscriptions(user: User): Promise<(NotificationRecipient & { siteId: string; siteName: string })[]> {
  assertActive(user);
  const db = getDb();
  const siteIds = await accessibleSiteIds(user, db);
  if (siteIds.length === 0) return [];
  const rows = await db
    .select()
    .from(schema.notificationRecipients)
    .where(and(inArray(schema.notificationRecipients.siteId, siteIds), or(and(eq(schema.notificationRecipients.channel, "EMAIL"), eq(schema.notificationRecipients.address, user.email)), and(eq(schema.notificationRecipients.channel, "KAKAO"), eq(schema.notificationRecipients.address, `${KAKAO_USER_PREFIX}${user.id}`)))))
    .orderBy(schema.notificationRecipients.siteId, schema.notificationRecipients.channel);
  const names = new Map((await listSitesByIds(siteIds, db)).map((s) => [s.id, s.name]));
  return rows.map((r) => ({ ...r, siteName: names.get(r.siteId) ?? r.siteId }));
}

function normalizeKinds(kinds: NotifyKind[] | undefined): NotifyKind[] {
  const set = new Set((kinds ?? NOTIFY_KINDS).filter((k) => NOTIFY_KINDS.includes(k)));
  if (set.size === 0) throw new ValidationError("받을 통보 종류를 하나 이상 고르세요.");
  return NOTIFY_KINDS.filter((k) => set.has(k));
}

/** 내가 접근할 수 있는 사업장의 알림을 내 이메일/카카오톡으로 받기(스스로 등록). 사업장당 채널별 한 번. */
export async function subscribeMe(user: User, siteId: string, channel: "EMAIL" | "KAKAO", kinds?: NotifyKind[]): Promise<void> {
  assertActive(user);
  const db = getDb();
  await assertSiteAccess(user, siteId, db);
  const address = channel === "EMAIL" ? user.email : `${KAKAO_USER_PREFIX}${user.id}`;
  const exists = await db.query.notificationRecipients.findFirst({ where: and(eq(schema.notificationRecipients.siteId, siteId), eq(schema.notificationRecipients.channel, channel), eq(schema.notificationRecipients.address, address)) });
  if (exists) throw new ValidationError("이미 이 사업장의 수신자로 등록되어 있습니다.");
  if (channel === "KAKAO" && !(await kakaoLinkStatus(user.id)).linked) throw new ValidationError("먼저 카카오톡을 연결하세요.");
  const k = normalizeKinds(kinds);
  await db.insert(schema.notificationRecipients).values({ id: `rcp-${Math.random().toString(36).slice(2, 10)}`, siteId, channel, address, minSeverity: "MEDIUM", hoursFrom: "00:00", hoursTo: "23:59", kinds: k });
  await audit(user, { siteId, robotId: null, action: "NOTIFY:SUBSCRIBE_SELF", params: { channel, kinds: k }, result: "OK", detail: null, vendorTraceId: null }, db);
}

/** 내 구독의 종류·시간대 변경. 남의 수신자 행은 바꿀 수 없다. */
export async function updateMySubscription(user: User, recipientId: string, patch: { kinds?: NotifyKind[]; hoursFrom?: string; hoursTo?: string }): Promise<void> {
  const mine = (await mySubscriptions(user)).find((r) => r.id === recipientId);
  if (!mine) throw new NotFoundError("내 구독이 아닙니다.");
  const set = { ...(patch.kinds ? { kinds: normalizeKinds(patch.kinds) } : {}), ...(patch.hoursFrom ? { hoursFrom: patch.hoursFrom } : {}), ...(patch.hoursTo ? { hoursTo: patch.hoursTo } : {}) };
  await getDb().update(schema.notificationRecipients).set(set).where(eq(schema.notificationRecipients.id, recipientId));
  await audit(user, { siteId: mine.siteId, robotId: null, action: "NOTIFY:UPDATE_SELF", params: { recipientId, ...set }, result: "OK", detail: null, vendorTraceId: null });
}

export async function unsubscribeMe(user: User, recipientId: string): Promise<void> {
  const mine = (await mySubscriptions(user)).find((r) => r.id === recipientId);
  if (!mine) throw new NotFoundError("내 구독이 아닙니다.");
  await getDb().delete(schema.notificationRecipients).where(eq(schema.notificationRecipients.id, recipientId));
  await audit(user, { siteId: mine.siteId, robotId: null, action: "NOTIFY:UNSUBSCRIBE_SELF", params: { recipientId, channel: mine.channel }, result: "OK", detail: null, vendorTraceId: null });
}
