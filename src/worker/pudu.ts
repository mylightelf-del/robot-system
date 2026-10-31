import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Incident, Robot, Schedule } from "@/lib/domain/types";
import { getDb, schema } from "@/lib/db/client";
import { getNotificationSetting, getSite, getStatus, siteAt } from "@/lib/db/repo";
import { notifyIncident } from "@/lib/notify/notifier";
import { newId } from "@/lib/util/random";
import { addMinutes, localDateKey, localToUtcIso, nowIso } from "@/lib/util/time";
import { addDays } from "@/lib/reports/schedule";
import { vendorMode } from "@/lib/vendors";
import { PuduAdapter, createPuduApi, tzOffsetHours } from "@/lib/vendors/pudu/puduAdapter";
import { customerMessageFor, errorToIncidentKey, mapErrorLevel, mapReportToRun, productParamFor } from "@/lib/vendors/pudu/mapping";
import { parseShopIds } from "@/lib/vendors/pudu/client";
import type { PuduApi, PuduCleanReportSummary, PuduErrorLog } from "@/lib/vendors/pudu/api";
import { pendingPuduEvents, type PuduCallback } from "@/lib/vendors/pudu/webhook";

/**
 * PUDU 동기화 작업(워커). 모두 멱등이며 중복 키로 재적재를 막는다.
 * 주기(환경변수): 상태 PUDU_POLL_STATUS_SECONDS(60), 보고서·장애 PUDU_POLL_REPORTS_MINUTES(10), 작업·예약·소모품 PUDU_POLL_CATALOG_MINUTES(60).
 * 통계 API 제한(동시 1건, 7일 창, 10분 지연)에 맞춰 창은 최근 2일로 두고 직렬 호출한다.
 */
export interface SyncResult {
  job: string;
  ok: boolean;
  detail: string;
  counts?: Record<string, number>;
}

async function recordSync(job: string, fn: () => Promise<{ detail: string; counts?: Record<string, number> }>): Promise<SyncResult> {
  const db = getDb();
  const id = `PUDU:${job}`;
  const now = nowIso();
  try {
    const r = await fn();
    await db
      .insert(schema.vendorSyncState)
      .values({ id, vendor: "PUDU", job, lastRunAt: now, lastOkAt: now, lastError: null, stats: r.counts ?? {} })
      .onConflictDoUpdate({ target: schema.vendorSyncState.id, set: { lastRunAt: now, lastOkAt: now, lastError: null, stats: r.counts ?? {} } });
    return { job, ok: true, detail: r.detail, counts: r.counts };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    await db
      .insert(schema.vendorSyncState)
      .values({ id, vendor: "PUDU", job, lastRunAt: now, lastOkAt: null, lastError: msg })
      .onConflictDoUpdate({ target: schema.vendorSyncState.id, set: { lastRunAt: now, lastError: msg } });
    return { job, ok: false, detail: msg };
  }
}

/** 실제 API 로 다루는 PUDU 로봇만(제조사 API 에서 등록한 로봇, vendorMeta.source="api"). 샘플 로봇은 제외한다. */
export async function puduRobots(): Promise<Robot[]> {
  return getDb()
    .select()
    .from(schema.robots)
    .where(and(eq(schema.robots.vendor, "PUDU"), eq(schema.robots.active, true), sql`${schema.robots.vendorMeta}->>'source' = 'api'`));
}

/** 상태 폴링: 로봇별 상세 + V2 → robot_status 갱신(raw_payload 보관). 처리 중 명령의 실행 확인도 여기서 한다. */
export async function syncPuduStatus(adapter: PuduAdapter = new PuduAdapter()): Promise<SyncResult> {
  return recordSync("status", async () => {
    const db = getDb();
    const robots = await puduRobots();
    let updated = 0;
    let failed = 0;
    for (const robot of robots) {
      try {
        if (await pollRobotStatus(robot, adapter)) updated += 1;
      } catch (e) {
        failed += 1;
        // 조회 실패는 '미수신'으로 남긴다(상태를 지어내지 않음). 임계 초과 시 대시보드가 수신 지연으로 표시.
        await db.update(schema.robotStatus).set({ raw: `poll error: ${(e as Error).message}` }).where(eq(schema.robotStatus.robotId, robot.id));
      }
    }
    return { detail: `로봇 ${robots.length}대 중 갱신 ${updated}, 실패 ${failed}`, counts: { robots: robots.length, updated, failed } };
  });
}

/** 로봇 1대 폴링: 상세+V2 → robot_status 갱신 → 처리 중 명령 확인. 갱신했으면 true(역순 데이터면 false). */
export async function pollRobotStatus(robot: Robot, adapter: PuduAdapter = new PuduAdapter()): Promise<boolean> {
  const db = getDb();
  const st = await adapter.fetchStatus(robot);
  if (!st) return false;
  const prev = await getStatus(robot.id, db);
  // 역순 방어: 데이터 발생 시각이 기존보다 과거면 상태 본문은 덮지 않고 수신 시각만 갱신
  if (prev?.dataAt && st.dataAt && st.dataAt < prev.dataAt) {
    await db.update(schema.robotStatus).set({ lastReceivedAt: st.lastReceivedAt }).where(eq(schema.robotStatus.robotId, robot.id));
    return false;
  }
  await db
    .insert(schema.robotStatus)
    .values({ ...st, rawPayload: { source: "poll", raw: st.raw } })
    .onConflictDoUpdate({ target: schema.robotStatus.robotId, set: { ...st, rawPayload: { source: "poll", raw: st.raw } } });
  await confirmPendingCommands(robot, st.common);
  return true;
}

/** 접수(ACCEPTED) 된 PUDU 명령을 로봇 상태로 확인해 실행확인/완료/결과불명으로 바꾼다. */
export async function confirmPendingCommands(robot: Robot, common: string): Promise<void> {
  const db = getDb();
  const now = nowIso();
  const settings = await db.query.appSettings.findFirst({ where: eq(schema.appSettings.id, "default") });
  const timeoutSec = settings?.commandAcceptedTimeoutSeconds ?? 60;
  const pending = await db.select().from(schema.commands).where(and(eq(schema.commands.robotId, robot.id), inArray(schema.commands.state, ["ACCEPTED", "EXECUTING"])));
  for (const c of pending) {
    const expectExecuting: Record<string, string[]> = { START_TASK: ["CLEANING"], RESUME: ["CLEANING"], PAUSE: ["PAUSED"], STOP: ["IDLE", "CHARGING", "RETURNING"], GO_HOME: ["RETURNING", "CHARGING"] };
    const expectDone: Record<string, string[]> = { PAUSE: ["PAUSED"], STOP: ["IDLE", "CHARGING"], GO_HOME: ["CHARGING"], START_TASK: ["IDLE", "CHARGING"], RESUME: ["IDLE", "CHARGING"] };
    const ageSec = (new Date(now).getTime() - new Date(c.stateChangedAt).getTime()) / 1000;
    if (c.state === "ACCEPTED") {
      if (expectExecuting[c.type]?.includes(common)) {
        // 일시정지·중단처럼 한 번의 상태 변화로 끝나는 명령은 바로 완료 처리(실기: 일시정지 → 301 즉시)
        const startedTask = c.type === "START_TASK" || c.type === "RESUME";
        const done = !startedTask && (expectDone[c.type] ?? []).includes(common);
        await db.update(schema.commands).set({ state: done ? "COMPLETED" : "EXECUTING", stateChangedAt: now, message: `로봇 상태 ${common} 으로 ${done ? "완료" : "실행"} 확인(폴링)` }).where(eq(schema.commands.id, c.id));
      } else if (ageSec > timeoutSec) {
        await db.update(schema.commands).set({ state: "UNKNOWN", stateChangedAt: now, message: `접수 후 ${Math.round(ageSec)}초 동안 실행 확인 없음 — 상태/보고서 확인 필요` }).where(eq(schema.commands.id, c.id));
      }
    } else if (c.state === "EXECUTING") {
      const doneStates = expectDone[c.type] ?? [];
      const startedTask = c.type === "START_TASK" || c.type === "RESUME";
      if (doneStates.includes(common) && (!startedTask || ageSec > 30)) {
        await db.update(schema.commands).set({ state: "COMPLETED", stateChangedAt: now, message: `로봇 상태 ${common} 확인(폴링)` }).where(eq(schema.commands.id, c.id));
      }
    }
  }
}

/** 청소 보고서 → 실적 적재(최근 windowHours). 상세 조회로 물 사용량 등을 보강한다(통계 API 직렬). */
/** 조회 구간(초). 지정하지 않으면 지금부터 windowHours 전까지. 과거 이력 적재(scripts/pudu-backfill.ts)는 7일 이하 구간을 넘긴다(통계 API 권장). */
export type SyncRange = { start: number; end: number };

export async function syncPuduReports(api: PuduApi = createPuduApi(), windowHours = 48, range?: SyncRange): Promise<SyncResult> {
  return recordSync(range ? "reports-backfill" : "reports", async () => {
    const db = getDb();
    const robots = await puduRobots();
    const bySn = new Map(robots.map((r) => [r.vendorRobotId, r]));
    const now = nowIso();
    const end = range?.end ?? Math.floor(Date.now() / 1000);
    const start = range?.start ?? end - windowHours * 3600;
    const tz = tzOffsetHours("Asia/Seoul");
    let seen = 0;
    let inserted = 0;
    // 실기 확인: 통계 API 는 sn 으로 걸러지지 않고 shop_id 로만 걸러진다 → 허용 매장별로 조회하고 등록 로봇의 SN 만 적재한다.
    for (const shopId of parseShopIds(process.env.PUDU_SHOP_IDS)) for (let offset = 0; offset < 10000; offset += 20) {
      const page = await api.listCleanReports({ start_time: start, end_time: end, shop_id: shopId, timezone_offset: tz, limit: 20, offset });
      const list: PuduCleanReportSummary[] = page.list ?? [];
      for (const r of list) {
        seen += 1;
        const robot = bySn.get(r.sn);
        if (!robot) continue; // 등록되지 않은 로봇의 보고서는 건너뛴다(관리 화면 '로봇 가져오기'로 등록)
        if (r.status !== 4 && r.status !== 6 && r.status !== 3 && r.status !== 5) continue; // 진행 중 보고서는 종료 후 적재
        let detail = r;
        try {
          detail = await api.cleanReportDetail({ sn: r.sn, report_id: r.report_id, start_time: start, end_time: end, timezone_offset: tz, shop_id: shopId });
        } catch {
          /* 상세 실패 시 요약으로 적재 */
        }
        const taskRef = (detail as { task_id?: string }).task_id;
        const robotTasks = taskRef ? await db.select().from(schema.registeredTasks).where(eq(schema.registeredTasks.robotId, robot.id)) : [];
        const matched = robotTasks.find((t) => t.vendorTaskRef?.startsWith(`${taskRef}@`))?.id ?? null;
        const siteId = (await siteAt(robot.id, new Date(r.start_time * 1000).toISOString(), db)) ?? robot.siteId;
        const run = mapReportToRun(detail, { id: robot.id, siteId, floorId: robot.floorId }, now, matched);
        const res = await db
          .insert(schema.actualRuns)
          .values({ ...run, vendor: "PUDU", vendorRobotId: robot.vendorRobotId, rawPayload: detail })
          .onConflictDoNothing({ target: [schema.actualRuns.vendor, schema.actualRuns.vendorRobotId, schema.actualRuns.vendorRunId] })
          .returning({ id: schema.actualRuns.id });
        inserted += res.length;
        // 예정 회차 연결: 같은 로봇의 PLANNED 회차 중 시작 시각 ±90분 이내 첫 건
        if (res.length) {
          const planned = await db.select().from(schema.plannedRuns).where(and(eq(schema.plannedRuns.robotId, robot.id), eq(schema.plannedRuns.status, "PLANNED")));
          const hit = planned.find((p) => Math.abs(new Date(p.plannedAt).getTime() - new Date(run.startedAt).getTime()) <= 90 * 60_000);
          if (hit) await db.update(schema.plannedRuns).set({ status: "DONE", actualRunId: run.id }).where(eq(schema.plannedRuns.id, hit.id));
        }
      }
      if (list.length < 20) break;
    }
    return { detail: `보고서 ${seen}건 확인, 실적 ${inserted}건 신규`, counts: { seen, inserted } };
  });
}

/** 장애 로그 → 장애 적재(중복은 vendorEventId 로 차단). Fatal/Error 만 통보, Warning/Event 는 기록만. */
export async function syncPuduErrors(api: PuduApi = createPuduApi(), windowHours = 48, range?: SyncRange): Promise<SyncResult> {
  return recordSync(range ? "errors-backfill" : "errors", async () => {
    const robots = await puduRobots();
    const bySn = new Map(robots.map((r) => [r.vendorRobotId, r]));
    const end = range?.end ?? Math.floor(Date.now() / 1000);
    const start = range?.start ?? end - windowHours * 3600;
    // 과거 이력 적재(range 지정)에서 7일보다 오래된 로그는 조치할 대상이 아니라 이력이다 → 복구 상태로 적재해 미조치 목록을 채우지 않는다.
    const historicalBefore = new Date(Date.now() - HISTORICAL_ERROR_DAYS * 86_400_000).toISOString();
    let seen = 0;
    let inserted = 0;
    for (const shopId of parseShopIds(process.env.PUDU_SHOP_IDS)) for (let offset = 0; offset < 10000; offset += 20) {
      const page = await api.listErrors({ start_time: start, end_time: end, shop_id: shopId, timezone_offset: tzOffsetHours("Asia/Seoul"), limit: 20, offset });
      const list: PuduErrorLog[] = page.list ?? [];
      for (const e of list) {
        seen += 1;
        const robot = bySn.get(e.sn);
        if (!robot) continue;
        const occurredAt = e.task_time ? new Date(e.task_time.replace(" ", "T") + (e.task_time.includes("+") || e.task_time.endsWith("Z") ? "" : "+09:00")).toISOString() : nowIso();
        // 로그 동기화는 과거 이력 적재이므로 현재 상태를 덮지 않는다(실기: 며칠 전 로그로 정상 로봇이 ERROR 로 표시되는 문제). 현재 상태는 상세 폴링(task=-100/-200)이 정한다.
        const historical = !!range && occurredAt < historicalBefore;
        // 콜백 등록 전에는 폴링이 유일한 장애 수신 경로다 → 최근(NOTIFY_FRESH_MINUTES 이내) 발생분은 알림을 보낸다. 과거 이력 적재는 보내지 않는다.
        const fresh = !range && Date.now() - new Date(occurredAt).getTime() <= NOTIFY_FRESH_MINUTES * 60_000;
        if (await upsertIncidentFromError(robot, { code: e.error_type, level: e.error_level, detail: e.error_detail, key: errorToIncidentKey(e), occurredAt, payload: e, notify: fresh, touchStatus: false, historical })) inserted += 1;
      }
      if (list.length < 20) break;
    }
    return { detail: `장애 로그 ${seen}건 확인, 신규 ${inserted}건`, counts: { seen, inserted } };
  });
}

async function upsertIncidentFromError(robot: Robot, e: { code: string; level: string; detail: string; key: string; occurredAt: string; payload: unknown; notify: boolean; touchStatus: boolean; historical?: boolean }): Promise<boolean> {
  const db = getDb();
  const dup = await db.query.incidents.findFirst({ where: eq(schema.incidents.vendorEventId, e.key) });
  if (dup) return false;
  const grouped = await db.select({ id: schema.incidents.id }).from(schema.incidents).where(sql`${schema.incidents.groupedEventIds} ? ${e.key}`);
  if (grouped.length) return false; // 이미 묶음으로 집계된 발생
  const severity = mapErrorLevel(e.level);
  // 묶음: 같은 로봇·같은 코드의 미해결 장애가 최근 INCIDENT_GROUP_HOURS 안에 있으면 새로 만들지 않고 횟수·최근 발생 시각만 갱신한다.
  const open = await db
    .select()
    .from(schema.incidents)
    .where(and(eq(schema.incidents.robotId, robot.id), eq(schema.incidents.code, e.code), isNull(schema.incidents.dismissedAt), inArray(schema.incidents.status, e.historical ? ["RESOLVED"] : ["OPEN", "ACKED", "ASSIGNED", "IN_PROGRESS"])));
  const recent = open.find((i) => Math.abs(new Date(e.occurredAt).getTime() - new Date(i.lastOccurredAt ?? i.occurredAt).getTime()) <= INCIDENT_GROUP_HOURS * 3600_000);
  if (recent) {
    const newer = e.occurredAt > (recent.lastOccurredAt ?? recent.occurredAt);
    await db
      .update(schema.incidents)
      .set({ occurrences: recent.occurrences + 1, lastOccurredAt: newer ? e.occurredAt : (recent.lastOccurredAt ?? recent.occurredAt), ...(e.historical && newer ? { resolvedAt: e.occurredAt } : {}), groupedEventIds: [...(recent.groupedEventIds ?? []), e.key], ...(newer ? { rawMessage: `[${e.level}] ${e.code}: ${e.detail}`, rawPayload: e.payload } : {}) })
      .where(eq(schema.incidents.id, recent.id));
    return false;
  }
  const site = await getSite(robot.siteId, db);
  const inc: Incident = {
    id: newId("inc"),
    siteId: robot.siteId,
    robotId: robot.id,
    code: e.code,
    severity,
    rawMessage: `[${e.level}] ${e.code}: ${e.detail}`,
    customerMessage: customerMessageFor(e.code),
    occurredAt: e.occurredAt,
    status: e.historical ? "RESOLVED" : "OPEN",
    acknowledgedAt: null,
    assigneeId: null,
    // 과거 이력: 실제 복구 시각은 모른다 → 마지막 발생 시각으로 두고 조치 기록에 그렇게 밝힌다.
    resolvedAt: e.historical ? e.occurredAt : null,
    vendorEventId: e.key,
    occurrences: 1,
    lastOccurredAt: e.occurredAt,
    actions: e.historical ? [{ id: newId("act"), at: nowIso(), userId: "system", note: "제조사 장애 로그 이력에서 적재(조치·복구 기록 없음)", internal: false }] : [],
    notifications: [],
  };
  // 먼저 장애를 저장하고(실패하면 알림도 보내지 않음 → 다음 동기화에서 중복 알림이 나가지 않는다), 저장된 뒤에 알린다
  let inserted = false;
  await db.transaction(async (tx) => {
    const { actions, notifications: _n, ...row } = inc;
    inserted = (await tx.insert(schema.incidents).values({ ...row, rawPayload: e.payload }).onConflictDoNothing().returning({ id: schema.incidents.id })).length > 0;
    if (!inserted) return;
    if (actions.length) await tx.insert(schema.incidentActions).values(actions.map((a) => ({ ...a, incidentId: inc.id }))).onConflictDoNothing();
    if (e.touchStatus && (severity === "HIGH" || severity === "CRITICAL")) {
      await tx.update(schema.robotStatus).set({ common: "ERROR", raw: `ERROR:${e.code}`, lastReceivedAt: nowIso(), dataAt: e.occurredAt }).where(eq(schema.robotStatus.robotId, robot.id));
    }
  });
  if (!inserted) return false;
  if (e.notify && site && (severity === "HIGH" || severity === "CRITICAL")) {
    const setting = await getNotificationSetting(robot.siteId, db);
    const logs = await notifyIncident(setting, inc, null, nowIso(), site.timezone, "OCCURRED");
    if (logs.length) await db.insert(schema.notificationLogs).values(logs.map((l) => ({ ...l, incidentId: inc.id })));
  }
  return true;
}

/** 등록 작업·예약·소모품 동기화. 예약은 PUDU 가 단일 실행 주체(executor VENDOR, 읽기 전용). */
export async function syncPuduCatalog(api: PuduApi = createPuduApi()): Promise<SyncResult> {
  return recordSync("catalog", async () => {
    const db = getDb();
    const robots = await puduRobots();
    let tasks = 0;
    let crons = 0;
    let components = 0;
    for (const robot of robots) {
      const sn = robot.vendorRobotId;
      const upsertTask = async (t: { task_id: string; version: number; name: string; mode?: number }) => {
        const id = `task-pudu-${sn}-${t.task_id}`;
        const row = { id, siteId: robot.siteId, robotId: robot.id, name: t.name, zoneIds: [] as string[], mode: (t.mode === 1 ? "SCRUB" : "SWEEP") as "SCRUB" | "SWEEP", vendorTaskRef: `${t.task_id}@${t.version}` };
        await db.insert(schema.registeredTasks).values(row).onConflictDoUpdate({ target: schema.registeredTasks.id, set: { name: row.name, mode: row.mode, vendorTaskRef: row.vendorTaskRef, siteId: robot.siteId } });
        tasks += 1;
      };
      // task/list 는 product 가 필수(실기 확인). 등록 시 저장한 값 → 추정표 순으로 쓰고, 둘 다 없으면 예약의 task_list 로만 채운다.
      const product = (robot.vendorMeta?.product as string | undefined) ?? productParamFor(robot.vendorMeta?.productCode as string | undefined);
      if (product) {
        const taskPage = await api.listCleanTasks({ sn, product });
        for (const t of taskPage.item ?? taskPage.list ?? []) {
          if (t.status === -1) continue;
          await upsertTask({ task_id: t.task_id, version: t.version, name: t.name, mode: t.config?.mode ?? t.mode });
        }
      }
      const cronPage = await api.listCron(sn);
      const seenSchedules = new Set<string>();
      for (const c of cronPage.list ?? []) {
        for (const t of c.task_list ?? []) {
          const taskId = `task-pudu-${sn}-${t.task_id}`;
          // 예약에 걸린 작업이 task/list 에 없더라도(실기: 일부 로봇은 task/list 가 비어 있음) 예약 항목으로 등록 작업을 만든다.
          const exists = await db.query.registeredTasks.findFirst({ where: eq(schema.registeredTasks.id, taskId) });
          if (!exists) await upsertTask({ task_id: t.task_id, version: t.task_version, name: t.name, mode: t.clean_mode ?? t.mode });
          const s: Schedule = { id: `sch-pudu-${sn}-${c.cron_id}-${t.task_id}`, taskId, daysOfWeek: (c.weeks ?? []).map((w) => w % 7), time: `${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`, enabled: c.cron_status === "open", executor: "VENDOR" };
          await db.insert(schema.schedules).values(s).onConflictDoUpdate({ target: schema.schedules.id, set: { daysOfWeek: s.daysOfWeek, time: s.time, enabled: s.enabled } });
          seenSchedules.add(s.id);
          crons += 1;
        }
      }
      // PUDU 에서 지운 예약은 우리 쪽에서도 끈다(지우지 않고 사용 중지 — 이력 보존). 이 로봇의 제조사 예약만 대상.
      const ours = await db.select({ id: schema.schedules.id }).from(schema.schedules).where(and(sql`${schema.schedules.id} like ${`sch-pudu-${sn}-%`}`, eq(schema.schedules.enabled, true)));
      const gone = ours.map((o) => o.id).filter((id) => !seenSchedules.has(id));
      if (gone.length) await db.update(schema.schedules).set({ enabled: false }).where(inArray(schema.schedules.id, gone));
      const comp = await api.listComponents(sn);
      await db.delete(schema.maintenanceItems).where(and(eq(schema.maintenanceItems.robotId, robot.id), eq(schema.maintenanceItems.source, "API")));
      for (const c of comp.list ?? []) {
        await db.insert(schema.maintenanceItems).values({ id: `mnt-pudu-${sn}-${c.type}`, robotId: robot.id, name: `${c.name || c.type} 잔여 수명`, remainingPct: c.life_time > 0 ? Math.max(0, Math.round((1 - c.cost_time / c.life_time) * 100)) : null, source: "API" }).onConflictDoNothing();
        components += 1;
      }
    }
    return { detail: `작업 ${tasks} · 예약 ${crons} · 소모품 ${components}`, counts: { tasks, crons, components } };
  });
}

/** 예정 회차와 실적을 같은 회차로 보는 시각 차(분). 보고서 동기화의 연결 규칙과 같다. */
export const PLAN_MATCH_MINUTES = 90;
/** 예정 시각이 이만큼 지나야 수행/미실행을 판정한다(작업 시간·보고서 업로드 지연 여유). */
export const PLAN_SETTLE_HOURS = 3;

/**
 * PUDU 예약(제조사가 실행) → 계획 회차. 보고서의 계획 완료율 분모가 된다.
 * - 사업장 날짜로 오늘·내일 회차만 만든다(멱등). 지금 예약으로 과거 회차를 소급하지 않는다(그때 예약이 지금과 같다는 보장이 없다).
 * - 예정 시각이 PLAN_SETTLE_HOURS 지난 회차는 같은 로봇의 실적(±PLAN_MATCH_MINUTES)과 맞춰 수행(DONE) 또는 미실행(MISSED)으로 정리한다.
 */
export async function syncPuduPlannedRuns(now: string = nowIso()): Promise<SyncResult> {
  return recordSync("plan", async () => {
    const db = getDb();
    const robots = await puduRobots();
    let created = 0;
    let done = 0;
    let missed = 0;
    for (const robot of robots) {
      const tz = (await getSite(robot.siteId, db))?.timezone ?? "Asia/Seoul";
      const tasks = await db.select().from(schema.registeredTasks).where(eq(schema.registeredTasks.robotId, robot.id));
      const schedules = tasks.length ? await db.select().from(schema.schedules).where(and(inArray(schema.schedules.taskId, tasks.map((t) => t.id)), eq(schema.schedules.enabled, true))) : [];
      const today = localDateKey(now, tz);
      for (const day of [today, addDays(today, 1)]) {
        const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
        for (const s of schedules) {
          if (!s.daysOfWeek.includes(dow)) continue;
          const plannedAt = localToUtcIso(day, s.time, tz);
          const res = await db
            .insert(schema.plannedRuns)
            .values({ id: `plan-${s.id}-${plannedAt}`, scheduleId: s.id, taskId: s.taskId, robotId: robot.id, siteId: robot.siteId, plannedAt, status: "PLANNED", reason: null, actualRunId: null, changeHistory: [] })
            .onConflictDoNothing()
            .returning({ id: schema.plannedRuns.id });
          created += res.length;
        }
      }
      const settleBefore = new Date(new Date(now).getTime() - PLAN_SETTLE_HOURS * 3600_000).toISOString();
      // 판정 대상: 예정 시각이 지난 PLANNED + 최근 48시간 안에 '미실행'으로 판정했던 회차(긴 작업은 보고서가 늦게 올라와 뒤늦게 맞춰질 수 있다)
      const relinkSince = new Date(new Date(now).getTime() - 48 * 3600_000).toISOString();
      const pending = await db
        .select()
        .from(schema.plannedRuns)
        .where(
          and(
            eq(schema.plannedRuns.robotId, robot.id),
            sql`((${schema.plannedRuns.status} = 'PLANNED' and ${schema.plannedRuns.plannedAt} < ${settleBefore}) or (${schema.plannedRuns.status} = 'MISSED' and ${schema.plannedRuns.plannedAt} > ${relinkSince} and ${schema.plannedRuns.actualRunId} is null and ${schema.plannedRuns.reason} like '%자동 판정%'))`,
          ),
        );
      if (!pending.length) continue;
      const runs = await db.select().from(schema.actualRuns).where(eq(schema.actualRuns.robotId, robot.id));
      const linked = new Set((await db.select({ id: schema.plannedRuns.actualRunId }).from(schema.plannedRuns).where(eq(schema.plannedRuns.robotId, robot.id))).map((r) => r.id).filter(Boolean));
      for (const p of pending.sort((a, b) => a.plannedAt.localeCompare(b.plannedAt))) {
        const t = new Date(p.plannedAt).getTime();
        const hit = runs
          .filter((r) => !linked.has(r.id) && Math.abs(new Date(r.startedAt).getTime() - t) <= PLAN_MATCH_MINUTES * 60_000)
          .sort((a, b) => Math.abs(new Date(a.startedAt).getTime() - t) - Math.abs(new Date(b.startedAt).getTime() - t))[0];
        if (hit) {
          linked.add(hit.id);
          await db.update(schema.plannedRuns).set({ status: "DONE", actualRunId: hit.id }).where(eq(schema.plannedRuns.id, p.id));
          done += 1;
        } else if (p.status === "PLANNED") {
          await db.update(schema.plannedRuns).set({ status: "MISSED", reason: `예정 시각 ±${PLAN_MATCH_MINUTES}분 안에 실적 없음(자동 판정)` }).where(eq(schema.plannedRuns.id, p.id));
          missed += 1;
        }
      }
    }
    return { detail: `계획 회차 신규 ${created} · 수행 ${done} · 미실행 ${missed}`, counts: { created, done, missed } };
  });
}

/** 콜백 이벤트 처리(비동기). 순서 보장이 없으므로 발생 시각이 기존 데이터보다 과거면 상태를 덮지 않는다. */
export async function processPuduEvents(limit = 100): Promise<SyncResult> {
  return recordSync("events", async () => {
    const db = getDb();
    const events = await pendingPuduEvents(limit);
    let done = 0;
    let errors = 0;
    for (const ev of events) {
      try {
        await applyEvent(ev.payload as PuduCallback, ev.occurredAt ?? ev.receivedAt);
        await db.update(schema.vendorEvents).set({ processedAt: nowIso(), processError: null }).where(eq(schema.vendorEvents.id, ev.id));
        done += 1;
      } catch (e) {
        errors += 1;
        await db.update(schema.vendorEvents).set({ processedAt: nowIso(), processError: (e as Error).message }).where(eq(schema.vendorEvents.id, ev.id));
      }
    }
    return { detail: `이벤트 ${events.length}건 중 처리 ${done}, 오류 ${errors}`, counts: { events: events.length, done, errors } };
  });
}

async function applyEvent(cb: PuduCallback, occurredAt: string): Promise<void> {
  const db = getDb();
  const sn = String(cb.data.sn ?? "");
  const robot = sn ? await db.query.robots.findFirst({ where: and(eq(schema.robots.vendor, "PUDU"), eq(schema.robots.vendorRobotId, sn)) }) : undefined;
  if (!robot) return; // 미등록 로봇의 이벤트는 원문만 보관
  const prev = await getStatus(robot.id, db);
  const stale = !!prev?.dataAt && occurredAt < prev.dataAt;
  const touch = { lastReceivedAt: nowIso(), dataAt: occurredAt };

  switch (cb.callback_type) {
    case "robotStatus": {
      // 온라인/오프라인
      if (stale) return;
      const online = cb.data.run_status === "online";
      await db.update(schema.robotStatus).set({ online, common: online ? (prev?.common === "OFFLINE" ? "IDLE" : (prev?.common ?? "IDLE")) : "OFFLINE", poseIsLastKnown: !online, raw: `callback robotStatus=${cb.data.run_status}`, ...touch }).where(eq(schema.robotStatus.robotId, robot.id));
      return;
    }
    case "notifyRobotStatus": {
      if (stale) return;
      const battery = typeof cb.data.battery === "number" ? cb.data.battery : prev?.batteryPct ?? null;
      const runState = String(cb.data.run_state ?? "");
      const isCharging = cb.data.is_charging === 1;
      const common = runState === "OFFLINE" ? "OFFLINE" : isCharging ? "CHARGING" : prev?.common === "OFFLINE" ? "IDLE" : (prev?.common ?? "IDLE");
      await db.update(schema.robotStatus).set({ batteryPct: battery, common, online: runState !== "OFFLINE", raw: `callback notifyRobotStatus run_state=${runState} charging=${cb.data.is_charging}`, ...touch }).where(eq(schema.robotStatus.robotId, robot.id));
      return;
    }
    case "notifyCleanStatus":
    case "TASK_STATUS": {
      const status = String(cb.data.status ?? "");
      if (!stale) {
        const map: Record<string, { common: "CLEANING" | "IDLE"; progress: number | null }> = { BEGIN: { common: "CLEANING", progress: 0 }, END: { common: "IDLE", progress: null }, INTERRUP: { common: "IDLE", progress: null }, CANCEL: { common: "IDLE", progress: null }, START_FAILED: { common: "IDLE", progress: null } };
        const m = map[status];
        if (m) {
          await db.update(schema.robotStatus).set({ common: m.common, progressPct: m.progress, currentMissionId: m.common === "CLEANING" ? String(cb.data.task_id ?? "") : null, raw: `callback ${cb.callback_type}=${status}${cb.data.remark ? ` (${cb.data.remark})` : ""}`, ...touch }).where(eq(schema.robotStatus.robotId, robot.id));
        }
      }
      // 명령 실행 확인/완료
      const pending = await db.select().from(schema.commands).where(and(eq(schema.commands.robotId, robot.id), inArray(schema.commands.state, ["ACCEPTED", "EXECUTING"])));
      for (const c of pending) {
        if ((c.type === "START_TASK" || c.type === "RESUME") && status === "BEGIN" && c.state === "ACCEPTED") {
          await db.update(schema.commands).set({ state: "EXECUTING", stateChangedAt: nowIso(), message: "콜백 BEGIN 으로 실행 확인" }).where(eq(schema.commands.id, c.id));
        } else if ((c.type === "START_TASK" || c.type === "RESUME") && (status === "END" || status === "INTERRUP" || status === "CANCEL")) {
          await db.update(schema.commands).set({ state: status === "END" ? "COMPLETED" : "FAILED", stateChangedAt: nowIso(), message: `콜백 ${status}${cb.data.remark ? ` (${cb.data.remark})` : ""}` }).where(eq(schema.commands.id, c.id));
        } else if (c.type === "STOP" && status === "CANCEL") {
          await db.update(schema.commands).set({ state: "COMPLETED", stateChangedAt: nowIso(), message: "콜백 CANCEL 확인" }).where(eq(schema.commands.id, c.id));
        } else if (c.type === "START_TASK" && status === "START_FAILED") {
          await db.update(schema.commands).set({ state: "FAILED", stateChangedAt: nowIso(), message: `콜백 START_FAILED${cb.data.remark ? ` (${cb.data.remark})` : ""}` }).where(eq(schema.commands.id, c.id));
        }
      }
      return;
    }
    case "robotErrorNotice":
    case "robotErrorWarning": {
      const key = errorToIncidentKey({ error_id: String(cb.data.error_id ?? ""), id: "", sn, task_time: String(cb.data.timestamp ?? ""), error_type: String(cb.data.error_type ?? "") });
      // 실시간 콜백은 현재 상태를 ERROR 로 바꾼다(단, 더 새로운 상태 데이터가 이미 있으면 덮지 않는다).
      await upsertIncidentFromError(robot, { code: String(cb.data.error_type ?? "UNKNOWN"), level: String(cb.data.error_level ?? "Error"), detail: String(cb.data.error_detail ?? ""), key, occurredAt, payload: cb, notify: cb.callback_type === "robotErrorNotice", touchStatus: !stale });
      return;
    }
    default:
      return; // 청소로봇과 무관한 콜백(배송 등)은 보관만
  }
}

/** 워커 루프에 붙이는 묶음. 주기는 호출 측이 정한다. */
export function puduLiveEnabled(): boolean {
  return vendorMode("PUDU") === "live";
}

/** 같은 로봇·같은 코드의 반복 발생을 한 장애로 묶는 시간 창(시간). */
export const INCIDENT_GROUP_HOURS = Number(process.env.INCIDENT_GROUP_HOURS ?? 6);
export const PUDU_WINDOW_HOURS = Number(process.env.PUDU_POLL_WINDOW_HOURS ?? 48);
/** 폴링으로 받은 장애 로그 중 발생 후 이 시간(분) 안의 것만 알림을 보낸다(통계 API 약 10분 지연 + 10분 주기 고려). */
export const NOTIFY_FRESH_MINUTES = Number(process.env.NOTIFY_FRESH_MINUTES ?? 60);
/** 이보다 오래된 장애 로그는 과거 이력(복구 상태)으로 적재한다. */
export const HISTORICAL_ERROR_DAYS = 7;
export { addMinutes };
