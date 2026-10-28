import type { CleanMode, PlannedRun, RegisteredTask, Schedule, User } from "@/lib/domain/types";
import { accessibleSiteIds, assertActive, assertRobotAccess, assertSiteAccess, isCustomer } from "@/lib/auth/authz";
import { getStore } from "@/lib/store/store";
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

export function listTasks(user: User, siteId?: string): TaskRow[] {
  assertActive(user);
  const data = getStore();
  const siteIds = accessibleSiteIds(data, user);
  if (siteId) assertSiteAccess(data, user, siteId);
  return data.tasks
    .filter((t) => siteIds.includes(t.siteId) && (!siteId || t.siteId === siteId))
    .map((t) => {
      const robot = data.robots.find((r) => r.id === t.robotId);
      return {
        task: t,
        schedules: data.schedules.filter((s) => s.taskId === t.id),
        robotName: robot?.name ?? t.robotId,
        siteName: data.sites.find((s) => s.id === t.siteId)?.name ?? t.siteId,
        zoneNames: t.zoneIds.map((z) => data.zones.find((x) => x.id === z)?.name ?? z),
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

export function listPlannedRuns(user: User, opts: { siteId?: string; fromIso: string; toIso: string }): PlannedRow[] {
  assertActive(user);
  const data = getStore();
  const siteIds = accessibleSiteIds(data, user);
  if (opts.siteId) assertSiteAccess(data, user, opts.siteId);
  return data.plannedRuns
    .filter((p) => siteIds.includes(p.siteId) && (!opts.siteId || p.siteId === opts.siteId) && p.plannedAt >= opts.fromIso && p.plannedAt <= opts.toIso)
    .sort((a, b) => a.plannedAt.localeCompare(b.plannedAt))
    .map((p) => ({
      ...p,
      taskName: data.tasks.find((t) => t.id === p.taskId)?.name ?? p.taskId,
      robotName: data.robots.find((r) => r.id === p.robotId)?.name ?? p.robotId,
      siteName: data.sites.find((s) => s.id === p.siteId)?.name ?? p.siteId,
      runResult: p.actualRunId ? (data.actualRuns.find((r) => r.id === p.actualRunId)?.result ?? null) : null,
    }));
}

function assertStaff(user: User, what: string) {
  if (isCustomer(user)) throw new ForbiddenError(`${what}은(는) 현장/본사 담당자만 할 수 있습니다.`);
}

export function cancelPlannedRun(user: User, plannedId: string, reason: string): PlannedRun {
  const data = getStore();
  assertActive(user);
  assertStaff(user, "예정 작업 취소");
  const p = data.plannedRuns.find((x) => x.id === plannedId);
  if (!p) throw new NotFoundError();
  assertSiteAccess(data, user, p.siteId);
  if (p.status !== "PLANNED") throw new ValidationError("예정 상태의 회차만 취소할 수 있습니다.");
  if (!reason.trim()) throw new ValidationError("취소 사유를 입력하세요.");
  p.changeHistory.push({ at: nowIso(), by: user.id, from: p.status, to: "CANCELLED", reason: reason.trim() });
  p.status = "CANCELLED";
  p.reason = reason.trim();
  audit(data, user, { siteId: p.siteId, robotId: p.robotId, action: "PLANNED_RUN:CANCEL", params: { plannedId, reason }, result: "OK", detail: null, vendorTraceId: null });
  return p;
}

export function toggleSchedule(user: User, scheduleId: string, enabled: boolean): Schedule {
  const data = getStore();
  assertActive(user);
  assertStaff(user, "예약 변경");
  const s = data.schedules.find((x) => x.id === scheduleId);
  if (!s) throw new NotFoundError();
  const task = data.tasks.find((t) => t.id === s.taskId)!;
  assertSiteAccess(data, user, task.siteId);
  s.enabled = enabled;
  audit(data, user, { siteId: task.siteId, robotId: task.robotId, action: "SCHEDULE:TOGGLE", params: { scheduleId, enabled, executor: s.executor }, result: "OK", detail: s.executor === "VENDOR" ? "제조사 예약 변경은 3단계에서 API 로 반영(현재 샘플)" : null, vendorTraceId: null });
  return s;
}

export function createTask(user: User, input: { robotId: string; name: string; zoneIds: string[]; mode: CleanMode }): RegisteredTask {
  const data = getStore();
  const robot = assertRobotAccess(data, user, input.robotId);
  assertStaff(user, "작업 등록");
  if (!input.name.trim()) throw new ValidationError("작업 이름을 입력하세요.");
  if (input.zoneIds.length === 0) throw new ValidationError("구역을 하나 이상 선택하세요.");
  for (const z of input.zoneIds) {
    const zone = data.zones.find((x) => x.id === z);
    if (!zone || zone.floorId !== robot.floorId) throw new ValidationError("로봇이 배치된 층의 구역만 선택할 수 있습니다.");
  }
  if (robot.model === "L4" && input.mode !== "SWEEP") throw new ValidationError("L 시리즈는 SWEEP 모드만 가능합니다.");
  const task: RegisteredTask = { id: newId("task"), siteId: robot.siteId, robotId: robot.id, name: input.name.trim(), zoneIds: input.zoneIds, mode: input.mode, vendorTaskRef: null };
  data.tasks.push(task);
  audit(data, user, { siteId: robot.siteId, robotId: robot.id, action: "TASK:CREATE", params: { name: task.name, zoneIds: task.zoneIds, mode: task.mode }, result: "OK", detail: "샘플 — 제조사 등록(Favorite 등)은 3단계", vendorTraceId: null });
  return task;
}

export function createSchedule(user: User, input: { taskId: string; daysOfWeek: number[]; time: string }): Schedule {
  const data = getStore();
  assertActive(user);
  assertStaff(user, "예약 등록");
  const task = data.tasks.find((t) => t.id === input.taskId);
  if (!task) throw new NotFoundError();
  assertSiteAccess(data, user, task.siteId);
  if (!/^\d{2}:\d{2}$/.test(input.time)) throw new ValidationError("시각은 HH:mm 형식입니다.");
  if (input.daysOfWeek.length === 0) throw new ValidationError("요일을 선택하세요.");
  const robot = data.robots.find((r) => r.id === task.robotId)!;
  // 단일 실행 주체: 같은 로봇의 기존 예약과 같은 실행 주체를 쓴다.
  const executor = data.schedules.find((s) => data.tasks.find((t) => t.id === s.taskId)?.robotId === robot.id)?.executor ?? (robot.vendor === "CENOBOTS" ? "VENDOR" : "SELF");
  const dup = data.schedules.find((s) => s.taskId === task.id && s.time === input.time && s.daysOfWeek.some((d) => input.daysOfWeek.includes(d)));
  if (dup) throw new ValidationError("같은 시각·요일의 예약이 이미 있습니다(중복 실행 방지).");
  const s: Schedule = { id: newId("sch"), taskId: task.id, daysOfWeek: input.daysOfWeek, time: input.time, enabled: true, executor };
  data.schedules.push(s);
  audit(data, user, { siteId: task.siteId, robotId: task.robotId, action: "SCHEDULE:CREATE", params: { taskId: task.id, time: s.time, daysOfWeek: s.daysOfWeek, executor }, result: "OK", detail: null, vendorTraceId: null });
  return s;
}
