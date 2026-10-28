import type { Command, CommandType, User } from "@/lib/domain/types";
import { ALLOWED_BY_STATUS } from "@/lib/domain/commands";
import { accessibleSiteIds, assertActive, assertCommandAllowed, assertRobotAccess, isCustomer } from "@/lib/auth/authz";
import { getStore } from "@/lib/store/store";
import { getAdapter } from "@/lib/vendors";
import { ConflictError, ValidationError } from "@/lib/util/errors";
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

/** 점이 다각형 내부에 있는지(ray casting). */
function pointInPolygon(p: [number, number], poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect = yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * 영역 청소 명령 검증: 지도 버전 일치, 모서리 좌표 존재, 다각형이 지도 범위 안, L 시리즈는 SWEEP 만.
 * 하나라도 어긋나면 전송하지 않는다.
 */
export function validateAreaParams(robotId: string, params: Record<string, unknown>): { zoneIds: string[]; polygon: [number, number][] | null; mapVersionId: string } {
  const data = getStore();
  const robot = data.robots.find((r) => r.id === robotId)!;
  const floor = data.floors.find((f) => f.id === robot.floorId)!;
  const map = data.mapVersions.find((m) => m.id === floor.currentMapVersionId)!;
  const status = data.statuses[robot.id];
  const mapVersionId = String(params.mapVersionId ?? "");
  if (mapVersionId !== map.id) throw new ValidationError("요청한 지도 버전이 현재 지도 버전과 다릅니다. 지도를 새로 고친 뒤 다시 지정하세요.");
  if (status.mapVersionId && status.mapVersionId !== map.id) throw new ValidationError("로봇이 보고한 지도 버전이 현재 지도와 다릅니다(지도 버전 불일치). 로봇 지도 동기화 후 가능합니다.");
  if (!map.corners) throw new ValidationError("이 지도는 모서리 좌표가 없어(구형 지도) 좌표 변환을 검증할 수 없습니다. 영역 명령을 차단합니다.");
  const mode = String(params.mode ?? "SWEEP");
  if (robot.model === "L4" && mode !== "SWEEP") throw new ValidationError("L 시리즈 임시 작업은 SWEEP 모드만 가능합니다.");
  const zoneIds = Array.isArray(params.zoneIds) ? (params.zoneIds as string[]) : [];
  const polygon = Array.isArray(params.polygon) ? (params.polygon as [number, number][]) : null;
  if (zoneIds.length === 0 && (!polygon || polygon.length < 3)) throw new ValidationError("구역을 선택하거나 사용자 정의 영역(점 3개 이상)을 지정하세요.");
  for (const z of zoneIds) {
    const zone = data.zones.find((x) => x.id === z);
    if (!zone || zone.floorId !== floor.id) throw new ValidationError("다른 층/사업장의 구역은 지정할 수 없습니다.");
  }
  if (polygon) {
    for (const [x, y] of polygon) {
      if (!(x >= 0 && x <= map.widthPx && y >= 0 && y <= map.heightPx)) throw new ValidationError("사용자 정의 영역이 지도 범위를 벗어났습니다.");
    }
    if (status.pose && !status.poseIsLastKnown) {
      // 참고 정보: 로봇이 영역 밖에 있어도 명령은 가능하나, 화면에 알린다.
      void pointInPolygon([status.pose.x, status.pose.y], polygon);
    }
  }
  return { zoneIds, polygon, mapVersionId };
}

export async function issueCommand(user: User, input: IssueCommandInput): Promise<Command> {
  const data = getStore();
  const robot = assertRobotAccess(data, user, input.robotId);
  const type = input.type;
  const now = nowIso();

  // 1) 권한(역할·사업장·명령별)
  try {
    assertCommandAllowed(data, user, robot.siteId, type);
  } catch (e) {
    audit(data, user, { siteId: robot.siteId, robotId: robot.id, action: `COMMAND:${type}`, params: input.params ?? {}, result: "DENIED", detail: (e as Error).message, vendorTraceId: null });
    throw e;
  }

  // 2) 로봇 지원 여부 · 상태 전이 규칙
  if (!robot.supportedCommands.includes(type)) throw new ValidationError("이 로봇(모델)은 해당 명령을 지원하지 않습니다.");
  const status = data.statuses[robot.id];
  if (!ALLOWED_BY_STATUS[status.common]?.includes(type)) {
    throw new ValidationError(`현재 상태(${status.common})에서는 '${type}' 명령을 보낼 수 없습니다.`);
  }

  // 3) 중복 클릭 · 동시 명령 충돌 방지
  if (input.idempotencyKey && data.commands.some((c) => c.params.idempotencyKey === input.idempotencyKey)) {
    throw new ConflictError("같은 요청이 이미 처리되었습니다(중복 클릭).");
  }
  const pending = data.commands.find((c) => c.robotId === robot.id && PENDING.includes(c.state) && !(c.type === "START_TASK" || c.type === "AREA_CLEAN") && c.expiresAt > now);
  if (pending) {
    const who = data.users.find((u) => u.id === pending.userId)?.name ?? pending.userId;
    throw new ConflictError(`${who} 의 '${pending.type}' 명령이 처리 중입니다. 결과 확인 후 다시 시도하세요.`);
  }

  // 4) 명령별 파라미터 검증
  const params: Record<string, unknown> = { ...(input.params ?? {}) };
  if (input.idempotencyKey) params.idempotencyKey = input.idempotencyKey;
  if (type === "START_TASK") {
    const task = data.tasks.find((t) => t.id === params.taskId && t.robotId === robot.id);
    if (!task) throw new ValidationError("이 로봇에 등록된 작업만 실행할 수 있습니다.");
  }
  if (type === "AREA_CLEAN") {
    const v = validateAreaParams(robot.id, params);
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
    expiresAt: addMinutes(now, data.settings.commandExpiryMinutes),
    state: "REQUESTED",
    stateChangedAt: now,
    message: null,
    vendorTraceId: null,
    simulation: adapter.isSimulation ? (input.simulation ?? "NORMAL") : null,
  };
  data.commands.unshift(cmd);

  let result: "OK" | "ERROR" = "OK";
  try {
    const res = await adapter.sendCommand(robot, cmd);
    cmd.vendorTraceId = res.vendorTraceId;
    const at = nowIso();
    cmd.stateChangedAt = at;
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
  audit(data, user, { siteId: robot.siteId, robotId: robot.id, action: `COMMAND:${type}`, params, result, detail: cmd.message, vendorTraceId: cmd.vendorTraceId });
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

export function listCommands(user: User, opts: { siteId?: string; robotId?: string; limit?: number } = {}): CommandRow[] {
  assertActive(user);
  const data = getStore();
  const siteIds = accessibleSiteIds(data, user);
  const customer = isCustomer(user);
  return data.commands
    .filter((c) => siteIds.includes(c.siteId) && (!opts.siteId || c.siteId === opts.siteId) && (!opts.robotId || c.robotId === opts.robotId))
    // 고객은 본인이 내린 명령만 본다.
    .filter((c) => !customer || c.userId === user.id)
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
    .slice(0, opts.limit ?? 50)
    .map((c) => ({
      ...c,
      userName: data.users.find((u) => u.id === c.userId)?.name ?? c.userId,
      robotName: data.robots.find((r) => r.id === c.robotId)?.name ?? c.robotId,
      siteName: data.sites.find((s) => s.id === c.siteId)?.name ?? c.siteId,
    }));
}
