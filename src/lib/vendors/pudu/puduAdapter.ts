import { eq } from "drizzle-orm";
import type { ActualRun, Command, MaintenanceItem, Robot, RobotStatus } from "@/lib/domain/types";
import type { SendResult, VendorAdapter } from "@/lib/vendors/adapter";
import { AppError } from "@/lib/util/errors";
import { getDb, schema } from "@/lib/db/client";
import { getStatus } from "@/lib/db/repo";
import { nowIso } from "@/lib/util/time";
import { type PuduCleanDetail, PuduApi } from "./api";
import { configFromEnv, PuduApiError, PuduClient } from "./client";
import { buildExecBodies, mapDetail, mapReportToRun } from "./mapping";

/**
 * PUDU Cloud API 어댑터(실제 연동). 문서 근거: docs/06-PUDU-API-검토.md
 * - sendCommand: CleanCommands(task/exec). HTTP SUCCESS 는 "접수"일 뿐이며 실행 확인은 워커의 상세 조회/콜백이 한다.
 * - fetchStatus: robot/detail + status V2 를 공통 상태로 매핑.
 * - fetchRuns: 청소 보고서 목록(최대 20건/페이지, 통계 API 지연 약 10분).
 * - fetchMaintenance: 소모품 목록.
 * 키·클러스터는 환경변수에서만 읽는다. 미설정이면 UNSUPPORTED 오류.
 */
export function createPuduApi(): PuduApi {
  const cfg = configFromEnv();
  if (!cfg) throw new AppError("PUDU 연결이 설정되지 않았습니다(PUDU_API_APP_KEY / PUDU_API_APP_SECRET / PUDU_API_CLUSTER).", "UNSUPPORTED");
  return new PuduApi(new PuduClient(cfg));
}

export function tzOffsetHours(tz: string): number {
  // 시제품 범위: Asia/Seoul 고정 운영. 다른 시간대는 추후 라이브러리로 계산.
  return tz === "Asia/Seoul" ? 9 : 0;
}

export class PuduAdapter implements VendorAdapter {
  readonly vendor = "PUDU" as const;
  readonly isSimulation = false;
  private readonly api: PuduApi;

  constructor(api?: PuduApi) {
    this.api = api ?? createPuduApi();
  }

  async sendCommand(robot: Robot, command: Command): Promise<SendResult> {
    const sn = robot.vendorRobotId;
    const status = await getStatus(robot.id);
    let task: { vendorTaskId: string; version: number; name?: string } | null = null;
    if (command.type === "START_TASK") {
      const t = await getDb().query.registeredTasks.findFirst({ where: eq(schema.registeredTasks.id, String(command.params.taskId ?? "")) });
      if (!t?.vendorTaskRef) return { outcome: "REJECTED", vendorTraceId: null, message: "이 등록 작업에는 PUDU task_id/version 이 없습니다. 먼저 '등록 작업 동기화'를 실행하세요." };
      const [vendorTaskId, version] = t.vendorTaskRef.split("@");
      task = { vendorTaskId, version: Number(version || 0), name: t.name };
    } else if (command.type === "AREA_CLEAN") {
      return { outcome: "REJECTED", vendorTraceId: null, message: "PUDU 는 'AREA_CLEAN' 명령을 지원하지 않습니다(임시 영역 청소 API 없음)." };
    } else {
      // 일시정지·재개·중단·복귀도 작업 정보가 필요하다(실기 확인). 진행 중 작업 → 없으면 마지막 작업(등록 작업에서 version 보강) 순으로 찾는다.
      task = await this.resolveCurrentTask(robot);
      if (!task) return { outcome: "REJECTED", vendorTraceId: null, message: "로봇의 현재/마지막 작업 정보를 찾지 못해 명령을 보낼 수 없습니다('작업·예약·소모품 동기화' 후 다시 시도)." };
    }
    const bodies = buildExecBodies(command.type, sn, task, status?.common ?? "UNKNOWN");
    if (!bodies) return { outcome: "REJECTED", vendorTraceId: null, message: `PUDU 는 '${command.type}' 명령을 지원하지 않습니다.` };
    let lastTrace: string | null = null;
    try {
      for (const body of bodies) {
        const res = await this.api.execTask(body);
        lastTrace = res.traceId ?? lastTrace;
      }
      return { outcome: "ACCEPTED", vendorTraceId: lastTrace, message: `PUDU 접수(type ${bodies.map((b) => `${b.type}/${b.clean.status}`).join(" → ")})` };
    } catch (e) {
      if (e instanceof PuduApiError) {
        // 게이트웨이/업무 오류 응답이 있으면 '거부', 응답 자체가 없으면 '결과 불명'
        return e.status === 0 ? { outcome: "TIMEOUT", vendorTraceId: e.traceId, message: e.message } : { outcome: "REJECTED", vendorTraceId: e.traceId, message: e.message };
      }
      return { outcome: "TIMEOUT", vendorTraceId: lastTrace, message: `응답 유실: ${(e as Error).message}` };
    }
  }

  /** 명령 본문에 넣을 작업: 상세의 진행 중 작업(task_id+version) → 마지막 작업(last_task)에 등록 작업의 version 을 붙임. */
  private async resolveCurrentTask(robot: Robot): Promise<{ vendorTaskId: string; version: number; name?: string } | null> {
    let detail: PuduCleanDetail | null = null;
    try {
      detail = await this.api.cleanDetail(robot.vendorRobotId);
    } catch {
      detail = null;
    }
    const running = detail?.cleanbot?.clean?.task;
    if (running?.task_id && running.version) return { vendorTaskId: String(running.task_id), version: Number(running.version), name: running.name };
    const lastId = running?.task_id ? String(running.task_id) : (detail?.cleanbot?.last_task ?? (robot.vendorMeta?.lastTask as string | undefined));
    const tasks = await getDb().select().from(schema.registeredTasks).where(eq(schema.registeredTasks.robotId, robot.id));
    const pick = (lastId && tasks.find((t) => t.vendorTaskRef?.startsWith(`${lastId}@`))) || null;
    if (pick?.vendorTaskRef) {
      const [vendorTaskId, version] = pick.vendorTaskRef.split("@");
      return { vendorTaskId, version: Number(version || 0), name: pick.name };
    }
    return null;
  }

  async fetchStatus(robot: Robot): Promise<RobotStatus | null> {
    const receivedAt = nowIso();
    const detail = await this.api.cleanDetail(robot.vendorRobotId);
    let v2 = null;
    try {
      v2 = await this.api.statusV2(robot.vendorRobotId);
    } catch {
      v2 = null; // V2 실패 시 상세만으로 판단(온라인 여부는 불명 → 상세 응답이 있으므로 온라인 가정하지 않고 raw 에 기록)
    }
    const m = mapDetail(detail, v2, receivedAt);
    // 마지막 작업 ID 를 로봇에 기억해 둔다(상세 조회 실패 시 명령 본문의 task_id 로 사용)
    if (m.lastTaskId && robot.vendorMeta?.lastTask !== m.lastTaskId) {
      await getDb().update(schema.robots).set({ vendorMeta: { ...(robot.vendorMeta ?? {}), lastTask: m.lastTaskId } }).where(eq(schema.robots.id, robot.id));
    }
    const prev = await getStatus(robot.id);
    return {
      robotId: robot.id,
      common: m.common,
      raw: m.raw,
      online: m.online,
      batteryPct: m.batteryPct,
      pose: m.pose ?? prev?.pose ?? null,
      poseIsLastKnown: !m.online || !m.pose,
      mapVersionId: prev?.mapVersionId ?? null, // PUDU 지도 ↔ 우리 지도 버전 매핑은 실기 확인 후(지도 이름은 raw_payload 에 보관)
      currentMissionId: m.currentMissionId,
      progressPct: m.progressPct,
      lastReceivedAt: receivedAt,
      dataAt: m.dataAt,
    };
  }

  async fetchRuns(robot: Robot, fromIso: string, toIso: string): Promise<ActualRun[]> {
    const start = Math.floor(new Date(fromIso).getTime() / 1000);
    const end = Math.floor(new Date(toIso).getTime() / 1000);
    const tz = tzOffsetHours("Asia/Seoul");
    const out: ActualRun[] = [];
    const receivedAt = nowIso();
    // 실기: 통계 API 는 shop_id 로만 걸러진다. 등록 시 저장한 매장 ID 가 없으면 조회할 수 없다.
    const shopId = robot.vendorMeta?.shopId as string | number | undefined;
    if (!shopId) return out;
    for (let offset = 0; offset < 2000; offset += 20) {
      const page = await this.api.listCleanReports({ start_time: start, end_time: end, shop_id: shopId, timezone_offset: tz, limit: 20, offset });
      const list = (page.list ?? []).filter((r) => r.sn === robot.vendorRobotId);
      for (const r of list) out.push(mapReportToRun(r, robot, receivedAt, null));
      if ((page.list ?? []).length < 20) break;
    }
    return out;
  }

  async fetchMaintenance(robot: Robot): Promise<MaintenanceItem[]> {
    const page = await this.api.listComponents(robot.vendorRobotId);
    return (page.list ?? []).map((c) => ({
      name: `${c.name || c.type} 잔여 수명`,
      remainingPct: c.life_time > 0 ? Math.max(0, Math.round((1 - c.cost_time / c.life_time) * 100)) : null,
      source: "API",
    }));
  }
}
