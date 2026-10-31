import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import type { CleanMode, PlannedRun, RegisteredTask, Schedule, User } from "@/lib/domain/types";
import { accessibleSiteIds, assertActive, assertRobotAccess, assertSiteAccess, isCustomer } from "@/lib/auth/authz";
import { getDb, schema } from "@/lib/db/client";
import { getRobot, listSitesByIds, listZonesByFloor } from "@/lib/db/repo";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/util/errors";
import { newId } from "@/lib/util/random";
import { nowIso } from "@/lib/util/time";
import { audit } from "./audit";

export interface TaskRow {
  task: RegisteredTask;
  schedules: Schedule[];
  robotName: string;
  siteName: string;
  zoneNames: string[];
  vendor: string;
  model: string;
}

export async function listTasks(user: User, siteId?: string): Promise<TaskRow[]> {
  assertActive(user);
  const db = getDb();
  const siteIds = await accessibleSiteIds(user, db);
  if (siteId) await assertSiteAccess(user, siteId, db);
  const ids = siteId ? [siteId] : siteIds;
  if (ids.length === 0) return [];
  const tasks = await db.select().from(schema.registeredTasks).where(inArray(schema.registeredTasks.siteId, ids)).orderBy(schema.registeredTasks.siteId, schema.registeredTasks.robotId, schema.registeredTasks.id);
  if (tasks.length === 0) return [];
  const scheduleRows = await db.select().from(schema.schedules).where(inArray(schema.schedules.taskId, tasks.map((t) => t.id)));
  const robots = await db.select().from(schema.robots).where(inArray(schema.robots.id, Array.from(new Set(tasks.map((t) => t.robotId)))));
  const zones = await db.select().from(schema.zones).where(inArray(schema.zones.id, Array.from(new Set(tasks.flatMap((t) => t.zoneIds)))));
  const sites = new Map((await listSitesByIds(ids, db)).map((s) => [s.id, s.name]));
  return tasks.map((t) => {
    const robot = robots.find((r) => r.id === t.robotId);
    return {
      task: t,
      schedules: scheduleRows.filter((s) => s.taskId === t.id),
      robotName: robot?.name ?? t.robotId,
      siteName: sites.get(t.siteId) ?? t.siteId,
      zoneNames: t.zoneIds.map((z) => zones.find((x) => x.id === z)?.name ?? z),
      vendor: robot?.vendor ?? "-",
      model: robot?.model ?? "-",
    };
  });
}

export interface PlannedRow extends PlannedRun {
  taskName: string;
  robotName: string;
  siteName: string;
  runResult: string | null;
}

export async function listPlannedRuns(user: User, opts: { siteId?: string; fromIso: string; toIso: string }): Promise<PlannedRow[]> {
  assertActive(user);
  const db = getDb();
  const siteIds = await accessibleSiteIds(user, db);
  if (opts.siteId) await assertSiteAccess(user, opts.siteId, db);
  const ids = opts.siteId ? [opts.siteId] : siteIds;
  if (ids.length === 0) return [];
  const rows = await db
    .select({ p: schema.plannedRuns, taskName: schema.registeredTasks.name, robotName: schema.robots.name, siteName: schema.sites.name, runResult: schema.actualRuns.result })
    .from(schema.plannedRuns)
    .leftJoin(schema.registeredTasks, eq(schema.registeredTasks.id, schema.plannedRuns.taskId))
    .leftJoin(schema.robots, eq(schema.robots.id, schema.plannedRuns.robotId))
    .leftJoin(schema.sites, eq(schema.sites.id, schema.plannedRuns.siteId))
    .leftJoin(schema.actualRuns, eq(schema.actualRuns.id, schema.plannedRuns.actualRunId))
    .where(and(inArray(schema.plannedRuns.siteId, ids), gte(schema.plannedRuns.plannedAt, opts.fromIso), lte(schema.plannedRuns.plannedAt, opts.toIso)))
    .orderBy(asc(schema.plannedRuns.plannedAt));
  return rows.map((r) => ({ ...r.p, taskName: r.taskName ?? r.p.taskId, robotName: r.robotName ?? r.p.robotId, siteName: r.siteName ?? r.p.siteId, runResult: r.runResult ?? null }));
}

function assertStaff(user: User, what: string) {
  if (isCustomer(user)) throw new ForbiddenError(`${what}은(는) 현장/본사 담당자만 할 수 있습니다.`);
}

export async function cancelPlannedRun(user: User, plannedId: string, reason: string): Promise<void> {
  const db = getDb();
  assertActive(user);
  assertStaff(user, "예정 작업 취소");
  const p = await db.query.plannedRuns.findFirst({ where: eq(schema.plannedRuns.id, plannedId) });
  if (!p) throw new NotFoundError();
  await assertSiteAccess(user, p.siteId, db);
  if (p.status !== "PLANNED") throw new ValidationError("예정 상태의 회차만 취소할 수 있습니다.");
  if (!reason.trim()) throw new ValidationError("취소 사유를 입력하세요.");
  const history = [...p.changeHistory, { at: nowIso(), by: user.id, from: p.status, to: "CANCELLED" as const, reason: reason.trim() }];
  await db.update(schema.plannedRuns).set({ status: "CANCELLED", reason: reason.trim(), changeHistory: history }).where(eq(schema.plannedRuns.id, plannedId));
  await audit(user, { siteId: p.siteId, robotId: p.robotId, action: "PLANNED_RUN:CANCEL", params: { plannedId, reason }, result: "OK", detail: null, vendorTraceId: null }, db);
}

export async function toggleSchedule(user: User, scheduleId: string, enabled: boolean): Promise<void> {
  const db = getDb();
  assertActive(user);
  assertStaff(user, "예약 변경");
  const s = await db.query.schedules.findFirst({ where: eq(schema.schedules.id, scheduleId) });
  if (!s) throw new NotFoundError();
  const task = (await db.query.registeredTasks.findFirst({ where: eq(schema.registeredTasks.id, s.taskId) }))!;
  await assertSiteAccess(user, task.siteId, db);
  // 실제 PUDU 예약은 PUDU 가 실행 주체다 — 여기서 켜고 꺼도 로봇에 반영되지 않고 다음 동기화에 되돌아간다
  if (s.id.startsWith("sch-pudu-")) throw new ValidationError("PUDU 예약은 PUDU 앱에서 바꾸세요(이 시스템은 읽기 전용으로 동기화합니다).");
  await db.update(schema.schedules).set({ enabled }).where(eq(schema.schedules.id, scheduleId));
  await audit(user, { siteId: task.siteId, robotId: task.robotId, action: "SCHEDULE:TOGGLE", params: { scheduleId, enabled, executor: s.executor }, result: "OK", detail: s.executor === "VENDOR" ? "제조사 예약 변경은 3단계에서 API 로 반영(현재 샘플)" : null, vendorTraceId: null }, db);
}

export async function createTask(user: User, input: { robotId: string; name: string; zoneIds: string[]; mode: CleanMode }): Promise<RegisteredTask> {
  const db = getDb();
  const robot = await assertRobotAccess(user, input.robotId, db);
  assertStaff(user, "작업 등록");
  if (!input.name.trim()) throw new ValidationError("작업 이름을 입력하세요.");
  if (input.zoneIds.length === 0) throw new ValidationError("구역을 하나 이상 선택하세요.");
  const floorZones = await listZonesByFloor(robot.floorId, db);
  for (const z of input.zoneIds) {
    if (!floorZones.some((x) => x.id === z)) throw new ValidationError("로봇이 배치된 층의 구역만 선택할 수 있습니다.");
  }
  if (robot.model === "L4" && input.mode !== "SWEEP") throw new ValidationError("L 시리즈는 SWEEP 모드만 가능합니다.");
  const task: RegisteredTask = { id: newId("task"), siteId: robot.siteId, robotId: robot.id, name: input.name.trim(), zoneIds: input.zoneIds, mode: input.mode, vendorTaskRef: null };
  await db.insert(schema.registeredTasks).values(task);
  await audit(user, { siteId: robot.siteId, robotId: robot.id, action: "TASK:CREATE", params: { name: task.name, zoneIds: task.zoneIds, mode: task.mode }, result: "OK", detail: "샘플 — 제조사 등록(Favorite 등)은 3단계", vendorTraceId: null }, db);
  return task;
}

export async function createSchedule(user: User, input: { taskId: string; daysOfWeek: number[]; time: string }): Promise<Schedule> {
  const db = getDb();
  assertActive(user);
  assertStaff(user, "예약 등록");
  const task = await db.query.registeredTasks.findFirst({ where: eq(schema.registeredTasks.id, input.taskId) });
  if (!task) throw new NotFoundError();
  await assertSiteAccess(user, task.siteId, db);
  if (!/^\d{2}:\d{2}$/.test(input.time)) throw new ValidationError("시각은 HH:mm 형식입니다.");
  if (input.daysOfWeek.length === 0) throw new ValidationError("요일을 선택하세요.");
  const robot = (await getRobot(task.robotId, db))!;
  // 단일 실행 주체: 같은 로봇의 기존 예약과 같은 실행 주체를 쓴다.
  const robotTasks = await db.select({ id: schema.registeredTasks.id }).from(schema.registeredTasks).where(eq(schema.registeredTasks.robotId, robot.id));
  const existing = await db.select().from(schema.schedules).where(inArray(schema.schedules.taskId, robotTasks.map((t) => t.id)));
  const executor = existing[0]?.executor ?? (robot.vendor === "CENOBOTS" ? "VENDOR" : "SELF");
  const dup = existing.find((s) => s.taskId === task.id && s.time === input.time && s.daysOfWeek.some((d) => input.daysOfWeek.includes(d)));
  if (dup) throw new ValidationError("같은 시각·요일의 예약이 이미 있습니다(중복 실행 방지).");
  const s: Schedule = { id: newId("sch"), taskId: task.id, daysOfWeek: input.daysOfWeek, time: input.time, enabled: true, executor };
  await db.insert(schema.schedules).values(s);
  await audit(user, { siteId: task.siteId, robotId: task.robotId, action: "SCHEDULE:CREATE", params: { taskId: task.id, time: s.time, daysOfWeek: s.daysOfWeek, executor }, result: "OK", detail: null, vendorTraceId: null }, db);
  return s;
}
