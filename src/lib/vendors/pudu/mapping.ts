import type { ActualRun, CommandType, CommonStatus, RobotModel, RunResult, Severity } from "@/lib/domain/types";
import type { PuduCleanDetail, PuduCleanReportDetail, PuduCleanReportSummary, PuduErrorLog, PuduExecBody, PuduStatusV2 } from "./api";

/**
 * PUDU ↔ 공통 모델 매핑. 근거는 docs/06-PUDU-API-검토.md 5장(상태 코드 표).
 * 원시 값은 항상 함께 보존하고, 매핑은 실기에서 재확인한다.
 */

/** 청소로봇 상태 코드(cleanbot.task) → 공통 상태. */
export function mapCleanbotTaskCode(code: number | undefined | null): { common: CommonStatus; label: string } {
  if (code === undefined || code === null) return { common: "IDLE", label: "Normal(대기)" };
  if (code === -100) return { common: "ERROR", label: "Error" };
  if (code === -200) return { common: "ERROR", label: "LostLocalization(위치 이상)" };
  if (code === -300) return { common: "IDLE", label: "Notice(경고)" };
  if (code === 301 || code === 402 || code === 101 || code === 502 || code === 601) return { common: "PAUSED", label: `일시정지(${code})` };
  if ((code >= 300 && code <= 315) || code === 710) return { common: "CLEANING", label: `청소(${code})` };
  if ((code >= 100 && code <= 107) || (code >= 400 && code <= 406) || (code >= 500 && code <= 505)) return { common: "RETURNING", label: `복귀/도킹(${code})` };
  if (code === 201 || code === 202 || code === 203) return { common: "CHARGING", label: `충전/보급(${code})` };
  return { common: "IDLE", label: `기타(${code})` };
}

export function mapRunState(run: PuduStatusV2["run_state"] | undefined): CommonStatus | null {
  if (run === "OFFLINE") return "OFFLINE";
  return null; // DISABLE/BUSY/IDLE 는 상세 코드로 판단
}

/** product_code → 내부 모델. 문서의 Robot Types 표 기준. 알 수 없으면 null(사람이 지정하지 않고 보류). */
export function mapProductCode(code: string | undefined): RobotModel | null {
  switch ((code ?? "").replace(/[\s_-]/g, "").toLowerCase()) {
    case "cc1":
      return "CC1";
    case "cc1pro":
      return "CC1_PRO";
    case "mt1":
      return "MT1";
    case "mt1vac":
      return "MT1_VAC";
    case "mt1max":
      return "MT1_MAX";
    case "bg1":
      return "BG1"; // 실기 로봇 목록에 product_code "BG1" 존재 확인(2026-10). 청소 API 응답은 미확인
    case "bg1pro":
      return "BG1_PRO"; // 실기 로봇 목록에 "BG1Pro" 존재 확인
    default:
      return null;
  }
}

export interface MappedStatus {
  common: CommonStatus;
  raw: string;
  online: boolean;
  batteryPct: number | null;
  pose: { x: number; y: number; headingDeg: number } | null;
  mapName: string | null;
  floor: string | null;
  progressPct: number | null;
  currentMissionId: string | null;
  freshWaterPct: number | null;
  sewagePct: number | null;
  dataAt: string; // 데이터 발생 시각(ISO)
}

/** 상세(robot/detail) + 상태 V2 → 공통 상태. V2 가 OFFLINE 이면 오프라인 우선. */
export function mapDetail(detail: PuduCleanDetail, statusV2: PuduStatusV2 | null, receivedAtIso: string): MappedStatus {
  const code = detail.cleanbot?.task;
  const mapped = mapCleanbotTaskCode(code);
  // 실기: 상세 응답에 online(boolean) 이 있고, V2 의 run_state=OFFLINE 과 함께 본다. 둘 중 하나라도 오프라인이면 오프라인.
  const offline = mapRunState(statusV2?.run_state) === "OFFLINE" || detail.online === false;
  const common: CommonStatus = offline ? "OFFLINE" : mapped.common;
  const result = detail.cleanbot?.clean?.result;
  const ts = Number(statusV2?.timestamp ?? 0); // 실기에서는 문자열
  const dataAt = ts > 0 ? new Date(ts * 1000).toISOString() : receivedAtIso;
  return {
    common,
    raw: `task=${code ?? "-"} ${mapped.label}${statusV2 ? ` run_state=${statusV2.run_state}` : ""}${detail.cleanbot?.detail ? ` detail=${detail.cleanbot.detail}` : ""}`,
    online: !offline,
    batteryPct: typeof detail.battery === "number" ? detail.battery : (statusV2?.battery ?? null),
    pose: detail.position ? { x: detail.position.x, y: detail.position.y, headingDeg: 0 } : null, // 방향(yaw)은 상세 API 에 없음
    mapName: detail.map?.name ?? null,
    floor: detail.map?.floor ?? null,
    progressPct: common === "CLEANING" || common === "PAUSED" ? (result?.percentage ?? null) : null,
    currentMissionId: common === "CLEANING" || common === "PAUSED" ? (detail.cleanbot?.clean?.report_id ?? null) : null,
    freshWaterPct: detail.cleanbot?.rising ?? null,
    sewagePct: detail.cleanbot?.sewage ?? null,
    dataAt,
  };
}

/** 보고서 status(0~6) → 결과. 4 종료=완료, 6 취소=중단, 3 중단/5 예외=미완료, 그 외(진행 중)=미완료로 두고 재수집 시 갱신. */
export function mapReportStatus(status: number | undefined): { result: RunResult; endReason: string } {
  switch (status) {
    case 4:
      return { result: "COMPLETED", endReason: "작업 종료(status 4)" };
    case 6:
      return { result: "ABORTED", endReason: "작업 취소(status 6)" };
    case 3:
      return { result: "INCOMPLETE", endReason: "작업 중단(status 3)" };
    case 5:
      return { result: "INCOMPLETE", endReason: "작업 예외(status 5)" };
    case 1:
    case 2:
      return { result: "INCOMPLETE", endReason: `진행 중(status ${status}) — 종료 후 갱신` };
    default:
      return { result: "INCOMPLETE", endReason: `상태 미확인(status ${status ?? "-"})` };
  }
}

/** 청소 보고서 → 실적. 구역(zoneIds)은 PUDU 가 우리 구역 개념을 모르므로 비워 두고 floor_list 원문을 raw 에 보관한다. */
export function mapReportToRun(
  r: PuduCleanReportSummary | PuduCleanReportDetail,
  robot: { id: string; siteId: string; floorId: string },
  receivedAtIso: string,
  registeredTaskId: string | null,
): ActualRun {
  const { result, endReason } = mapReportStatus(r.status);
  const d = r as PuduCleanReportDetail;
  const startedAt = new Date(r.start_time * 1000).toISOString();
  const endedAt = new Date((r.end_time || r.start_time) * 1000).toISOString();
  return {
    id: `run-pudu-${r.sn}-${r.report_id}`,
    vendorRunId: r.report_id,
    robotId: robot.id,
    siteId: robot.siteId,
    floorId: robot.floorId,
    taskId: registeredTaskId,
    zoneIds: [],
    startedAt,
    endedAt,
    result,
    endReason,
    areaM2: Math.round((r.clean_area ?? 0) * 10) / 10,
    durationMin: Math.round(((r.clean_time ?? 0) / 60) * 10) / 10,
    waterL: typeof d.cost_water === "number" ? Math.round((d.cost_water / 1000) * 100) / 100 : null, // 문서: ml
    detergentMl: null, // PUDU 보고서에 세제 사용량 필드 없음
    origin: d.timed_report_id ? "PLANNED" : "ADHOC",
    receivedAt: receivedAtIso,
  };
}

/**
 * task/list 의 필수 product 파라미터. 실기 확인(2026-10): 소모품·예약 응답의 product 값과 같고 대소문자 무관.
 * CC1→cc1(또는 cleanbot), CC1Pro→cc1Pro, MT1→mt1, MT1Vac→mt1Pro(!), MT1Max→mt1Max. BG1 은 미확인(추정값).
 * 등록 시 소모품 응답에서 실제 값을 vendorMeta.product 에 저장하고, 없을 때만 이 표를 쓴다.
 */
export function productParamFor(productCode: string | undefined): string | null {
  switch ((productCode ?? "").replace(/[\s_-]/g, "").toLowerCase()) {
    case "cc1":
      return "cc1";
    case "cc1pro":
      return "cc1Pro";
    case "mt1":
      return "mt1";
    case "mt1vac":
      return "mt1Pro";
    case "mt1max":
      return "mt1Max";
    case "bg1":
      return "bg1"; // 미확인
    case "bg1pro":
      return "bg1Pro"; // 미확인
    default:
      return null;
  }
}

export function mapErrorLevel(level: string | undefined): Severity {
  switch ((level ?? "").toLowerCase()) {
    case "fatal":
      return "CRITICAL";
    case "error":
      return "HIGH";
    case "warning":
      return "MEDIUM";
    default:
      return "LOW"; // Event
  }
}

export const PUDU_ERROR_MESSAGES: Record<string, string> = {
  CleanWaterEmpty: "청수가 부족하여 작업이 중단되었습니다.",
  MobileStationCleanWaterEmpty: "워크스테이션 청수통이 비었습니다.",
  CleanSewageFull: "오수통이 가득 차 작업이 중단되었습니다.",
  MobileStationSewageFull: "워크스테이션 오수통이 가득 찼습니다.",
  CleanAgentEmpty: "세제가 부족합니다.",
  TrashFull: "먼지통이 가득 찼습니다.",
  LostLocalization: "위치 인식에 실패하여 작업이 중단되었습니다.",
  FullOfSewage: "오수통이 가득 차 작업이 중단되었습니다.", // 실기 로그에서 확인(CC1Pro)
  CoverPlate: "덮개(커버 플레이트) 이상이 감지되었습니다. 현장 확인이 필요합니다.", // 실기 로그에서 확인(MT1)
  LowBatteryLevel: "배터리가 부족합니다.",
  EmergencyStop: "비상 정지 버튼이 눌렸습니다.",
  PlanFailOverTime: "경로 계획에 실패하여 이동할 수 없습니다.",
  ReplanError: "경로가 막혀 이동할 수 없습니다.",
  CanNotReach: "목표 지점에 도달할 수 없습니다.",
  DockingPileFail: "충전 도킹에 실패했습니다.",
  MobileStationNotConnected: "워크스테이션 연결이 끊겼습니다.",
};

export function customerMessageFor(errorType: string): string {
  return PUDU_ERROR_MESSAGES[errorType] ?? "로봇에 이상이 발생하여 확인 중입니다.";
}

export function errorToIncidentKey(e: Pick<PuduErrorLog, "error_id" | "id" | "sn" | "task_time" | "error_type">): string {
  return `pudu:${e.sn}:${e.error_id || e.id || `${e.error_type}@${e.task_time}`}`;
}

/**
 * 공통 명령 → CleanCommands 본문. STOP 은 "취소는 먼저 일시정지" 규칙 때문에 두 단계가 될 수 있어 배열로 돌려준다.
 * AREA_CLEAN 은 PUDU 에 임시 영역 API 가 없어 null.
 */
export function buildExecBodies(type: CommandType, sn: string, task: { vendorTaskId: string; version: number; name?: string } | null, currentCommon: CommonStatus): PuduExecBody[] | null {
  switch (type) {
    case "START_TASK":
      if (!task) return null;
      return [{ sn, type: 3, clean: { status: 1, task_id: task.vendorTaskId, version: task.version, name: task.name } }];
    case "RESUME":
      return [{ sn, type: 3, clean: { status: 1, ...(task ? { task_id: task.vendorTaskId, version: task.version } : {}) } }];
    case "PAUSE":
      return [{ sn, type: 3, clean: { status: 3 } }];
    case "STOP":
      return currentCommon === "CLEANING" || currentCommon === "RETURNING"
        ? [
            { sn, type: 3, clean: { status: 3 } },
            { sn, type: 3, clean: { status: 4 } },
          ]
        : [{ sn, type: 3, clean: { status: 4 } }];
    case "GO_HOME":
      return [{ sn, type: 5, clean: { status: 1 } }];
    case "AREA_CLEAN":
    default:
      return null;
  }
}

export const PUDU_SUPPORTED_COMMANDS: CommandType[] = ["START_TASK", "PAUSE", "RESUME", "STOP", "GO_HOME"];
