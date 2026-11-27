import { inArray } from "drizzle-orm";
import type { User } from "@/lib/domain/types";
import { getDb, schema } from "@/lib/db/client";
import { ForbiddenError, ValidationError } from "@/lib/util/errors";
import { nowIso } from "@/lib/util/time";
import { audit } from "./audit";

/**
 * 로봇 현황·일정 지금 업데이트(사용자 요청 2026-11-25).
 * 워커가 주기적으로 하는 일(상태 60초, 작업·예약 1시간, 예정 회차 10분)을 관리자가 즉시 한 번 돌린다.
 * 켜져 있는 연동만: PUDU(live) · CENOBOT(mock/live) · 배송 신형(오픈플랫폼). 각 단계 결과는 vendor_sync_state 에도 남는다.
 * 제조사 API 부담을 줄이려고 마지막 실행 뒤 60초 안에는 다시 돌리지 않는다.
 */
export interface RefreshStep {
  name: string;
  ok: boolean;
  detail: string;
}
export interface RefreshResult {
  at: string;
  steps: RefreshStep[];
}

export const REFRESH_COOLDOWN_SECONDS = 60;
let running = false;
let lastRunAt = 0;

/** 마지막 업데이트 시각(상태·작업/예약 동기화 중 가장 최근 성공). 화면 표시용. */
export async function lastRobotRefreshAt(): Promise<string | null> {
  const rows = await getDb()
    .select({ lastOkAt: schema.vendorSyncState.lastOkAt })
    .from(schema.vendorSyncState)
    .where(inArray(schema.vendorSyncState.id, ["PUDU:status", "CENOBOTS:status", "BIB:status", "PUDU:delivery-op-state"]));
  const ts = rows.map((r) => r.lastOkAt).filter((x): x is string => !!x).sort();
  return ts.at(-1) ?? null;
}

async function step(steps: RefreshStep[], name: string, fn: () => Promise<{ ok: boolean; detail: string }>): Promise<void> {
  try {
    const r = await fn();
    steps.push({ name, ok: r.ok, detail: r.detail });
  } catch (e) {
    steps.push({ name, ok: false, detail: (e as Error).message });
  }
}

/** user 가 없으면 시스템 실행(운영 스크립트). 있으면 본사 관리자만, 감사 기록. */
export async function refreshRobotsAndSchedules(user?: User): Promise<RefreshResult> {
  if (user && user.role !== "HQ_ADMIN") throw new ForbiddenError("본사 관리자만 업데이트할 수 있습니다.");
  const wait = Math.ceil(REFRESH_COOLDOWN_SECONDS - (Date.now() - lastRunAt) / 1000);
  if (running) throw new ValidationError("업데이트가 이미 진행 중입니다. 잠시 뒤 화면을 새로 고치세요.");
  if (user && wait > 0) throw new ValidationError(`방금 업데이트했습니다. ${wait}초 뒤에 다시 누를 수 있습니다.`);
  running = true;
  lastRunAt = Date.now();
  const steps: RefreshStep[] = [];
  try {
    const pudu = await import("@/worker/pudu");
    if (pudu.puduLiveEnabled()) {
      const api = (await import("@/lib/vendors/pudu/puduAdapter")).createPuduApi();
      await step(steps, "PUDU 로봇 상태", () => pudu.syncPuduStatus());
      await step(steps, "PUDU 작업·예약·소모품", () => pudu.syncPuduCatalog(api));
      await step(steps, "PUDU 예정 회차", () => pudu.syncPuduPlannedRuns());
    }
    const cz = await import("@/worker/cenobots");
    if (cz.cenobotsEnabled()) {
      const api = (await import("@/lib/vendors/cenobots/cenobotsAdapter")).createCenobotsApi();
      const tag = cz.cenobotsDryRun() ? "(모의·저장 안 함)" : "";
      await step(steps, `CENOBOT 로봇 상태${tag}`, () => cz.syncCenobotsStatus());
      await step(steps, `CENOBOT 작업·일정${tag}`, () => cz.syncCenobotsCatalog(api));
      await step(steps, `CENOBOT 예정 회차${tag}`, () => cz.syncCenobotsPlannedRuns());
      await step(steps, `CENOBOT 층 지도${tag}`, () => cz.syncCenobotsMaps(api));
    }
    const bib = await import("@/worker/bib");
    if (bib.bibEnabled()) {
      await step(steps, "BIB 로봇·작업", () => bib.syncBibCatalog());
      await step(steps, "BIB 층 지도", () => bib.syncBibMaps());
      await step(steps, "BIB 로봇 상태", () => bib.syncBibStatus());
    }
    const delivery = await import("@/lib/services/delivery");
    if (delivery.openPlatformEnabled() && pudu.puduLiveEnabled()) {
      for (const [name, fn] of [
        ["배송로봇 목록·지도", () => delivery.syncOpenPlatformCatalog()],
        ["배송로봇 상태", () => delivery.syncOpenPlatformState()],
      ] as const) {
        await step(steps, name, async () => {
          const r = await fn();
          await delivery.recordDeliverySync(r);
          return r;
        });
      }
    }
    if (!steps.length) steps.push({ name: "연동", ok: false, detail: "켜져 있는 로봇 연동이 없습니다(샘플 모드)." });
  } finally {
    running = false;
  }
  const at = nowIso();
  if (user) {
    const bad = steps.filter((s) => !s.ok);
    await audit(user, { siteId: null, robotId: null, action: "SYNC:MANUAL_REFRESH", params: { steps: steps.map((s) => s.name) }, result: bad.length ? "ERROR" : "OK", detail: bad.length ? bad.map((s) => `${s.name}: ${s.detail}`).join(" / ").slice(0, 500) : null, vendorTraceId: null });
  }
  return { at, steps };
}

/** 시험용: 쿨다운 초기화. */
export function resetRefreshCooldownForTest(): void {
  lastRunAt = 0;
  running = false;
}
