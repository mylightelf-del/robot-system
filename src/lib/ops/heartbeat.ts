import { eq, lt, isNotNull, and } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import { nowIso } from "@/lib/util/time";

/**
 * 워커 생존 신호. 워커가 주기적으로 vendor_sync_state 의 WORKER:heartbeat 행을 갱신하고, /api/health 가 그 나이를 본다.
 * 워커가 죽으면 폴링·콜백 처리·시뮬레이션이 모두 멈추므로 감시에서 가장 먼저 봐야 할 값이다.
 */
export const HEARTBEAT_ID = "WORKER:heartbeat";
export const HEARTBEAT_STALE_SECONDS = Number(process.env.WORKER_HEARTBEAT_STALE_SECONDS ?? 180);

export async function writeHeartbeat(stats: Record<string, unknown> = {}): Promise<void> {
  const now = nowIso();
  await getDb()
    .insert(schema.vendorSyncState)
    .values({ id: HEARTBEAT_ID, vendor: "PUDU", job: "heartbeat", lastRunAt: now, lastOkAt: now, lastError: null, stats })
    .onConflictDoUpdate({ target: schema.vendorSyncState.id, set: { lastRunAt: now, lastOkAt: now, lastError: null, stats } });
}

export async function workerStatus(now = Date.now()): Promise<{ state: "up" | "stale" | "unknown"; lastSeenAt: string | null; ageSeconds: number | null }> {
  const row = await getDb().query.vendorSyncState.findFirst({ where: eq(schema.vendorSyncState.id, HEARTBEAT_ID) });
  if (!row?.lastRunAt) return { state: "unknown", lastSeenAt: null, ageSeconds: null };
  const age = Math.round((now - new Date(row.lastRunAt).getTime()) / 1000);
  return { state: age > HEARTBEAT_STALE_SECONDS ? "stale" : "up", lastSeenAt: row.lastRunAt, ageSeconds: age };
}

/** 보관 정책: 처리 끝난 콜백 원문은 N일(기본 30) 뒤 지운다. 감사 기록·실적·장애는 지우지 않는다. */
export const RETENTION_VENDOR_EVENTS_DAYS = Number(process.env.RETENTION_VENDOR_EVENTS_DAYS ?? 30);

export async function purgeOldVendorEvents(days = RETENTION_VENDOR_EVENTS_DAYS, now = new Date()): Promise<number> {
  if (!(days > 0)) return 0;
  const cutoff = new Date(now.getTime() - days * 86400_000).toISOString();
  const deleted = await getDb()
    .delete(schema.vendorEvents)
    .where(and(isNotNull(schema.vendorEvents.processedAt), lt(schema.vendorEvents.receivedAt, cutoff)))
    .returning({ id: schema.vendorEvents.id });

  return deleted.length;
}
