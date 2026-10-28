import { and, desc, eq, gt, inArray, notInArray } from "drizzle-orm";
import type { Command, CommandType, User } from "@/lib/domain/types";
import { ALLOWED_BY_STATUS } from "@/lib/domain/commands";
import { accessibleSiteIds, assertActive, assertCommandAllowed, assertRobotAccess, assertSiteAccess, isCustomer } from "@/lib/auth/authz";
import { getDb, schema } from "@/lib/db/client";
import { getFloor, getMapVersion, getRobot, getStatus, listSitesByIds, listUsers, listZonesByFloor, loadSettings, type DbLike } from "@/lib/db/repo";
import { getAdapter } from "@/lib/vendors";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/util/errors";
import { newId } from "@/lib/util/random";
import { addMinutes, nowIso } from "@/lib/util/time";
import { audit } from "./audit";

export interface IssueCommandInput {
  robotId: string;
  type: CommandType;
  params?: Record<string, unknown>;
  /** 샘플 시뮬레이션 시나리오. 실제 어댑터에서는 무시된다. */
  simulation?: "NORMAL" | "LOST_RESPONSE" | "REJECTED";
  /** 같은 버튼 중복 클릭 방지용 클라이언트 키(선택). */
  idempotencyKey?: string;
}

const PENDING: Command["state"][] = ["REQUESTED", "ACCEPTED", "EXECUTING"];

/**
 * 영역 청소 명령 검증: 지도 버전 일치, 모서리 좌표 존재, 다각형이 지도 범위 안, L 시리즈는 SWEEP 만.
 * 하나라도 어긋나면 전송하지 않는다.
 */
export async function validateAreaParams(robotId: string, params: Record<string, unknown>, db: DbLike = getDb()): Promise<{ zoneIds: string[]; polygon: [number, number][] | null; mapVersionId: string }> {
  const robot = await getRobot(robotId, db);
  if (!robot) throw new NotFoundError();
  const floor = (await getFloor(robot.floorId, db))!;
  const map = (await getMapVersion(floor.currentMapVersionId, db))!;
  const status = await getStatus(robot.id, db);
  const mapVersionId = String(params.mapVersionId ?? "");
  if (mapVersionId !== map.id) throw new ValidationError("요청한 지도 버전이 현재 지도 버전과 다릅니다. 지도를 새로 고친 뒤 다시 지정하세요.");
  if (status?.mapVersionId && status.mapVersionId !== map.id) throw new ValidationError("로봇이 보고한 지도 버전이 현재 지도와 다릅니다(지도 버전 불일치). 로봇 지도 동기화 후 가능합니다.");
  if (!map.corners) throw new ValidationError("이 지도는 모서리 좌표가 없어(구형 지도) 좌표 변환을 검증할 수 없습니다. 영역 명령을 차단합니다.");
  const mode = String(params.mode ?? "SWEEP");
  if (robot.model === "L4" && mode !== "SWEEP") throw new ValidationError("L 시리즈 임시 작업은 SWEEP 모드만 가능합니다.");
  const zoneIds = Array.isArray(params.zoneIds) ? (params.zoneIds as string[]) : [];
  const polygon = Array.isArray(params.polygon) ? (params.polygon as [number, number][]) : null;
  if (zoneIds.length === 0 && (!polygon || polygon.length < 3)) throw new ValidationError("구역을 선택하거나 사용자 정의 영역(점 3개 이상)을 지정하세요.");
  const floorZones = await listZonesByFloor(floor.id, db);
  for (const z of zoneIds) {
    if (!floorZones.some((x) => x.id === z)) throw new ValidationError("다른 층/사업장의 구역은 지정할 수 없습니다.");
  }
  if (polygon) {
    for (const [x, y] of polygon) {
      if (!(x >= 0 && x <= map.widthPx && y >= 0 && y <= map.heightPx)) throw new ValidationError("사용자 정의 영역이 지도 범위를 벗어났습니다.");
    }
  }
  return { zoneIds, polygon, mapVersionId };
}

export async function issueCommand(user: User, input: IssueCommandInput): Promise<Command> {
  const db = getDb();
  const robot = await assertRobotAccess(user, input.robotId, db);
  const type = input.type;
  const now = nowIso();
  const settings = await loadSettings(db);

  // 1) 권한(역할·사업장·명령별) — 거부도 감사 기록에 남긴다.
  try {
    await assertCommandAllowed(user, robot.siteId, type, db);
  } catch (e) {
    await audit(user, { siteId: robot.siteId, robotId: robot.id, action: `COMMAND:${type}`, params: input.params ?? {}, result: "DENIED", detail: (e as Error).message, vendorTraceId: null }, db);
    throw e;
  }

  // 2) 로봇 지원 여부 · 상태 전이 규칙
  if (!robot.supportedCommands.includes(type)) throw new ValidationError("이 로봇(모델)은 해당 명령을 지원하지 않습니다.");
  const status = await getStatus(robot.id, db);
  const common = status?.common ?? "UNKNOWN";
  if (!ALLOWED_BY_STATUS[common]?.includes(type)) {
    throw new ValidationError(`현재 상태(${common})에서는 '${type}' 명령을 보낼 수 없습니다.`);
  }

  // 3) 중복 클릭 · 동시 명령 충돌 방지 (선 조작 우선: 처리 중 명령이 있으면 역할과 무관하게 거부)
  if (input.idempotencyKey) {
    const dup = await db.query.commands.findFirst({ where: eq(schema.commands.idempotencyKey, input.idempotencyKey) });
    if (dup) throw new ConflictError("같은 요청이 이미 처리되었습니다(중복 클릭).");
  }
  const pending = await db.query.commands.findFirst({
    where: and(eq(schema.commands.robotId, robot.id), inArray(schema.commands.state, PENDING), notInArray(schema.commands.type, ["START_TASK", "RESUME", "AREA_CLEAN"]), gt(schema.commands.expiresAt, now)),
  });
  if (pending) {
    const who = (await listUsers(db)).find((u) => u.id === pending.userId)?.name ?? pending.userId;
    throw new ConflictError(`${who} 의 '${pending.type}' 명령이 처리 중입니다. 결과 확인 후 다시 시도하세요.`);
  }

  // 4) 명령별 파라미터 검증
  const params: Record<string, unknown> = { ...(input.params ?? {}) };
  if (type === "START_TASK") {
    const task = await db.query.registeredTasks.findFirst({ where: and(eq(schema.registeredTasks.id, String(params.taskId ?? "")), eq(schema.registeredTasks.robotId, robot.id)) });
    if (!task) throw new ValidationError("이 로봇에 등록된 작업만 실행할 수 있습니다.");
  }
  if (type === "AREA_CLEAN") {
    const v = await validateAreaParams(robot.id, params, db);
    params.zoneIds = v.zoneIds;
    params.polygon = v.polygon;
  }

  // 5) 명령 기록(요청) → 어댑터 전송 → 접수/거부/결과불명
  const adapter = getAdapter(robot);
  const cmd: Command = {
    id: newId("cmd"),
    userId: user.id,
    siteId: robot.siteId,
    robotId: robot.id,
    type,
    params,
    requestedAt: now,
    expiresAt: addMinutes(now, settings.commandExpiryMinutes),
    state: "REQUESTED",
    stateChangedAt: now,
    message: null,
    vendorTraceId: null,
    simulation: adapter.isSimulation ? (input.simulation ?? "NORMAL") : null,
  };
  try {
    await db.insert(schema.commands).values({ ...cmd, idempotencyKey: input.idempotencyKey ?? null });
  } catch (e) {
    // 동시 요청이 멱등 키 유일 제약에 걸린 경우
    if (String((e as Error).message).includes("commands_idempotency_key")) throw new ConflictError("같은 요청이 이미 처리되었습니다(중복 클릭).");
    throw e;
  }

  let result: "OK" | "ERROR" = "OK";
  try {
    const res = await adapter.sendCommand(robot, cmd);
    cmd.vendorTraceId = res.vendorTraceId;
    cmd.stateChangedAt = nowIso();
    if (res.outcome === "ACCEPTED") {
      cmd.state = "ACCEPTED";
      cmd.message = `${res.message ?? "접수"} — 실행 확인 전(HTTP 접수만 완료)`;
    } else if (res.outcome === "REJECTED") {
      cmd.state = "FAILED";
      cmd.message = res.message ?? "제조사 거부";
      result = "ERROR";
    } else {
      cmd.state = "UNKNOWN";
      cmd.message = `${res.message ?? "응답 유실"} — 로봇 상태/작업 이력 확인 후 재시도 판단`;
      result = "ERROR";
    }
  } catch (e) {
    cmd.state = "UNKNOWN";
    cmd.stateChangedAt = nowIso();
    cmd.message = `전송 중 오류: ${(e as Error).message} — 결과 불명`;
    result = "ERROR";
  }
  await db.update(schema.commands).set({ state: cmd.state, stateChangedAt: cmd.stateChangedAt, message: cmd.message, vendorTraceId: cmd.vendorTraceId }).where(eq(schema.commands.id, cmd.id));
  await audit(user, { siteId: robot.siteId, robotId: robot.id, action: `COMMAND:${type}`, params, result, detail: cmd.message, vendorTraceId: cmd.vendorTraceId }, db);
  return cmd;
}

/** 결과 불명 명령의 재시도 판단: 만료되었으면 재전송하지 않고 새 명령으로만 가능. */
export function canRetry(cmd: Command, now: string = nowIso()): { ok: boolean; reason: string } {
  if (cmd.state !== "UNKNOWN" && cmd.state !== "FAILED") return { ok: false, reason: "재시도 대상 상태가 아닙니다." };
  if (cmd.expiresAt <= now) return { ok: false, reason: "만료된 명령은 재전송하지 않습니다. 현재 로봇 상태를 확인하고 새 명령을 내리세요." };
  return { ok: true, reason: "로봇 상태·작업 이력을 확인한 뒤 재시도할 수 있습니다." };
}

export interface CommandRow extends Command {
  userName: string;
  robotName: string;
  siteName: string;
}

export async function listCommands(user: User, opts: { siteId?: string; robotId?: string; limit?: number } = {}): Promise<CommandRow[]> {
  assertActive(user);
  const db = getDb();
  const siteIds = await accessibleSiteIds(user, db);
  if (opts.siteId) await assertSiteAccess(user, opts.siteId, db);
  const ids = opts.siteId ? [opts.siteId] : siteIds;
  if (ids.length === 0) return [];
  const customer = isCustomer(user);
  const rows = await db
    .select()
    .from(schema.commands)
    .where(and(inArray(schema.commands.siteId, ids), opts.robotId ? eq(schema.commands.robotId, opts.robotId) : undefined, customer ? eq(schema.commands.userId, user.id) : undefined))
    .orderBy(desc(schema.commands.requestedAt))
    .limit(opts.limit ?? 50);
  const users = new Map((await listUsers(db)).map((u) => [u.id, u.name]));
  const robotIds = Array.from(new Set(rows.map((r) => r.robotId)));
  const robots = robotIds.length ? new Map((await db.select({ id: schema.robots.id, name: schema.robots.name }).from(schema.robots).where(inArray(schema.robots.id, robotIds))).map((r) => [r.id, r.name])) : new Map<string, string>();
  const sites = new Map((await listSitesByIds(ids, db)).map((s) => [s.id, s.name]));
  return rows.map(({ idempotencyKey: _k, ...c }) => ({ ...c, userName: users.get(c.userId) ?? c.userId, robotName: robots.get(c.robotId) ?? c.robotId, siteName: sites.get(c.siteId) ?? c.siteId }));
}
