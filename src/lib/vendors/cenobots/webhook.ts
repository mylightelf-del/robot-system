import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import { newId } from "@/lib/util/random";
import { nowIso } from "@/lib/util/time";

/**
 * CZ Robots 웹훅(문서 「CZ Robots Webhook Integration Guide」).
 * - 본문 { iv, encrypt } — AES-256-GCM, key = SHA-256(시크릿 UTF-8), iv 12바이트, 태그 16바이트가 encrypt 끝. 모두 패딩 없는 base64url.
 * - 복호화 실패는 거부(fail closed). X-Webhook-Timestamp(초)가 5분 넘게 어긋나면 거부.
 * - challenge 메시지는 같은 값을 그대로 돌려준다(구독 검증).
 * - 업무 이벤트는 data.id 로 중복 제거해 원문을 저장하고 바로 2xx. 처리는 워커가 비동기로(occurredAt 으로 역순 방지).
 */
export interface CzWebhookMessage {
  messageType: "challenge" | "event" | string;
  data: Record<string, unknown>;
}

export interface CzEvent {
  id: string;
  type: string;
  apiVersion?: string;
  occurredAt?: number;
  device?: { openId?: string; licensePlate?: string };
  data?: Record<string, unknown>;
}

export class WebhookDecryptError extends Error {}

export function decryptCzWebhook(secret: string, envelope: unknown): CzWebhookMessage {
  try {
    const env = envelope as { iv?: unknown; encrypt?: unknown };
    if (typeof env?.iv !== "string" || typeof env?.encrypt !== "string") throw new Error("envelope");
    const key = createHash("sha256").update(secret, "utf8").digest();
    const iv = Buffer.from(env.iv, "base64url");
    const enc = Buffer.from(env.encrypt, "base64url");
    if (iv.length !== 12 || enc.length < 17) throw new Error("length");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(enc.subarray(enc.length - 16));
    const plain = Buffer.concat([decipher.update(enc.subarray(0, enc.length - 16)), decipher.final()]).toString("utf8");
    const msg = JSON.parse(plain) as CzWebhookMessage;
    if (!msg || typeof msg !== "object" || typeof msg.messageType !== "string") throw new Error("shape");
    return msg;
  } catch {
    throw new WebhookDecryptError("unable to decrypt webhook message");
  }
}

/** 시험·자가 점검용 암호화(업체와 같은 방식). */
export function encryptCzWebhook(secret: string, message: unknown): { iv: string; encrypt: string } {
  const key = createHash("sha256").update(secret, "utf8").digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(message), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { iv: iv.toString("base64url"), encrypt: ct.toString("base64url") };
}

export function timestampFresh(header: string | null, nowMs = Date.now()): boolean {
  const t = Number(header);
  return Number.isFinite(t) && t > 0 && Math.abs(nowMs / 1000 - t) <= 300;
}

/** 위치 이벤트는 빈도가 높아 저장하지 않는다(상태 폴링이 위치를 갱신). */
export const IGNORED_EVENT_TYPES = new Set(["robot.pose.changed"]);

export async function ingestCzEvent(ev: CzEvent, traceId: string | null): Promise<{ stored: boolean; duplicate: boolean; ignored: boolean }> {
  if (!ev?.id || !ev?.type) return { stored: false, duplicate: false, ignored: true };
  if (IGNORED_EVENT_TYPES.has(ev.type)) return { stored: false, duplicate: false, ignored: true };
  const inserted = await getDb()
    .insert(schema.vendorEvents)
    .values({
      id: newId("evt"),
      vendor: "CENOBOTS",
      eventType: ev.type,
      vendorRobotId: ev.device?.openId ?? null,
      eventKey: ev.id,
      receivedAt: nowIso(),
      occurredAt: typeof ev.occurredAt === "number" ? new Date(ev.occurredAt).toISOString() : null,
      traceId,
      payload: ev,
    })
    .onConflictDoNothing({ target: [schema.vendorEvents.vendor, schema.vendorEvents.eventKey] })
    .returning({ id: schema.vendorEvents.id });
  return inserted.length ? { stored: true, duplicate: false, ignored: false } : { stored: false, duplicate: true, ignored: false };
}

export async function pendingCzEvents(limit = 100) {
  return getDb()
    .select()
    .from(schema.vendorEvents)
    .where(and(eq(schema.vendorEvents.vendor, "CENOBOTS"), isNull(schema.vendorEvents.processedAt)))
    .orderBy(schema.vendorEvents.receivedAt)
    .limit(limit);
}
