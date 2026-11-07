import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import type { DbLike } from "@/lib/db/repo";
import { localDateKey, nowIso } from "@/lib/util/time";

/**
 * 소모품·정비 예측: 워커가 소모품을 동기화할 때 잔여 수명을 하루 한 번 이력으로 남기고,
 * 최근 FORECAST_WINDOW_DAYS 동안의 감소 속도로 교체 예상일을 계산한다(직선 가정, 참고값).
 */
export const FORECAST_WINDOW_DAYS = 30;
export const LOW_CONSUMABLE_PCT = 20;

export interface ConsumableForecast {
  name: string;
  remainingPct: number | null;
  /** 하루 감소율(%p/일). 이력이 2일 미만이거나 감소가 없으면 null. */
  ratePctPerDay: number | null;
  daysLeft: number | null;
  /** 잔여 0% 도달 예상일(YYYY-MM-DD, 사업장 시간대). */
  expectedDate: string | null;
}

/** 오늘(사업장 시간대) 스냅샷을 남긴다(로봇·항목·날짜당 1행). 워커 소모품 동기화 뒤에 부른다. */
export async function snapshotMaintenance(robotId: string, items: { key: string; name: string; remainingPct: number | null }[], tz: string, db: DbLike = getDb()): Promise<number> {
  const now = nowIso();
  const day = localDateKey(now, tz);
  let n = 0;
  for (const it of items) {
    if (it.remainingPct === null) continue;
    const res = await db
      .insert(schema.maintenanceHistory)
      .values({ id: `mh-${robotId}-${it.key}-${day}`, robotId, name: it.name, remainingPct: it.remainingPct, at: now })
      .onConflictDoNothing()
      .returning({ id: schema.maintenanceHistory.id });
    n += res.length;
  }
  return n;
}

/** 로봇의 소모품 예측(잔여 수명이 있는 항목). */
export async function consumableForecast(robotId: string, tz: string, db: DbLike = getDb()): Promise<ConsumableForecast[]> {
  const items = await db.select().from(schema.maintenanceItems).where(eq(schema.maintenanceItems.robotId, robotId)).orderBy(schema.maintenanceItems.id);
  const since = new Date(Date.now() - FORECAST_WINDOW_DAYS * 86400_000).toISOString();
  const hist = await db.select().from(schema.maintenanceHistory).where(and(eq(schema.maintenanceHistory.robotId, robotId), gte(schema.maintenanceHistory.at, since))).orderBy(asc(schema.maintenanceHistory.at));
  return items.map((it) => {
    const h = hist.filter((x) => x.name === it.name);
    if (it.remainingPct === null || h.length < 2) return { name: it.name, remainingPct: it.remainingPct, ratePctPerDay: null, daysLeft: null, expectedDate: null };
    const first = h[0];
    const last = h[h.length - 1];
    const days = (new Date(last.at).getTime() - new Date(first.at).getTime()) / 86400_000;
    const drop = first.remainingPct - last.remainingPct;
    if (days < 1 || drop <= 0) return { name: it.name, remainingPct: it.remainingPct, ratePctPerDay: null, daysLeft: null, expectedDate: null };
    const rate = Math.round((drop / days) * 100) / 100;
    const daysLeft = Math.max(0, Math.round(it.remainingPct / rate));
    const expectedDate = localDateKey(new Date(Date.now() + daysLeft * 86400_000).toISOString(), tz);
    return { name: it.name, remainingPct: it.remainingPct, ratePctPerDay: rate, daysLeft, expectedDate };
  });
}

/** 여러 로봇의 예측을 한 번에(대시보드·API 용). */
export async function forecastsFor(robotIds: string[], tz: string, db: DbLike = getDb()): Promise<Map<string, ConsumableForecast[]>> {
  const out = new Map<string, ConsumableForecast[]>();
  if (robotIds.length === 0) return out;
  const rows = await db.select({ robotId: schema.maintenanceItems.robotId }).from(schema.maintenanceItems).where(inArray(schema.maintenanceItems.robotId, robotIds));
  for (const id of new Set(rows.map((r) => r.robotId))) out.set(id, await consumableForecast(id, tz, db));
  return out;
}
