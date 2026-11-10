import type { ActualRun, CommonStatus, RunResult } from "@/lib/domain/types";
import type { CzDeviceStatus, CzMaintenanceItem, CzMission, CzSchedule } from "./api";

/**
 * CZ Robots(CenoBots) → Wide Bot 공통 모델 매핑. 모든 표는 이 파일 한 곳에 두고 tests/cenobots.test.ts 로 고정한다.
 */

/** 작업 결과. 문서 설명은 DONE/STOP/ABEND, 응답 예제는 success/canceled/error 라 둘 다 받는다. */
export const MISSION_STATUS_MAP: Record<string, { result: RunResult; label: string }> = {
  DONE: { result: "COMPLETED", label: "정상 완료" },
  SUCCESS: { result: "COMPLETED", label: "정상 완료" },
  STOP: { result: "ABORTED", label: "중단(사용자 취소)" },
  CANCELED: { result: "ABORTED", label: "중단(사용자 취소)" },
  CANCELLED: { result: "ABORTED", label: "중단(사용자 취소)" },
  ABEND: { result: "INCOMPLETE", label: "미완료(작업 예외)" },
  ERROR: { result: "INCOMPLETE", label: "미완료(작업 예외)" },
};

/** 종료 이유(taskEndReasonEnum) 한국어. 문서 원문 설명 기준. */
export const END_REASON_KO: Record<string, string> = {
  TIME_OUT: "설정 시간 도달",
  LAPS_REACHED: "설정 바퀴 수 완료",
  APP_MANUAL: "앱에서 수동 중지",
  PAD_MANUAL: "PAD에서 수동 중지",
  PAD_TIMING: "PAD 예약",
  SYSTEM_ABEND: "시스템 비정상 종료",
  SYSTEM_PREEMPT: "새 작업에 밀려 종료",
  JOINT_CLEAN_SRC_END: "앞 작업 미종료(협동 청소)",
};

/** 비정상 종료 세부 원인(abendSubReasonEnum, errDesc 와 같은 뜻) 한국어. 장애 사유·고객 문구에 쓴다. */
export const ABEND_REASON_KO: Record<string, string> = {
  EMERGE_STOP: "비상 정지가 오래 지속됨",
  MANUAL_MODE: "수동 모드가 오래 지속됨",
  LONGTIME_MANUALCHARGE: "수동 충전 모드가 오래 지속됨",
  WAIT_MANUAL_HANDLE: "사람의 도움을 오래 기다림",
  WAIT_MANUAL_HANDLE_WATER: "급수 도움을 오래 기다림",
  SYSTEM_STATUS_ERROR: "시스템 오류가 오래 지속됨",
  ABNORMAL_TIMEOUT: "작업 최대 시간 초과",
  CHASSIS_TO_STATION_SIG: "청소 장치 이상",
  CHARGING_TIME_UNREASONABLE: "충전 시간이 비정상적으로 김",
  LOW_CLEAN_EFFICIENCY: "청소 효율 낮음",
  SUB_SYSTEM_PREEMPT: "새 작업에 밀림",
  NOT_RUNNING_TIMEOUT: "시스템 오류로 작업 종료",
  ROBOT_SHUTDOWN_TIMEOUT: "장시간 전원 꺼짐",
  HIGH_AIR_PRESSURE: "진공 압력이 너무 높음",
  LOW_AIR_PRESSURE: "진공 압력이 너무 낮음",
  PREEMPTED_NOT_EXECUTED: "우선 작업 때문에 실행 안 됨",
  LIDAR_OBSTRUCTED: "라이다 가림",
  FRONT_DEPTH_OBSTRUCTED: "전면 깊이 카메라 가림",
  BACK_DEPTH_OBSTRUCTED: "후면 깊이 카메라 가림",
  MAP_MISMATCH_NOT_EXECUTED: "지도 불일치로 실행 안 됨",
  WIRING_ENTANGLEMENT: "브러시에 이물·케이블 엉킴 의심",
  WHEEL_STUCK: "바퀴 걸림",
  DISC_BRUSH_FELL_OFF: "디스크 브러시 빠짐 의심",
  ROLLED_CARPET: "카펫에 걸려 전진 불가",
  VACUUM_HOSE_DROP: "흡입 호스 빠짐",
  SQUEEGEE_DROP: "스퀴지 빠짐",
  STATION_ADD_WATER_ERROR: "워크스테이션 급수 시간 초과",
  ROLL_BRUSH_MOTOR_OVERLOAD: "롤러 브러시 모터 과부하",
  LEFT_SIDE_MOTOR_OVERLOAD: "왼쪽 사이드 브러시 모터 과부하",
  RIGHT_SIDE_MOTOR_OVERLOAD: "오른쪽 사이드 브러시 모터 과부하",
  ABNORMAL_DISCHARGE_SEWAGE: "오수 배출 시간 초과",
  CHARGING_FAILED: "재충전 실패",
  CHARGING_FAILED_FAULT_CHARGER: "충전 실패(충전기·접점 이상 또는 충전판 오염)",
  CHARGING_FAILED_COMM_ERROR: "충전 실패(충전소 통신 불안정)",
  CHARGING_FAILED_NO_TOUCH: "충전 실패(충전소 접촉·통신 오류)",
  CHARGING_FAILED_NO_STATION: "충전 실패(충전소를 찾지 못함)",
  DOOR_BLOCKING: "문이 닫혀 있거나 막혀 통과 불가",
  ABNORMAL_TIMEOUT_PAUSED: "장시간 일시정지 후 예약 작업에 밀림",
  LEAVE_DOCKING_FAILED: "충전소 출발 실패",
  DIRTY_BOX_SIG_ERROR: "오수통 수위 센서 이상",
  RIGHT_MOTOR_OVERLOAD: "오른쪽 바퀴 모터 과부하",
  LEFT_MOTOR_OVERLOAD: "왼쪽 바퀴 모터 과부하",
  WORKER_STATION_EMERGE_STOP: "워크스테이션 비상 정지 눌림",
  BACK_DEPTH_CAMERA_ERROR: "후면 깊이 카메라 고장",
  FRONT_DEPTH_CAMERA_ERROR: "전면 깊이 카메라 고장",
  DISC_BRUSH_DAMAGE: "디스크 브러시 모터 손상",
  OBSTACLE_BLOCKING: "장애물에 막힘",
  LONGTIME_BEPREEMPTED: "우선 작업 때문에 시작이 오래 지연",
  LONGTIME_WAIT_WATER_FINISH: "급수·배수가 오래 걸림",
  JOINT_CLEAN_MAP_VERSION_NOT_EQUAL: "협동 청소 지도 불일치",
  JOINT_CLEAN_SRC_END: "앞 작업 미종료(협동 청소)",
};

/** 작업 원천(taskSourceTypeEnum). 예약 계열은 계획 실행(PLANNED). */
const PLANNED_SOURCES = new Set(["APP_TIMING", "PAD_TIMING"]);

/** 장애 코드 표기: CZ 시스템 오류 숫자 코드에 접두사를 붙여 PUDU 코드와 섞이지 않게 한다. */
export function czErrorCode(code: number | string): string {
  return `CZ-${String(code)}`;
}

/** CZ 오류 코드별 고객 표시 문구(한국어). 모르는 코드는 일반 문구. 관리 설정의 장애 등급 화면 목록에도 쓴다. */
export const CZ_ERROR_MESSAGES: Record<string, string> = {
  "CZ-204801": "비상 정지 버튼이 눌려 작업이 멈췄습니다.",
  "CZ-703903": "충전에 실패했습니다. 현장 확인이 필요합니다.",
  "CZ-DOOR_CALL": "로봇이 문 열기 도움을 요청했습니다.",
};

/** 담당자용 조치 안내(장애 화면 말풍선·현장 조치 안내). */
export const CZ_ERROR_GUIDE: Record<string, { field: string[]; vendor: boolean }> = {
  "CZ-204801": { field: ["주변 안전을 확인하고 비상 정지 버튼을 돌려 해제한다", "PAD 에서 작업을 재개한다"], vendor: false },
  "CZ-703903": { field: ["충전소 앞을 비우고 충전 접점을 닦는다", "충전소 전원·위치를 확인하고 수동 도킹한다"], vendor: true },
  "CZ-DOOR_CALL": { field: ["로봇 위치의 문을 열어 준다"], vendor: false },
};

export function czCustomerMessage(code: string, description?: string): string {
  if (CZ_ERROR_MESSAGES[code]) return CZ_ERROR_MESSAGES[code];
  if (description && /charg/i.test(description)) return "충전 관련 이상이 감지되었습니다. 현장 확인 중입니다.";
  return "로봇에 이상이 발생하여 확인 중입니다.";
}

/** 디바이스 상태 → 공통 상태. 우선순위: 오프라인 > 비상정지·이상 > 일시정지 > 복귀 > 청소 > 충전 > 대기. */
export const TASK_STATUS_COMMON: Record<string, CommonStatus> = {
  ON_GOING: "CLEANING",
  ROUTING: "CLEANING",
  READY: "CLEANING",
  ABSORBS_WATER: "CLEANING",
  TAKE_ELEVATOR: "CLEANING",
  TAKE_ELEVATOR_DONE: "CLEANING",
  TAKE_ELEVATOR_PRE: "CLEANING",
  PASS_THROUGH: "CLEANING",
  WIFI_MAP_AUTO_CHECKING: "CLEANING",
  PULL_NEW_VERSION_MAP: "CLEANING",
  WARNING: "CLEANING",
  PAUSE: "PAUSED",
  BACK_TO_STATION: "RETURNING",
  CHARGING: "CHARGING",
  ABEND: "ERROR",
  MANUAL_HANDLING: "ERROR",
  CHARGING_BROKEN: "ERROR",
};

export function mapDeviceStatus(s: CzDeviceStatus): { common: CommonStatus; raw: string; progressPct: number | null; missionId: string | null } {
  const t = s.missionTaskDetail ?? null;
  const taskStatus = (t?.taskStatus ?? "").toUpperCase();
  const sweep = (t?.sweepMode ?? "").toLowerCase();
  let common: CommonStatus;
  if (!s.online) common = "OFFLINE";
  else if (s.isEmergency) common = "ERROR";
  else if (s.running && (sweep === "homing" || sweep === "charge" || taskStatus === "BACK_TO_STATION")) common = "RETURNING";
  else if (s.running && TASK_STATUS_COMMON[taskStatus]) common = TASK_STATUS_COMMON[taskStatus];
  else if (s.running) common = "CLEANING";
  else if (s.charging) common = "CHARGING";
  else common = "IDLE";
  const prog = typeof t?.taskProgress === "number" ? (t.taskProgress <= 1 ? t.taskProgress * 100 : t.taskProgress) : null;
  const flags = [s.isEmergency ? "비상정지" : "", s.isManual ? "수동모드" : "", s.charging ? `충전(${s.chargingMode ?? "-"})` : ""].filter(Boolean).join(",");
  const raw = `online=${s.online} running=${s.running} task=${taskStatus || "-"} sweep=${t?.sweepMode ?? "-"}${flags ? ` [${flags}]` : ""}`;
  return { common, raw, progressPct: common === "CLEANING" || common === "PAUSED" ? (prog === null ? null : Math.round(prog)) : null, missionId: s.running ? (t?.currentMissionId ?? null) : null };
}

/** 문자열 커버리지("95%", "0.95", 95) → 0~100 */
export function parseCoverage(v: string | number | undefined | null): number | null {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim();
  const n = Number(s.replace("%", ""));
  if (!Number.isFinite(n)) return null;
  if (s.endsWith("%")) return Math.round(n * 10) / 10;
  return Math.round((n <= 1 ? n * 100 : n) * 10) / 10;
}

/**
 * 작업 이력 → 실적. 결과 매핑은 MISSION_STATUS_MAP. 모르는 status 는 '미분류'로 남기고 호출 측이 경고를 기록한다.
 * 진행 중(종료 시각 없음)은 null(종료 후 적재).
 */
export function mapMissionToRun(
  m: CzMission,
  robot: { id: string; siteId: string; floorId: string; openId: string },
  receivedAtIso: string,
): { run: ActualRun; unknownStatus: boolean } | null {
  if (!m.missionId || !m.startTimeStamp) return null;
  if (!m.endTimeStamp) return null;
  const key = String(m.status ?? "").toUpperCase();
  const mapped = MISSION_STATUS_MAP[key];
  const unknownStatus = !mapped;
  const result: RunResult = mapped?.result ?? "INCOMPLETE";
  const reasons: string[] = [mapped?.label ?? `미분류(status=${m.status ?? "-"})`];
  if (m.taskEndReasonEnum) reasons.push(END_REASON_KO[m.taskEndReasonEnum] ?? m.taskEndReasonEnum);
  if (m.abendSubReasonEnum) reasons.push(ABEND_REASON_KO[m.abendSubReasonEnum] ?? m.abendSubReasonEnum);
  else if (m.errDesc) reasons.push(m.errDesc);
  const startedAt = new Date(m.startTimeStamp).toISOString();
  const endedAt = new Date(m.endTimeStamp).toISOString();
  // 문서상 단위가 확실한 것은 totalTime(분). 없으면 시작·종료 시각 차.
  const durationMin = typeof m.totalTime === "number" && m.totalTime > 0 ? m.totalTime : Math.max(0, Math.round(((m.endTimeStamp - m.startTimeStamp) / 60000) * 10) / 10);
  const percentage = parseCoverage(m.coverage);
  return {
    unknownStatus,
    run: {
      id: `run-cz-${robot.openId}-${m.missionId}`,
      vendorRunId: m.missionId,
      robotId: robot.id,
      siteId: robot.siteId,
      floorId: robot.floorId,
      taskId: null,
      zoneIds: [],
      startedAt,
      endedAt,
      result,
      endReason: reasons.join(" · "),
      areaM2: Math.round((m.cleanedArea ?? 0) * 10) / 10,
      durationMin,
      waterL: typeof m.water === "number" ? Math.round(m.water * 100) / 100 : null,
      detergentMl: typeof m.cleaningSolution === "number" ? Math.round(m.cleaningSolution) : null,
      origin: m.taskSourceTypeEnum && PLANNED_SOURCES.has(m.taskSourceTypeEnum) ? "PLANNED" : "ADHOC",
      receivedAt: receivedAtIso,
      coverage:
        percentage !== null || m.taskSummaryPictureUrl || m.sceneName
          ? { percentage, mapName: m.sceneName ?? null, mapVersion: null, resultImageUrl: m.taskSummaryPictureUrl || null, heatmapUrl: null, areas: (m.areaList ?? []).map((a) => ({ vendorId: a.id, name: a.name, cleanCount: 1, areaM2: 0 })) }
          : null,
    },
  };
}

const DAY: Record<string, number> = { "SUN.": 0, "MON.": 1, "TUE.": 2, "WED.": 3, "THUR.": 4, "THU.": 4, "FRI.": 5, "SAT.": 6 };

/** "10:40 am" / "04:42 PM" / "22:00" → "HH:mm" */
export function parseCzTime(s: string): string | null {
  const m = String(s ?? "").trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export function parseCzDays(days: string[] | undefined): number[] {
  return Array.from(new Set((days ?? []).map((d) => DAY[String(d).trim().toUpperCase().replace(/\.?$/, ".")]).filter((n): n is number => n !== undefined))).sort();
}

export function scheduleName(s: CzSchedule): string {
  const where = s.cleanEveryWhere ? "전체 구역" : (s.areas ?? []).map((a) => a.name).filter(Boolean).join(", ") || "지정 구역";
  return `예약 ${parseCzTime(s.startTime) ?? s.startTime} · ${where}`;
}

/** "85%" → 85 */
export function maintenanceRemainingPct(i: CzMaintenanceItem): number | null {
  if (i.remainPercent !== undefined && i.remainPercent !== null && i.remainPercent !== "") {
    const n = Number(String(i.remainPercent).replace("%", ""));
    if (Number.isFinite(n)) return Math.max(0, Math.min(100, Math.round(n)));
  }
  if (typeof i.life === "number" && i.life > 0 && typeof i.remainHours === "number") return Math.max(0, Math.round((i.remainHours / i.life) * 100));
  return null;
}

/** 소모품 이름 한국어(L4 에서 흔한 항목). 모르는 이름은 원문. */
export const MAINTENANCE_NAME_KO: Record<string, string> = {
  "Squeegee Blade": "스퀴지 블레이드",
  Detergent: "세제",
  "Side Brushes": "사이드 브러시",
  "Disc Brush": "디스크 브러시",
  "Roller Brush": "롤러 브러시",
  Filter: "필터",
  "HEPA Filter": "HEPA 필터",
};
