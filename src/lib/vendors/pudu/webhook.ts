import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import { newId } from "@/lib/util/random";
import { nowIso } from "@/lib/util/time";

/**
 * PUDU 콜백 적재(동기, 빠르게) 와 이벤트 키 규칙.
 * 이벤트 키: callback_type + sn + (notify_timestamp | task_time | timestamp). 재시도로 같은 본문이 다시 오면 중복으로 버린다.
 */
export interface PuduCallback {
  callback_type: string;
  data: Record<string, unknown>;
}

export function isPuduCallback(x: unknown): x is PuduCallback {
  return !!x && typeof x === "object" && typeof (x as PuduCallback).callback_type === "string" && typeof (x as PuduCallback).data === "object" && (x as PuduCallback).data !== null;
}

export function eventKeyOf(cb: PuduCallback): string {
  const d = cb.data;
  const sn = String(d.sn ?? d.mac ?? "");
  const stamp = d.notify_timestamp ?? d.task_time ?? d.timestamp ?? "";
  const extra = d.error_id ?? d.task_id ?? d.status ?? d.run_status ?? "";
  return `${cb.callback_type}:${sn}:${stamp}:${extra}`;
}

export function occurredAtOf(cb: PuduCallback): string | null {
  const d = cb.data;
  if (typeof d.notify_timestamp === "number") return new Date(d.notify_timestamp).toISOString(); // ms
  if (typeof d.task_time === "number") return new Date(d.task_time * 1000).toISOString();
  if (typeof d.timestamp === "number") return new Date(d.timestamp * 1000).toISOString();
  return null;
}

export async function ingestPuduCallback(body: unknown, traceId: string | null): Promise<{ stored: boolean; duplicate: boolean; id: string | null }> {
  if (!isPuduCallback(body)) return { stored: false, duplicate: false, id: null };
  const db = getDb();
  const id = newId("evt");
  const inserted = await db
    .insert(schema.vendorEvents)
    .values({
      id,
      vendor: "PUDU",
      eventType: body.callback_type,
      vendorRobotId: typeof body.data.sn === "string" ? body.data.sn : null,
      eventKey: eventKeyOf(body),
      receivedAt: nowIso(),
      occurredAt: occurredAtOf(body),
      traceId,
      payload: body,
    })
    .onConflictDoNothing({ target: [schema.vendorEvents.vendor, schema.vendorEvents.eventKey] })
    .returning({ id: schema.vendorEvents.id });
  return inserted.length ? { stored: true, duplicate: false, id } : { stored: false, duplicate: true, id: null };
}

export async function pendingPuduEvents(limit = 100) {
  return getDb()
    .select()
    .from(schema.vendorEvents)
    .where(and(eq(schema.vendorEvents.vendor, "PUDU"), isNull(schema.vendorEvents.processedAt)))
    .orderBy(schema.vendorEvents.receivedAt)
    .limit(limit);
}
