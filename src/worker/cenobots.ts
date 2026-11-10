import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Robot, Schedule } from "@/lib/domain/types";
import { getDb, schema } from "@/lib/db/client";
import { getSite, getStatus, siteAt } from "@/lib/db/repo";
import { storeRunImage } from "@/lib/services/coverage";
import { snapshotMaintenance } from "@/lib/services/maintenance";
import { nowIso } from "@/lib/util/time";
import { vendorMode } from "@/lib/vendors";
import { allMissions, type CenobotsApi } from "@/lib/vendors/cenobots/api";
import { CenobotsAdapter, cenobotsSettings, createCenobotsApi, isAllowedDevice, openIdOf } from "@/lib/vendors/cenobots/cenobotsAdapter";
import { czCustomerMessage, czErrorCode, MAINTENANCE_NAME_KO, mapDeviceStatus, mapMissionToRun, maintenanceRemainingPct, parseCzDays, parseCzTime, scheduleName, TASK_STATUS_COMMON } from "@/lib/vendors/cenobots/mapping";
import { pendingCzEvents, type CzEvent } from "@/lib/vendors/cenobots/webhook";
import { recordVendorSync, settlePlannedRuns, upsertIncidentFromError, PLAN_MATCH_MINUTES, type SyncResult, type SyncRange } from "./pudu";

/**
 * CENOBOTS(CZ Robots) 동기화 작업(워커) — 조회 전용. PUDU 와 같은 패턴(멱등, 중복 키, vendor_sync_state 기록).
 * 주기(환경변수): 상태 CENOBOTS_POLL_STATUS_SECONDS(60), 작업 이력·장애 CENOBOTS_POLL_REPORTS_MINUTES(10), 장비·예약·소모품 CENOBOTS_POLL_CATALOG_MINUTES(60).
 *
 * 운영 서버의 mock(APP_ENV=production + CENOBOTS_MODE=mock)은 dry-run: 픽스처를 조회·매핑만 하고 DB(로봇·실적·장애·상태)에는 쓰지 않는다.
 */
const sync = (job: string, fn: () => Promise<{ detail: string; counts?: Record<string, number> }>) => recordVendorSync("CENOBOTS", job, fn);

export function cenobotsEnabled(): boolean {
  const m = vendorMode("CENOBOTS");
  return m === "live" || m === "mock";
}

export function cenobotsDryRun(): boolean {
  return vendorMode("CENOBOTS") === "mock" && process.env.APP_ENV === "production";
}

export const CENOBOTS_WINDOW_HOURS = Number(process.env.CENOBOTS_POLL_WINDOW_HOURS ?? 48);

/** 조회 대상: 사용 중인 CENOBOTS 로봇 중 deviceOpenId 가 연결된 것(제조사 API 등록, source="api"). */
export async function cenobotsRobots(): Promise<Robot[]> {
  const rows = await getDb()
    .select()
    .from(schema.robots)
    .where(and(eq(schema.robots.vendor, "CENOBOTS"), eq(schema.robots.active, true), sql`${schema.robots.vendorMeta}->>'source' = 'api'`));
  const mode = vendorMode("CENOBOTS");
  // mock 으로 연결된 로봇은 live 에서 조회하지 않는다(가짜 deviceOpenId). 반대도 같다.
  return rows.filter((r) => openIdOf(r) && (r.vendorMeta?.boundMode ?? "live") === mode);
}

async function robotByOpenId(openId: string): Promise<Robot | undefined> {
  return (await cenobotsRobots()).find((r) => openIdOf(r) === openId);
}

function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60);
}

/** 장비 목록 → 번호판으로 미리 등록한 로봇에 deviceOpenId 연결, 예약·소모품·장비 정보 동기화. */
export async function syncCenobotsCatalog(api: CenobotsApi = createCenobotsApi()): Promise<SyncResult> {
  return sync("catalog", async (): Promise<{ detail: string; counts: Record<string, number> }> => {
    const db = getDb();
    const settings = cenobotsSettings();
    const allowedList = settings?.cfg.allowed ?? [];
    const devices = (await api.listDevices()).filter((d) => isAllowedDevice(d, allowedList));
    const mode = vendorMode("CENOBOTS");
    if (cenobotsDryRun()) {
      // 운영 mock: 조회·매핑만(적재 없음)
      let runs = 0;
      let errors = 0;
      const end = Date.now();
      for (const d of devices) {
        mapDeviceStatus(await api.status(d.deviceOpenId));
        runs += (await allMissions(api, d.deviceOpenId, end - CENOBOTS_WINDOW_HOURS * 3600_000, end)).length;
        errors += (await api.systemErrors(d.deviceOpenId)).length;
      }
      return { detail: `모의(dry-run): 허용 장비 ${devices.length}대 조회, 작업 이력 ${runs}건·활성 오류 ${errors}건 매핑 — 운영 DB 적재 안 함`, counts: { devices: devices.length, runs, errors, dryRun: 1 } };
    }
    // 1) 번호판 → deviceOpenId 연결(미리 등록해 둔 로봇). 모드가 바뀌면(mock → live) 다시 연결한다.
    const all = await db.select().from(schema.robots).where(eq(schema.robots.vendor, "CENOBOTS"));
    let bound = 0;
    for (const r of all) {
      const plate = r.vendorMeta?.licensePlate as string | undefined;
      if (!plate || r.vendorMeta?.source !== "api") continue;
      const d = devices.find((x) => x.licensePlate === plate);
      if (!d) continue;
      if (openIdOf(r) === d.deviceOpenId && (r.vendorMeta?.boundMode ?? "live") === mode) continue;
      await db.update(schema.robots).set({ vendorRobotId: d.deviceOpenId, vendorMeta: { ...(r.vendorMeta ?? {}), deviceOpenId: d.deviceOpenId, boundMode: mode, boundAt: nowIso() } }).where(eq(schema.robots.id, r.id));
      bound += 1;
    }
    // 2) 연결된(사용 중) 로봇의 장비 정보·예약·소모품
    const robots = await cenobotsRobots();
    let schedules = 0;
    let components = 0;
    for (const robot of robots) {
      const openId = openIdOf(robot)!;
      try {
        const info = await api.info(openId);
        if (info.serialNumber || info.softwareVersion) await db.update(schema.robots).set({ serial: info.serialNumber || robot.serial, firmware: info.softwareVersion || robot.firmware }).where(eq(schema.robots.id, robot.id));
      } catch {
        /* 장비 정보는 부가 정보 */
      }
      // 예약(제조사가 실행, 읽기 전용). 예약 하나 = 등록 작업 하나.
      const seen = new Set<string>();
      for (const s of await api.schedules(openId)) {
        const time = parseCzTime(s.startTime);
        if (!time) continue;
        const taskId = `task-cz-${openId}-${s.id}`;
        await db
          .insert(schema.registeredTasks)
          .values({ id: taskId, siteId: robot.siteId, robotId: robot.id, name: scheduleName(s), zoneIds: [], mode: "SCRUB", vendorTaskRef: `schedule:${s.id}` })
          .onConflictDoUpdate({ target: schema.registeredTasks.id, set: { name: scheduleName(s), siteId: robot.siteId } });
        const row: Schedule = { id: `sch-cz-${openId}-${s.id}`, taskId, daysOfWeek: parseCzDays(s.executionDays), time, enabled: !!s.enable, executor: "VENDOR" };
        await db.insert(schema.schedules).values(row).onConflictDoUpdate({ target: schema.schedules.id, set: { daysOfWeek: row.daysOfWeek, time: row.time, enabled: row.enabled } });
        seen.add(row.id);
        schedules += 1;
      }
      const ours = await db.select({ id: schema.schedules.id }).from(schema.schedules).where(and(sql`${schema.schedules.id} like ${`sch-cz-${openId}-%`}`, eq(schema.schedules.enabled, true)));
      const gone = ours.map((o) => o.id).filter((id) => !seen.has(id));
      if (gone.length) await db.update(schema.schedules).set({ enabled: false }).where(inArray(schema.schedules.id, gone));
      // 소모품(maintenance-detail, L4 에서 실기 확인 필요)
      const m = await api.maintenance(openId);
      await db.delete(schema.maintenanceItems).where(and(eq(schema.maintenanceItems.robotId, robot.id), eq(schema.maintenanceItems.source, "API")));
      const snap: { key: string; name: string; remainingPct: number | null }[] = [];
      for (const i of m.maintenanceItems ?? []) {
        const name = `${MAINTENANCE_NAME_KO[i.name] ?? i.name} 잔여 수명`;
        const remainingPct = maintenanceRemainingPct(i);
        await db.insert(schema.maintenanceItems).values({ id: `mnt-cz-${openId}-${slug(i.name)}`, robotId: robot.id, name, remainingPct, source: "API" }).onConflictDoNothing();
        snap.push({ key: slug(i.name), name, remainingPct });
        components += 1;
      }
      await snapshotMaintenance(robot.id, snap, (await getSite(robot.siteId, db))?.timezone ?? "Asia/Seoul", db);
    }
    return { detail: `허용 장비 ${devices.length}대 · 연결 ${bound} · 예약 ${schedules} · 소모품 ${components}`, counts: { devices: devices.length, bound, schedules, components } };
  });
}

/** 상태 폴링 → robot_status. 조회 실패는 '미수신'(상태를 지어내지 않음). */
export async function syncCenobotsStatus(adapter?: CenobotsAdapter): Promise<SyncResult> {
  return sync("status", async () => {
    const db = getDb();
    const robots = await cenobotsRobots();
    const a = adapter ?? new CenobotsAdapter();
    let updated = 0;
    let failed = 0;
    for (const robot of robots) {
      try {
        const st = await a.fetchStatus(robot);
        if (!st) continue;
        await db.insert(schema.robotStatus).values({ ...st, rawPayload: { source: "poll", raw: st.raw } }).onConflictDoUpdate({ target: schema.robotStatus.robotId, set: { ...st, rawPayload: { source: "poll", raw: st.raw } } });
        updated += 1;
      } catch (e) {
        failed += 1;
        await db.update(schema.robotStatus).set({ raw: `poll error: ${(e as Error).message}` }).where(eq(schema.robotStatus.robotId, robot.id));
      }
    }
    return { detail: `로봇 ${robots.length}대 중 갱신 ${updated}, 실패 ${failed}`, counts: { robots: robots.length, updated, failed } };
  });
}

/** 작업 이력 → 실적(missionId 중복 제거). range 가 있으면 과거 이력 적재(백필). */
export async function syncCenobotsReports(api: CenobotsApi = createCenobotsApi(), windowHours = CENOBOTS_WINDOW_HOURS, range?: SyncRange): Promise<SyncResult> {
  return sync(range ? "reports-backfill" : "reports", async () => {
    const db = getDb();
    const robots = await cenobotsRobots();
    const endMs = range ? range.end * 1000 : Date.now();
    const startMs = range ? range.start * 1000 : endMs - windowHours * 3600_000;
    const now = nowIso();
    let seen = 0;
    let inserted = 0;
    let unknown = 0;
    for (const robot of robots) {
      const openId = openIdOf(robot)!;
      for (const m of await allMissions(api, openId, startMs, endMs)) {
        seen += 1;
        const siteId = (await siteAt(robot.id, new Date(m.startTimeStamp).toISOString(), db)) ?? robot.siteId;
        const mapped = mapMissionToRun(m, { id: robot.id, siteId, floorId: robot.floorId, openId }, now);
        if (!mapped) continue; // 진행 중(종료 후 적재)
        if (mapped.unknownStatus) {
          unknown += 1;
          console.warn(`[cenobots] 미분류 작업 상태 '${m.status}' (mission ${m.missionId}) — mapping.ts MISSION_STATUS_MAP 확인`);
        }
        const run = mapped.run;
        const res = await db
          .insert(schema.actualRuns)
          .values({ ...run, vendor: "CENOBOTS", vendorRobotId: openId, rawPayload: m })
          .onConflictDoNothing({ target: [schema.actualRuns.vendor, schema.actualRuns.vendorRobotId, schema.actualRuns.vendorRunId] })
          .returning({ id: schema.actualRuns.id });
        inserted += res.length;
        if (res.length && run.coverage?.resultImageUrl) await storeRunImage(run.id, "RESULT", db).catch(() => undefined);
        if (res.length) {
          const planned = await db.select().from(schema.plannedRuns).where(and(eq(schema.plannedRuns.robotId, robot.id), eq(schema.plannedRuns.status, "PLANNED")));
          const hit = planned.find((p) => Math.abs(new Date(p.plannedAt).getTime() - new Date(run.startedAt).getTime()) <= PLAN_MATCH_MINUTES * 60_000);
          if (hit) await db.update(schema.plannedRuns).set({ status: "DONE", actualRunId: run.id, reason: null }).where(eq(schema.plannedRuns.id, hit.id));
        }
      }
    }
    return { detail: `작업 이력 ${seen}건 확인, 실적 ${inserted}건 신규${unknown ? `, 미분류 ${unknown}건` : ""}`, counts: { robots: robots.length, seen, inserted, unknown } };
  });
}

/**
 * 활성 시스템 오류 → 장애. 목록은 '지금 걸려 있는 오류'(발생 시각 없음)라, 같은 로봇·같은 코드의 미해결 장애가 있으면 만들지 않는다.
 * 기본 등급은 '높음'(관리 설정 → 장애 등급 설정에서 코드별로 바꿀 수 있음).
 */
export async function syncCenobotsErrors(api: CenobotsApi = createCenobotsApi()): Promise<SyncResult> {
  return sync("errors", async () => {
    const db = getDb();
    const robots = await cenobotsRobots();
    let active = 0;
    let inserted = 0;
    for (const robot of robots) {
      const openId = openIdOf(robot)!;
      for (const e of await api.systemErrors(openId)) {
        active += 1;
        const code = czErrorCode(e.code);
        const open = await db
          .select({ id: schema.incidents.id })
          .from(schema.incidents)
          .where(and(eq(schema.incidents.robotId, robot.id), eq(schema.incidents.code, code), isNull(schema.incidents.dismissedAt), inArray(schema.incidents.status, ["OPEN", "ACKED", "ASSIGNED", "IN_PROGRESS"])));
        if (open.length) continue;
        const at = nowIso();
        if (await upsertIncidentFromError(robot, { code, level: "Error", detail: `${e.name}: ${e.description}`, key: `cz:${openId}:${e.code}:${at.slice(0, 16)}`, occurredAt: at, payload: e, notify: true, touchStatus: true, baseSeverity: "HIGH", customerMessage: czCustomerMessage(code, e.description) })) inserted += 1;
      }
    }
    return { detail: `활성 오류 ${active}건 확인, 신규 장애 ${inserted}건`, counts: { robots: robots.length, active, inserted } };
  });
}

export async function syncCenobotsPlannedRuns(now: string = nowIso()): Promise<SyncResult> {
  return sync("plan", async () => settlePlannedRuns(await cenobotsRobots(), now));
}

/** 웹훅 이벤트 처리(비동기). occurredAt 이 기존 상태보다 오래되면 상태를 덮지 않는다. */
export async function processCenobotsEvents(limit = 100): Promise<SyncResult> {
  return sync("events", async () => {
    const db = getDb();
    const events = await pendingCzEvents(limit);
    let done = 0;
    let errors = 0;
    for (const ev of events) {
      try {
        if (!cenobotsDryRun()) await applyCzEvent(ev.payload as CzEvent, ev.occurredAt ?? ev.receivedAt);
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

async function applyCzEvent(ev: CzEvent, occurredAt: string): Promise<void> {
  const db = getDb();
  const openId = ev.device?.openId ?? "";
  const robot = openId ? await robotByOpenId(openId) : undefined;
  if (!robot) return; // 미등록·사용 중지 로봇은 원문만 보관
  const prev = await getStatus(robot.id, db);
  const stale = !!prev?.dataAt && occurredAt < prev.dataAt;
  const d = (ev.data ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case "robot.task.status_changed": {
      if (stale) return;
      const running = d.isRunning === true;
      const name = String((d.status as { name?: string } | undefined)?.name ?? "").toUpperCase();
      const sweep = String(d.sweepType ?? "").toLowerCase();
      const common = !running ? (prev?.common === "OFFLINE" || prev?.common === "ERROR" ? prev.common : "IDLE") : sweep === "homing" || sweep === "charge" || name === "BACK_TO_STATION" ? "RETURNING" : (TASK_STATUS_COMMON[name] ?? "CLEANING");
      const progress = typeof d.progress === "number" && running ? Math.round((d.progress <= 1 ? d.progress * 100 : d.progress) as number) : null;
      await db
        .update(schema.robotStatus)
        .set({ common, progressPct: progress, currentMissionId: running ? String(d.taskId ?? "") || null : null, online: true, raw: `webhook task ${running ? "running" : "ended"} status=${name || "-"} sweep=${d.sweepType ?? "-"}`, lastReceivedAt: nowIso(), dataAt: occurredAt })
        .where(eq(schema.robotStatus.robotId, robot.id));
      return;
    }
    case "robot.error.changed": {
      const codes = (d.codes as { code: number; desc?: string }[] | undefined) ?? [];
      for (const c of (d.addedCodes as number[] | undefined) ?? []) {
        const desc = codes.find((x) => x.code === c)?.desc ?? "";
        const code = czErrorCode(c);
        await upsertIncidentFromError(robot, { code, level: "Error", detail: desc, key: `cz:${openId}:${c}:${ev.id}`, occurredAt, payload: ev, notify: true, touchStatus: !stale, baseSeverity: "HIGH", customerMessage: czCustomerMessage(code, desc) });
      }
      return;
    }
    case "robot.maintenance.changed": {
      for (const it of (d.changedItems as { changeType: string; type: string; current?: { left?: number; max?: number } }[] | undefined) ?? []) {
        const id = `mnt-cz-${openId}-${slug(it.type)}`;
        if (it.changeType === "REMOVED") {
          await db.delete(schema.maintenanceItems).where(eq(schema.maintenanceItems.id, id));
          continue;
        }
        const left = it.current?.left;
        const max = it.current?.max;
        const remainingPct = typeof left === "number" && typeof max === "number" && max > 0 ? Math.max(0, Math.round((left / max) * 100)) : null;
        const name = `${MAINTENANCE_NAME_KO[it.type] ?? it.type} 잔여 수명`;
        await db.insert(schema.maintenanceItems).values({ id, robotId: robot.id, name, remainingPct, source: "API" }).onConflictDoUpdate({ target: schema.maintenanceItems.id, set: { name, remainingPct } });
      }
      return;
    }
    case "robot.need_help_door_call": {
      await upsertIncidentFromError(robot, { code: "CZ-DOOR_CALL", level: "Warning", detail: "문 열기 도움 요청", key: `cz:${openId}:door:${ev.id}`, occurredAt, payload: ev, notify: false, touchStatus: false, baseSeverity: "MEDIUM", customerMessage: czCustomerMessage("CZ-DOOR_CALL") });
      return;
    }
    default:
      return;
  }
}
