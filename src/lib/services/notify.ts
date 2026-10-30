import { eq } from "drizzle-orm";
import type { User } from "@/lib/domain/types";
import { assertActive, assertAdmin } from "@/lib/auth/authz";
import { getDb, schema } from "@/lib/db/client";
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
