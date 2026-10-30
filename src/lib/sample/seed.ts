/**
 * 샘플 데이터 생성기 (1단계 시제품 전용)
 *
 * ⚠ 여기의 사업장명·층·구역·모델별 대수·로봇 배치는 모두 가상이며 실제 배치 정보가 아니다.
 *   화면 상단 배너와 각 사업장 이름에 "가상"을 표시한다.
 * 비밀값·고객 실제 자료는 포함하지 않는다.
 */
import type {
  ActualRun,
  Command,
  CommandType,
  Floor,
  Incident,
  Inspection,
  MapVersion,
  PlannedRun,
  RegisteredTask,
  Robot,
  RobotModel,
  RobotStatus,
  Schedule,
  Site,
  Zone,
  CommonStatus,
  Severity,
} from "@/lib/domain/types";
import { MODEL_VENDOR } from "@/lib/domain/commands";
import { emptyStore, upsertActualRun, type StoreData } from "@/lib/store/data";
import { addMinutes, localDateKey, localMonthKey, localToUtcIso, shiftMonth } from "@/lib/util/time";
import { between, mulberry32, pick } from "@/lib/util/random";
import { computeAggregates } from "@/lib/services/reportAggregates";
import { addDays, calendarMonthPeriod, type ReportPeriod } from "@/lib/reports/schedule";

const TZ = "Asia/Seoul";

const SUPPORTED_BY_MODEL: Record<RobotModel, CommandType[]> = {
  // CenoBots L4: 공개 문서에서 endpoint 확인. 실기 시험 전.
  L4: ["START_TASK", "PAUSE", "RESUME", "STOP", "GO_HOME", "AREA_CLEAN"],
  // PUDU: 모델별 API 미검증 — 시제품에서는 기본 제어만 시뮬레이션으로 가정.
  MT1: ["START_TASK", "PAUSE", "RESUME", "STOP", "GO_HOME"],
  MT1_VAC: ["START_TASK", "PAUSE", "RESUME", "STOP", "GO_HOME"],
  MT1_MAX: ["START_TASK", "PAUSE", "RESUME", "STOP", "GO_HOME"],
  CC1: ["START_TASK", "PAUSE", "RESUME", "STOP", "GO_HOME"],
  CC1_PRO: ["START_TASK", "PAUSE", "RESUME", "STOP", "GO_HOME"],
  BG1: ["START_TASK", "PAUSE", "RESUME", "STOP", "GO_HOME"],
  BG1_PRO: ["START_TASK", "PAUSE", "RESUME", "STOP", "GO_HOME"],
  J40: [],
};

interface SiteSpec {
  id: string;
  name: string;
  address: string;
  floors: { id: string; name: string; zones: string[]; oldMapNoCorners?: boolean }[];
  robots: { id: string; model: RobotModel; floorIdx: number; name: string }[];
}

/** 가상 사업장 5곳 · 로봇 20대 (MT1 6 · CC1 5 · BG1 4 · L4 5). 실제 배치 아님. */
const SITE_SPECS: SiteSpec[] = [
  {
    id: "site-01",
    name: "가상 사업장 1 (오피스 타워)",
    address: "가상 주소 1",
    floors: [
      { id: "site-01-f1", name: "1F 로비", zones: ["로비 중앙", "엘리베이터 홀", "안내데스크 주변", "동측 복도"] },
      { id: "site-01-b1", name: "B1 식당가", zones: ["식당 홀", "푸드코트 통로", "서측 복도"] },
    ],
    robots: [
      { id: "PW-R-001", model: "MT1", floorIdx: 0, name: "로비 1호" },
      { id: "PW-R-002", model: "MT1", floorIdx: 0, name: "로비 2호" },
      { id: "PW-R-003", model: "CC1", floorIdx: 1, name: "식당가 1호" },
      { id: "PW-R-004", model: "BG1", floorIdx: 1, name: "식당가 2호" },
      { id: "PW-R-005", model: "L4", floorIdx: 0, name: "로비 3호" },
    ],
  },
  {
    id: "site-02",
    name: "가상 사업장 2 (물류센터)",
    address: "가상 주소 2",
    floors: [
      { id: "site-02-f1", name: "1F 물류동", zones: ["입고장", "피킹 존 A", "피킹 존 B", "출고장"] },
      { id: "site-02-f2", name: "2F 사무동", zones: ["사무실 복도", "회의실 구역", "휴게실"] },
    ],
    robots: [
      { id: "PW-R-006", model: "MT1", floorIdx: 0, name: "물류 1호" },
      { id: "PW-R-007", model: "CC1", floorIdx: 0, name: "물류 2호" },
      { id: "PW-R-008", model: "L4", floorIdx: 0, name: "물류 3호" },
      { id: "PW-R-009", model: "BG1", floorIdx: 1, name: "사무동 1호" },
    ],
  },
  {
    id: "site-03",
    name: "가상 사업장 3 (쇼핑몰)",
    address: "가상 주소 3",
    floors: [
      { id: "site-03-f1", name: "1F 메인홀", zones: ["중앙 광장", "북측 통로", "남측 통로", "푸드존"] },
      { id: "site-03-f3", name: "3F 영화관층", zones: ["매표 홀", "상영관 복도", "화장실 앞"], oldMapNoCorners: true },
    ],
    robots: [
      { id: "PW-R-010", model: "MT1", floorIdx: 0, name: "메인홀 1호" },
      { id: "PW-R-011", model: "CC1", floorIdx: 0, name: "메인홀 2호" },
      { id: "PW-R-012", model: "L4", floorIdx: 0, name: "메인홀 3호 (이관)" },
      { id: "PW-R-013", model: "BG1", floorIdx: 1, name: "3층 1호" },
    ],
  },
  {
    id: "site-04",
    name: "가상 사업장 4 (병원)",
    address: "가상 주소 4",
    floors: [
      { id: "site-04-f1", name: "1F 외래", zones: ["접수 로비", "외래 복도 A", "외래 복도 B", "약국 앞"] },
      { id: "site-04-f2", name: "2F 검사실", zones: ["검사 대기실", "검사실 복도", "직원 통로"] },
    ],
    robots: [
      { id: "PW-R-014", model: "MT1", floorIdx: 0, name: "외래 1호" },
      { id: "PW-R-015", model: "CC1", floorIdx: 0, name: "외래 2호" },
      { id: "PW-R-016", model: "L4", floorIdx: 1, name: "검사실 1호" },
      { id: "PW-R-017", model: "CC1", floorIdx: 1, name: "검사실 2호" },
    ],
  },
  {
    id: "site-05",
    name: "가상 사업장 5 (공장동)",
    address: "가상 주소 5",
    floors: [{ id: "site-05-f1", name: "1F 생산동", zones: ["조립 라인 통로", "자재 창고 앞", "식당 통로", "출입구 홀"] }],
    robots: [
      { id: "PW-R-018", model: "MT1", floorIdx: 0, name: "생산동 1호" },
      { id: "PW-R-019", model: "L4", floorIdx: 0, name: "생산동 2호" },
      { id: "PW-R-020", model: "BG1", floorIdx: 0, name: "생산동 3호" },
    ],
  },
];

const MAP_W = 1200;
const MAP_H = 800;

function zonePolygon(i: number, count: number): [number, number][] {
  // 지도 안을 격자로 나눈 사각형 구역. 실제 지도 아님.
  const cols = 2;
  const rows = Math.ceil(count / cols);
  const w = (MAP_W - 160) / cols;
  const h = (MAP_H - 160) / rows;
  const c = i % cols;
  const r = Math.floor(i / cols);
  const x0 = 80 + c * w + 20;
  const y0 = 80 + r * h + 20;
  return [
    [x0, y0],
    [x0 + w - 40, y0],
    [x0 + w - 40, y0 + h - 40],
    [x0, y0 + h - 40],
  ];
}

function polygonCenter(p: [number, number][]): [number, number] {
  const x = p.reduce((s, q) => s + q[0], 0) / p.length;
  const y = p.reduce((s, q) => s + q[1], 0) / p.length;
  return [x, y];
}

export function buildSampleStore(nowIso: string): StoreData {
  const rng = mulberry32(20261027);
  const data = emptyStore(nowIso);
  const thisMonth = localMonthKey(nowIso, TZ);
  const prevMonth = shiftMonth(thisMonth, -1);
  const today = localDateKey(nowIso, TZ);

  // ---- 사업장 · 층 · 지도 · 구역 · 로봇 ------------------------------------
  for (const spec of SITE_SPECS) {
    // 샘플 설치일: 전월 1일의 전날(전전월 말일) → 1개월차 월간 보고서 기간이 전월 1일~말일이 된다.
    const site: Site = { id: spec.id, name: spec.name, timezone: TZ, address: spec.address, isSample: true, installedOn: addDays(`${prevMonth}-01`, -1) };
    data.sites.push(site);

    spec.floors.forEach((f) => {
      const v1: MapVersion = {
        id: `${f.id}-map-v1`,
        floorId: f.id,
        version: 1,
        widthPx: MAP_W,
        heightPx: MAP_H,
        corners: f.oldMapNoCorners ? null : { bl: [0, 0], tl: [0, 40], tr: [60, 40], br: [60, 0] },
      };
      const v2: MapVersion = {
        id: `${f.id}-map-v2`,
        floorId: f.id,
        version: 2,
        widthPx: MAP_W,
        heightPx: MAP_H,
        corners: f.oldMapNoCorners ? null : { bl: [0, 0], tl: [0, 40], tr: [60, 40], br: [60, 0] },
      };
      data.mapVersions.push(v1, v2);
      const floor: Floor = { id: f.id, siteId: spec.id, name: f.name, currentMapVersionId: v2.id };
      data.floors.push(floor);
      f.zones.forEach((zn, i) => {
        const polygon = zonePolygon(i, f.zones.length);
        const zone: Zone = { id: `${f.id}-z${i + 1}`, floorId: f.id, name: zn, polygon, areaM2: Math.round(between(rng, 180, 520)) };
        data.zones.push(zone);
      });
    });

    spec.robots.forEach((r, idx) => {
      const floor = spec.floors[r.floorIdx];
      const vendor = MODEL_VENDOR[r.model];
      const robot: Robot = {
        id: r.id,
        vendor,
        model: r.model,
        vendorRobotId: vendor === "CENOBOTS" ? `sample-openid-${r.id.toLowerCase()}` : `sample-pudu-${r.id.toLowerCase()}`,
        siteId: spec.id,
        floorId: floor.id,
        name: r.name,
        serial: `SAMPLE-${r.model}-${String(idx + 1).padStart(3, "0")}`,
        firmware: vendor === "CENOBOTS" ? "샘플 1.0.0" : "샘플 2.3.1",
        active: true,
        supportedCommands: SUPPORTED_BY_MODEL[r.model],
        internalNote: idx === 0 ? "내부 메모(샘플): 좌측 범퍼 센서 교체 이력 있음. 고객 비공개." : "",
      };
      data.robots.push(robot);
    });
  }

  // 배치 이력: PW-R-012 는 이번 달 1일에 가상 사업장 2 → 3 으로 이관(과거 실적은 사업장 2 소속 유지)
  const monthStartIso = localToUtcIso(`${thisMonth}-01`, "00:00", TZ);
  for (const robot of data.robots) {
    if (robot.id === "PW-R-012") {
      data.placements.push({ robotId: robot.id, siteId: "site-02", from: localToUtcIso(`${shiftMonth(thisMonth, -6)}-01`, "00:00", TZ), to: monthStartIso });
      data.placements.push({ robotId: robot.id, siteId: "site-03", from: monthStartIso, to: null });
    } else {
      data.placements.push({ robotId: robot.id, siteId: robot.siteId, from: localToUtcIso(`${shiftMonth(thisMonth, -6)}-01`, "00:00", TZ), to: null });
    }
  }

  // ---- 로봇 상태 ---------------------------------------------------------------
  const statusPlan: Record<string, Partial<RobotStatus> & { common: CommonStatus }> = {
    "PW-R-001": { common: "CLEANING", raw: "WORKING", batteryPct: 62, progressPct: 45 },
    "PW-R-002": { common: "CHARGING", raw: "CHARGING", batteryPct: 88 },
    "PW-R-003": { common: "IDLE", raw: "FREE", batteryPct: 100 },
    "PW-R-004": { common: "ERROR", raw: "ERROR:BRUSH_MOTOR", batteryPct: 55 },
    "PW-R-005": { common: "CLEANING", raw: "running=true", batteryPct: 71, progressPct: 20 },
    "PW-R-006": { common: "OFFLINE", raw: "online=false", batteryPct: 34, online: false, lastReceivedAt: addMinutes(nowIso, -185), dataAt: addMinutes(nowIso, -186) },
    "PW-R-007": { common: "PAUSED", raw: "PAUSED", batteryPct: 48, progressPct: 60 },
    "PW-R-008": { common: "CLEANING", raw: "running=true", batteryPct: 80, progressPct: 75 },
    "PW-R-009": { common: "IDLE", raw: "FREE", batteryPct: 97 },
    "PW-R-010": { common: "CHARGING", raw: "CHARGING", batteryPct: 40 },
    "PW-R-011": { common: "ERROR", raw: "ERROR:CLEAN_WATER_EMPTY", batteryPct: 66 },
    "PW-R-012": { common: "IDLE", raw: "running=false", batteryPct: 91, mapVersionId: "site-03-f1-map-v1" }, // 지도 버전 불일치
    "PW-R-013": { common: "CLEANING", raw: "WORKING", batteryPct: 58, progressPct: 30 },
    "PW-R-014": { common: "RETURNING", raw: "GO_HOME", batteryPct: 22 },
    "PW-R-015": { common: "IDLE", raw: "FREE", batteryPct: null }, // 배터리 미수신
    "PW-R-016": { common: "OFFLINE", raw: "online=false", batteryPct: 12, online: false, lastReceivedAt: addMinutes(nowIso, -60 * 50), dataAt: addMinutes(nowIso, -60 * 50) },
    "PW-R-017": { common: "CHARGING", raw: "CHARGING", batteryPct: 76 },
    "PW-R-018": { common: "UNKNOWN", raw: "", batteryPct: null, online: false, lastReceivedAt: null, dataAt: null, pose: null }, // 데이터 미수신
    "PW-R-019": { common: "CLEANING", raw: "running=true", batteryPct: 69, progressPct: 50 },
    "PW-R-020": { common: "IDLE", raw: "FREE", batteryPct: 100 },
  };

  for (const robot of data.robots) {
    const plan = statusPlan[robot.id];
    const floorZones = data.zones.filter((z) => z.floorId === robot.floorId);
    const zone = pick(rng, floorZones);
    const [cx, cy] = polygonCenter(zone.polygon);
    const hasData = plan.lastReceivedAt !== null;
    const online = plan.online ?? plan.common !== "OFFLINE";
    const status: RobotStatus = {
      robotId: robot.id,
      common: plan.common,
      raw: plan.raw ?? "",
      online,
      batteryPct: plan.batteryPct ?? null,
      pose: plan.pose === null ? null : { x: cx + between(rng, -60, 60), y: cy + between(rng, -40, 40), headingDeg: Math.round(between(rng, 0, 359)) },
      poseIsLastKnown: !online,
      mapVersionId: plan.mapVersionId ?? data.floors.find((f) => f.id === robot.floorId)!.currentMapVersionId,
      currentMissionId: plan.common === "CLEANING" || plan.common === "PAUSED" ? `sample-mission-${robot.id}` : null,
      progressPct: plan.progressPct ?? null,
      lastReceivedAt: hasData ? (plan.lastReceivedAt ?? addMinutes(nowIso, -Math.round(between(rng, 0, 4)))) : null,
      dataAt: hasData ? (plan.dataAt ?? addMinutes(nowIso, -Math.round(between(rng, 0, 4)) - 1)) : null,
    };
    data.statuses[robot.id] = status;
  }

  // ---- 등록 작업 · 예약 · 예정 회차 · 실제 작업 ---------------------------------
  for (const robot of data.robots) {
    const floorZones = data.zones.filter((z) => z.floorId === robot.floorId);
    const zoneIds = floorZones.slice(0, Math.max(2, floorZones.length - 1)).map((z) => z.id);
    const task: RegisteredTask = {
      id: `task-${robot.id}-night`,
      siteId: robot.siteId,
      robotId: robot.id,
      name: `${data.floors.find((f) => f.id === robot.floorId)!.name} 야간 정기 청소`,
      zoneIds,
      mode: robot.model === "L4" ? "SWEEP" : "SWEEP_SCRUB",
      vendorTaskRef: robot.vendor === "CENOBOTS" ? `sample-favorite-${robot.id}` : null,
    };
    data.tasks.push(task);
    const schedule: Schedule = {
      id: `sch-${robot.id}-night`,
      taskId: task.id,
      daysOfWeek: [1, 2, 3, 4, 5, 6],
      time: pick(rng, ["22:00", "22:30", "05:30", "06:00"]),
      enabled: true,
      executor: robot.vendor === "CENOBOTS" ? "VENDOR" : "SELF",
    };
    data.schedules.push(schedule);

    // 두 번째 작업(주간 보충 청소) — 일부 로봇만
    if (["PW-R-001", "PW-R-005", "PW-R-008", "PW-R-010", "PW-R-016", "PW-R-019"].includes(robot.id)) {
      const t2: RegisteredTask = {
        id: `task-${robot.id}-day`,
        siteId: robot.siteId,
        robotId: robot.id,
        name: `${floorZones[0].name} 주간 보충 청소`,
        zoneIds: [floorZones[0].id],
        mode: robot.model === "L4" ? "SWEEP" : "SWEEP",
        vendorTaskRef: robot.vendor === "CENOBOTS" ? `sample-favorite-${robot.id}-day` : null,
      };
      data.tasks.push(t2);
      data.schedules.push({ id: `sch-${robot.id}-day`, taskId: t2.id, daysOfWeek: [1, 3, 5], time: "13:00", enabled: true, executor: schedule.executor });
    }
  }

  // 예정 회차 생성: 전월 1일 ~ 오늘 (사업장 시간대)
  const startKey = `${prevMonth}-01`;
  const dayKeys: string[] = [];
  {
    const [y, m, d] = startKey.split("-").map(Number);
    const cur = new Date(Date.UTC(y, m - 1, d));
    while (true) {
      const key = cur.toISOString().slice(0, 10);
      if (key > today) break;
      dayKeys.push(key);
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }
  const holidayKeys = new Set<string>([`${prevMonth}-15`]); // 가상 휴일(제외일)
  let runSeq = 0;
  for (const schedule of data.schedules) {
    const task = data.tasks.find((t) => t.id === schedule.taskId)!;
    const robot = data.robots.find((r) => r.id === task.robotId)!;
    for (const key of dayKeys) {
      const dow = new Date(`${key}T00:00:00Z`).getUTCDay();
      if (!schedule.daysOfWeek.includes(dow)) continue;
      const plannedAt = localToUtcIso(key, schedule.time, TZ);
      const inPast = plannedAt < nowIso;
      // 실행 당시 사업장: 배치 이력으로 결정
      const placement = data.placements.find((p) => p.robotId === robot.id && p.from <= plannedAt && (p.to === null || plannedAt < p.to));
      const siteIdAtRun = placement?.siteId ?? robot.siteId;
      const planned: PlannedRun = {
        id: `plan-${schedule.id}-${key}`,
        scheduleId: schedule.id,
        taskId: task.id,
        robotId: robot.id,
        siteId: siteIdAtRun,
        plannedAt,
        status: "PLANNED",
        reason: null,
        actualRunId: null,
        changeHistory: [],
      };
      if (holidayKeys.has(key)) {
        planned.status = "EXCLUDED";
        planned.reason = "휴일(샘플 제외일)";
      } else if (inPast) {
        const roll = rng();
        if (roll < 0.86) {
          runSeq += 1;
          const durationMin = Math.round(between(rng, 35, 95));
          const area = Math.round(task.zoneIds.reduce((s, zid) => s + (data.zones.find((z) => z.id === zid)?.areaM2 ?? 0), 0) * between(rng, 0.85, 1.0));
          const run: ActualRun = {
            id: `run-${robot.id}-${runSeq}`,
            vendorRunId: `sample-vrun-${robot.id}-${key}-${schedule.time}`,
            robotId: robot.id,
            siteId: siteIdAtRun,
            floorId: robot.floorId,
            taskId: task.id,
            zoneIds: task.zoneIds,
            startedAt: addMinutes(plannedAt, Math.round(between(rng, 0, 4))),
            endedAt: addMinutes(plannedAt, durationMin),
            result: "COMPLETED",
            endReason: "작업 완료",
            areaM2: area,
            durationMin,
            waterL: robot.vendor === "CENOBOTS" ? Math.round(between(rng, 6, 14) * 10) / 10 : null,
            detergentMl: robot.vendor === "CENOBOTS" ? Math.round(between(rng, 60, 140)) : null,
            origin: "PLANNED",
            receivedAt: addMinutes(plannedAt, durationMin + 2),
          };
          upsertActualRun(data, run);
          planned.status = "DONE";
          planned.actualRunId = run.id;
        } else if (roll < 0.93) {
          runSeq += 1;
          const durationMin = Math.round(between(rng, 10, 30));
          const run: ActualRun = {
            id: `run-${robot.id}-${runSeq}`,
            vendorRunId: `sample-vrun-${robot.id}-${key}-${schedule.time}`,
            robotId: robot.id,
            siteId: siteIdAtRun,
            floorId: robot.floorId,
            taskId: task.id,
            zoneIds: task.zoneIds,
            startedAt: plannedAt,
            endedAt: addMinutes(plannedAt, durationMin),
            result: pick(rng, ["INCOMPLETE", "ABORTED"]),
            endReason: pick(rng, ["배터리 부족", "장애물 감지 후 정지", "오류 발생", "사용자 중단"]),
            areaM2: Math.round(between(rng, 40, 150)),
            durationMin,
            waterL: robot.vendor === "CENOBOTS" ? Math.round(between(rng, 1, 4) * 10) / 10 : null,
            detergentMl: robot.vendor === "CENOBOTS" ? Math.round(between(rng, 10, 40)) : null,
            origin: "PLANNED",
            receivedAt: addMinutes(plannedAt, durationMin + 2),
          };
          upsertActualRun(data, run);
          planned.status = "DONE"; // 수행은 했으나 결과 미완료 — 계획 완료율 분자에서 제외
          planned.actualRunId = run.id;
        } else if (roll < 0.97) {
          planned.status = "MISSED";
          planned.reason = pick(rng, ["로봇 오류 상태", "통신 끊김", "실행 기록 없음"]);
        } else {
          planned.status = "CANCELLED";
          planned.reason = "행사로 취소(샘플)";
          planned.changeHistory.push({ at: addMinutes(plannedAt, -600), by: "u-site-a", from: "PLANNED", to: "CANCELLED", reason: "행사로 취소(샘플)" });
        }
      }
      data.plannedRuns.push(planned);
    }
  }

  // 즉시 지시(ADHOC) 작업 — 계획 완료율에 섞이지 않도록 별도 집계
  for (const robot of data.robots.slice(0, 12)) {
    for (let i = 0; i < 3; i += 1) {
      runSeq += 1;
      const dayKey = pick(rng, dayKeys);
      const startedAt = localToUtcIso(dayKey, pick(rng, ["10:20", "14:10", "16:40"]), TZ);
      if (startedAt > nowIso) continue;
      const placement = data.placements.find((p) => p.robotId === robot.id && p.from <= startedAt && (p.to === null || startedAt < p.to));
      const zone = pick(rng, data.zones.filter((z) => z.floorId === robot.floorId));
      const durationMin = Math.round(between(rng, 15, 40));
      upsertActualRun(data, {
        id: `run-${robot.id}-${runSeq}`,
        vendorRunId: `sample-vrun-adhoc-${robot.id}-${dayKey}-${i}`,
        robotId: robot.id,
        siteId: placement?.siteId ?? robot.siteId,
        floorId: robot.floorId,
        taskId: null,
        zoneIds: [zone.id],
        startedAt,
        endedAt: addMinutes(startedAt, durationMin),
        result: "COMPLETED",
        endReason: "작업 완료",
        areaM2: Math.round(zone.areaM2 * between(rng, 0.8, 1)),
        durationMin,
        waterL: robot.vendor === "CENOBOTS" ? 3.2 : null,
        detergentMl: robot.vendor === "CENOBOTS" ? 30 : null,
        origin: i === 0 ? "REMOTE" : "ADHOC",
        receivedAt: addMinutes(startedAt, durationMin + 1),
      });
    }
  }

  // 중복 실적 수신 시뮬레이션: 같은 vendorRunId 를 다시 넣으면 무시되어야 한다.
  const firstRun = data.actualRuns[0];
  const dupAdded = upsertActualRun(data, { ...firstRun, id: "run-dup-should-not-exist", receivedAt: nowIso });
  if (dupAdded) throw new Error("샘플 생성 오류: 중복 실적이 추가됨");

  // ---- 장애 · 조치 · 알림 --------------------------------------------------------
  const sev = (s: Severity) => s;
  const incidents: Incident[] = [
    {
      id: "inc-001",
      siteId: "site-01",
      robotId: "PW-R-004",
      code: "BRUSH_MOTOR",
      severity: sev("HIGH"),
      rawMessage: "ERR 0x2A31 brush motor overcurrent (raw vendor text, sample)",
      customerMessage: "브러시 구동부 이상으로 작업이 중단되었습니다. 현장 점검 예정입니다.",
      occurredAt: addMinutes(nowIso, -42),
      status: "OPEN",
      acknowledgedAt: null,
      assigneeId: null,
      resolvedAt: null,
      vendorEventId: "sample-evt-0001",
      actions: [],
      notifications: [
        { id: "ntf-001", at: addMinutes(nowIso, -41), channel: "EMAIL", recipient: "site1-manager@example.invalid", status: "MOCK_SENT", reason: "장애 등급 HIGH ≥ 수신 기준" },
        { id: "ntf-002", at: addMinutes(nowIso, -41), channel: "KAKAO", recipient: "010-0000-0001(샘플)", status: "MOCK_SENT", reason: "장애 등급 HIGH ≥ 수신 기준" },
      ],
    },
    {
      id: "inc-002",
      siteId: "site-03",
      robotId: "PW-R-011",
      code: "CLEAN_WATER_EMPTY",
      severity: sev("MEDIUM"),
      rawMessage: "clean water tank empty (sample raw)",
      customerMessage: "청수 보충이 필요하여 작업이 일시 중단되었습니다.",
      occurredAt: addMinutes(nowIso, -130),
      status: "ACKED",
      acknowledgedAt: addMinutes(nowIso, -120),
      assigneeId: null,
      resolvedAt: null,
      vendorEventId: "sample-evt-0002",
      actions: [{ id: "act-001", at: addMinutes(nowIso, -120), userId: "u-site-b", note: "확인. 미화팀에 물 보충 요청.", internal: true }],
      notifications: [{ id: "ntf-003", at: addMinutes(nowIso, -129), channel: "EMAIL", recipient: "site3-manager@example.invalid", status: "MOCK_SENT", reason: "장애 등급 MEDIUM ≥ 수신 기준" }],
    },
    {
      id: "inc-003",
      siteId: "site-04",
      robotId: "PW-R-016",
      code: "COMM_LOST",
      severity: sev("HIGH"),
      rawMessage: "no heartbeat > 24h (server-side detection)",
      customerMessage: "로봇과의 통신이 끊겨 상태를 확인 중입니다.",
      occurredAt: addMinutes(nowIso, -60 * 49),
      status: "IN_PROGRESS",
      acknowledgedAt: addMinutes(nowIso, -60 * 48),
      assigneeId: "u-site-b",
      resolvedAt: null,
      vendorEventId: null,
      actions: [
        { id: "act-002", at: addMinutes(nowIso, -60 * 48), userId: "u-site-b", note: "현장 Wi-Fi AP 점검 요청.", internal: true },
        { id: "act-003", at: addMinutes(nowIso, -60 * 20), userId: "u-site-b", note: "AP 교체 일정 조율 중. 로봇은 수동 충전 상태.", internal: false },
      ],
      notifications: [
        { id: "ntf-004", at: addMinutes(nowIso, -60 * 49), channel: "EMAIL", recipient: "site4-manager@example.invalid", status: "MOCK_SENT", reason: "장애 등급 HIGH ≥ 수신 기준" },
        { id: "ntf-005", at: addMinutes(nowIso, -60 * 48), channel: "KAKAO", recipient: "010-0000-0004(샘플)", status: "SUPPRESSED", reason: "30분 내 동일 장애 중복 억제" },
        { id: "ntf-006", at: addMinutes(nowIso, -60 * 47), channel: "EMAIL", recipient: "hq-ops@example.invalid", status: "MOCK_SENT", reason: "60분 미조치 확대 통보" },
      ],
    },
    {
      id: "inc-004",
      siteId: "site-02",
      robotId: "PW-R-006",
      code: "COMM_LOST",
      severity: sev("MEDIUM"),
      rawMessage: "no heartbeat > 3h",
      customerMessage: "로봇과의 통신이 끊겨 상태를 확인 중입니다.",
      occurredAt: addMinutes(nowIso, -170),
      status: "OPEN",
      acknowledgedAt: null,
      assigneeId: null,
      resolvedAt: null,
      vendorEventId: null,
      actions: [],
      notifications: [{ id: "ntf-007", at: addMinutes(nowIso, -169), channel: "EMAIL", recipient: "site2-manager@example.invalid", status: "MOCK_SENT", reason: "장애 등급 MEDIUM ≥ 수신 기준" }],
    },
    {
      id: "inc-005",
      siteId: "site-05",
      robotId: "PW-R-018",
      code: "NO_DATA",
      severity: sev("LOW"),
      rawMessage: "status never received since registration",
      customerMessage: "로봇 상태 데이터가 수신되지 않고 있습니다.",
      occurredAt: addMinutes(nowIso, -60 * 30),
      status: "ASSIGNED",
      acknowledgedAt: addMinutes(nowIso, -60 * 29),
      assigneeId: "u-site-b",
      resolvedAt: null,
      vendorEventId: null,
      actions: [],
      notifications: [{ id: "ntf-008", at: addMinutes(nowIso, -60 * 30), channel: "EMAIL", recipient: "site5-manager@example.invalid", status: "SUPPRESSED", reason: "수신 시간대(08:00~20:00) 외 — 다음 시간대에 요약 발송" }],
    },
  ];
  // 과거 복구 완료 장애(전월·당월)
  const resolvedTemplates: { siteId: string; robotId: string; code: string; sevv: Severity; cm: string }[] = [
    { siteId: "site-01", robotId: "PW-R-001", code: "OBSTACLE_STUCK", sevv: "MEDIUM", cm: "장애물에 막혀 작업이 중단되었다가 복구되었습니다." },
    { siteId: "site-01", robotId: "PW-R-005", code: "LOW_BATTERY_ABORT", sevv: "LOW", cm: "배터리 부족으로 작업이 조기 종료되었습니다." },
    { siteId: "site-02", robotId: "PW-R-007", code: "DIRTY_WATER_FULL", sevv: "MEDIUM", cm: "오수통 가득 참으로 작업이 중단되었다가 복구되었습니다." },
    { siteId: "site-02", robotId: "PW-R-008", code: "LOCALIZATION_LOST", sevv: "HIGH", cm: "위치 인식 실패로 작업이 중단되었다가 복구되었습니다." },
    { siteId: "site-03", robotId: "PW-R-010", code: "OBSTACLE_STUCK", sevv: "MEDIUM", cm: "장애물에 막혀 작업이 중단되었다가 복구되었습니다." },
    { siteId: "site-04", robotId: "PW-R-014", code: "DIRTY_WATER_FULL", sevv: "MEDIUM", cm: "오수통 가득 참으로 작업이 중단되었다가 복구되었습니다." },
    { siteId: "site-05", robotId: "PW-R-019", code: "OBSTACLE_STUCK", sevv: "LOW", cm: "장애물에 막혀 작업이 중단되었다가 복구되었습니다." },
  ];
  resolvedTemplates.forEach((t, i) => {
    for (const mk of [prevMonth, thisMonth]) {
      const day = Math.min(5 + i * 3, 27);
      const occurredAt = localToUtcIso(`${mk}-${String(day).padStart(2, "0")}`, "23:10", TZ);
      if (occurredAt > nowIso) continue;
      incidents.push({
        id: `inc-r-${mk}-${i}`,
        siteId: t.siteId,
        robotId: t.robotId,
        code: t.code,
        severity: t.sevv,
        rawMessage: `${t.code} (sample raw vendor text)`,
        customerMessage: t.cm,
        occurredAt,
        status: "RESOLVED",
        acknowledgedAt: addMinutes(occurredAt, 12),
        assigneeId: ["site-01", "site-02"].includes(t.siteId) ? "u-site-a" : "u-site-b",
        resolvedAt: addMinutes(occurredAt, 95),
        vendorEventId: `sample-evt-r-${mk}-${i}`,
        actions: [
          { id: `act-r-${mk}-${i}-1`, at: addMinutes(occurredAt, 12), userId: "u-site-a", note: "현장 확인 후 장애물 제거/소모품 처리.", internal: false },
          { id: `act-r-${mk}-${i}-2`, at: addMinutes(occurredAt, 95), userId: "u-site-a", note: "복구 확인. 작업 재개.", internal: false },
        ],
        notifications: [{ id: `ntf-r-${mk}-${i}`, at: addMinutes(occurredAt, 1), channel: "EMAIL", recipient: "manager@example.invalid", status: "MOCK_SENT", reason: "장애 발생 통보" }],
      });
    }
  });
  data.incidents.push(...incidents);

  // ---- 점검 · 유지관리 -------------------------------------------------------------
  const inspectionItems: Record<string, string[]> = {
    MT1: ["청수 보충", "오수 처리", "브러시 청소", "필터 청소"],
    MT1_VAC: ["먼지통 비우기", "브러시 청소", "필터 청소"],
    MT1_MAX: ["청수 보충", "오수 처리", "브러시 청소", "필터 청소"],
    CC1: ["청수 보충", "오수 처리", "브러시 청소"],
    CC1_PRO: ["청수 보충", "오수 처리", "브러시 청소"],
    BG1: ["청수 보충", "오수 처리", "브러시 청소", "흡입구 점검"],
    L4: ["먼지통 비우기", "브러시 청소", "필터 청소"],
    J40: [],
  };
  for (const robot of data.robots) {
    inspectionItems[robot.model].forEach((item, i) => {
      for (const mk of [prevMonth, thisMonth]) {
        for (const d of [7, 21]) {
          const dueAt = localToUtcIso(`${mk}-${String(d).padStart(2, "0")}`, "09:00", TZ);
          const done = dueAt < addMinutes(nowIso, -60 * 24 * 2) && rng() < 0.85;
          const insp: Inspection = {
            id: `insp-${robot.id}-${mk}-${d}-${i}`,
            siteId: robot.siteId,
            robotId: robot.id,
            item,
            dueAt,
            doneAt: done ? addMinutes(dueAt, 90) : null,
            doneBy: done ? (["site-01", "site-02"].includes(robot.siteId) ? "u-site-a" : "u-site-b") : null,
            note: done ? "수기 기록(샘플)" : null,
          };
          data.inspections.push(insp);
        }
      }
    });
    data.maintenance[robot.id] =
      robot.vendor === "CENOBOTS"
        ? [
            { name: "메인 브러시 잔여 수명", remainingPct: Math.round(between(rng, 30, 90)), source: "API" },
            { name: "필터 잔여 수명", remainingPct: Math.round(between(rng, 20, 80)), source: "API" },
            { name: "사이드 브러시 잔여 수명", remainingPct: Math.round(between(rng, 40, 95)), source: "API" },
          ]
        : [
            { name: "브러시 잔여 수명", remainingPct: null, source: "UNSUPPORTED" },
            { name: "필터 잔여 수명", remainingPct: null, source: "UNSUPPORTED" },
            { name: "최근 브러시 교체일(수기)", remainingPct: null, source: "MANUAL" },
          ];
  }

  // ---- 사용자 · 권한 · 알림 설정 · 제조사 연결 ----------------------------------
  data.users.push(
    { id: "u-hq", name: "김본사 (샘플)", email: "hq-admin@example.invalid", role: "HQ_ADMIN", active: true, sitePermissions: [] },
    {
      id: "u-site-a",
      name: "이현장 (샘플)",
      email: "site-a@example.invalid",
      role: "SITE_MANAGER",
      active: true,
      sitePermissions: [
        { siteId: "site-01", allowedCommands: [] },
        { siteId: "site-02", allowedCommands: [] },
      ],
    },
    {
      id: "u-site-b",
      name: "박현장 (샘플)",
      email: "site-b@example.invalid",
      role: "SITE_MANAGER",
      active: true,
      sitePermissions: [
        { siteId: "site-03", allowedCommands: [] },
        { siteId: "site-04", allowedCommands: [] },
        { siteId: "site-05", allowedCommands: [] },
      ],
    },
    { id: "u-cust-1", name: "최고객 (샘플·기본)", email: "customer1@example.invalid", role: "CUSTOMER_BASIC", active: true, sitePermissions: [{ siteId: "site-01", allowedCommands: [] }] },
    {
      id: "u-cust-2",
      name: "정고객 (샘플·제어)",
      email: "customer2@example.invalid",
      role: "CUSTOMER_CONTROL",
      active: true,
      sitePermissions: [{ siteId: "site-02", allowedCommands: ["START_TASK", "PAUSE", "RESUME", "STOP"] }],
    },
    { id: "u-inactive", name: "한퇴직 (샘플·비활성)", email: "former@example.invalid", role: "SITE_MANAGER", active: false, sitePermissions: [{ siteId: "site-01", allowedCommands: [] }] },
  );

  for (const site of data.sites) {
    const n = site.id.slice(-1);
    data.notificationSettings.push({
      siteId: site.id,
      recipients: [
        { id: `rcp-${site.id}-1`, channel: "EMAIL", address: `site${n}-manager@example.invalid`, minSeverity: "MEDIUM", hoursFrom: "00:00", hoursTo: "23:59" },
        { id: `rcp-${site.id}-2`, channel: "KAKAO", address: `010-0000-000${n}(샘플)`, minSeverity: "HIGH", hoursFrom: "08:00", hoursTo: "20:00" },
      ],
      dedupeMinutes: 30,
      escalateAfterMinutes: 60,
    });
  }

  data.vendorConnections.push(
    { id: "vc-sample", vendor: "CENOBOTS", label: "샘플 어댑터(시뮬레이션)", status: "SAMPLE", region: null, notes: "시제품 전용. 실제 API 호출 없음." },
    { id: "vc-cenobots", vendor: "CENOBOTS", label: "CenoBots Open API", status: "NOT_CONFIGURED", region: "미확인(APAC 확정 금지)", notes: "Access Key / Secret Key 는 서버 비밀 설정에만 입력. 3단계에서 연결." },
    { id: "vc-pudu", vendor: "PUDU", label: "PUDU Cloud API", status: "NOT_CONFIGURED", region: null, notes: "MT1·CC1·BG1 모델별 API 규격 검증 전. 6단계에서 연결." },
    { id: "vc-bib", vendor: "BIB", label: "BIB J40", status: "NOT_CONFIGURED", region: null, notes: "연동 검토 보류(후속 단계)." },
  );

  // ---- 명령 이력(샘플) ------------------------------------------------------------
  const cmdBase = {
    params: {},
    vendorTraceId: null,
    simulation: null as Command["simulation"],
  };
  data.commands.push(
    { ...cmdBase, id: "cmd-s-001", userId: "u-site-a", siteId: "site-01", robotId: "PW-R-001", type: "START_TASK", params: { taskId: "task-PW-R-001-night" }, requestedAt: addMinutes(nowIso, -50), expiresAt: addMinutes(nowIso, -45), state: "EXECUTING", stateChangedAt: addMinutes(nowIso, -49), message: "로봇 상태 WORKING 으로 실행 확인", vendorTraceId: "sample-trace-001" },
    { ...cmdBase, id: "cmd-s-002", userId: "u-hq", siteId: "site-02", robotId: "PW-R-006", type: "GO_HOME", requestedAt: addMinutes(nowIso, -175), expiresAt: addMinutes(nowIso, -170), state: "UNKNOWN", stateChangedAt: addMinutes(nowIso, -172), message: "응답 유실(타임아웃). 로봇 상태 확인 후 재시도 판단 필요", vendorTraceId: null },
    { ...cmdBase, id: "cmd-s-003", userId: "u-cust-2", siteId: "site-02", robotId: "PW-R-007", type: "PAUSE", requestedAt: addMinutes(nowIso, -30), expiresAt: addMinutes(nowIso, -25), state: "COMPLETED", stateChangedAt: addMinutes(nowIso, -29), message: "로봇 상태 PAUSED 확인", vendorTraceId: "sample-trace-003" },
    { ...cmdBase, id: "cmd-s-004", userId: "u-site-b", siteId: "site-03", robotId: "PW-R-011", type: "RESUME", requestedAt: addMinutes(nowIso, -100), expiresAt: addMinutes(nowIso, -95), state: "FAILED", stateChangedAt: addMinutes(nowIso, -100), message: "제조사 응답: 오류 상태에서는 재개 불가", vendorTraceId: "sample-trace-004" },
  );

  data.audit.push(
    { id: "aud-s-001", at: addMinutes(nowIso, -50), userId: "u-site-a", userName: "이현장 (샘플)", siteId: "site-01", robotId: "PW-R-001", action: "COMMAND:START_TASK", params: { taskId: "task-PW-R-001-night" }, result: "OK", detail: "접수", vendorTraceId: "sample-trace-001" },
    { id: "aud-s-002", at: addMinutes(nowIso, -175), userId: "u-hq", userName: "김본사 (샘플)", siteId: "site-02", robotId: "PW-R-006", action: "COMMAND:GO_HOME", params: {}, result: "ERROR", detail: "타임아웃 — 결과 불명", vendorTraceId: null },
    { id: "aud-s-003", at: addMinutes(nowIso, -30), userId: "u-cust-2", userName: "정고객 (샘플·제어)", siteId: "site-02", robotId: "PW-R-007", action: "COMMAND:PAUSE", params: {}, result: "OK", detail: "접수", vendorTraceId: "sample-trace-003" },
    { id: "aud-s-004", at: addMinutes(nowIso, -20), userId: "u-cust-1", userName: "최고객 (샘플·기본)", siteId: "site-01", robotId: "PW-R-001", action: "COMMAND:STOP", params: {}, result: "DENIED", detail: "고객 기본 권한은 제어 불가", vendorTraceId: null },
  );

  // ---- 보고서 버전 ------------------------------------------------------------------
  // 가상 사업장 1 전월: 확정본(스냅샷). 확정 후 늦게 수신한 실적 1건을 추가해 "새 버전 작성" 흐름을 보여준다.
  const confirmedAt = localToUtcIso(`${thisMonth}-03`, "15:00", TZ);
  // 샘플 설치일 기준 1개월차 = 전월 1일~말일
  const m1: ReportPeriod = { ...calendarMonthPeriod(prevMonth), seq: 1 };
  const rptId = (siteId: string) => `rpt-${siteId}-monthly-${m1.periodStart}-${m1.periodEnd}-v1`;
  const agg1 = computeAggregates(data, "site-01", m1, confirmedAt);
  data.reports.push({
    id: rptId("site-01"),
    siteId: "site-01",
    ...m1,
    version: 1,
    status: "PUBLISHED",
    aggregates: agg1,
    comments: {
      overallOpinion: "전월 야간 정기 청소는 대체로 계획대로 수행되었습니다. 브러시 장애 1건은 당일 복구했습니다.",
      incompleteReasons: "중순 배터리 부족 조기 종료 1건, 휴일 제외 1일.",
      improvements: "로비 중앙 구역의 장애물(이동식 안내판) 배치를 조정해 주시면 미완료가 줄어듭니다.",
      focusZones: "엘리베이터 홀 — 유동 인구가 많은 시간대 회피 예약 검토.",
      nextMonthPlan: "주간 보충 청소를 주 3회에서 주 4회로 확대 시험.",
    },
    createdAt: localToUtcIso(`${thisMonth}-01`, "09:00", TZ),
    createdBy: "u-site-a",
    reviewedAt: localToUtcIso(`${thisMonth}-02`, "11:00", TZ),
    reviewedBy: "u-hq",
    confirmedAt,
    confirmedBy: "u-hq",
    publishedAt: addMinutes(confirmedAt, 30),
  });
  if (confirmedAt < nowIso) {
    // 확정 후 늦게 수신한 전월 실적 (예: 제조사 서버 지연)
    const lateStart = localToUtcIso(`${prevMonth}-28`, "22:00", TZ);
    upsertActualRun(data, {
      id: "run-late-site-01",
      vendorRunId: "sample-vrun-late-PW-R-002",
      robotId: "PW-R-002",
      siteId: "site-01",
      floorId: "site-01-f1",
      taskId: "task-PW-R-002-night",
      zoneIds: data.tasks.find((t) => t.id === "task-PW-R-002-night")!.zoneIds,
      startedAt: lateStart,
      endedAt: addMinutes(lateStart, 60),
      result: "COMPLETED",
      endReason: "작업 완료",
      areaM2: 610,
      durationMin: 60,
      waterL: null,
      detergentMl: null,
      origin: "PLANNED",
      receivedAt: addMinutes(confirmedAt, 60 * 20),
    });
  }
  // 가상 사업장 2 전월: 검토 중 / 가상 사업장 3 전월: 초안
  data.reports.push({
    id: rptId("site-02"),
    siteId: "site-02",
    ...m1,
    version: 1,
    status: "REVIEW",
    aggregates: computeAggregates(data, "site-02", m1, nowIso),
    comments: { overallOpinion: "물류동 야간 청소 정상. 사무동은 회의실 사용으로 2회 취소.", incompleteReasons: "회의실 야간 사용 2회.", improvements: "", focusZones: "", nextMonthPlan: "" },
    createdAt: localToUtcIso(`${thisMonth}-02`, "09:00", TZ),
    createdBy: "u-site-a",
    reviewedAt: null,
    reviewedBy: null,
    confirmedAt: null,
    confirmedBy: null,
    publishedAt: null,
  });
  data.reports.push({
    id: rptId("site-03"),
    siteId: "site-03",
    ...m1,
    version: 1,
    status: "DRAFT",
    aggregates: computeAggregates(data, "site-03", m1, nowIso),
    comments: { overallOpinion: "", incompleteReasons: "", improvements: "", focusZones: "", nextMonthPlan: "" },
    createdAt: localToUtcIso(`${thisMonth}-02`, "09:30", TZ),
    createdBy: "u-site-b",
    reviewedAt: null,
    reviewedBy: null,
    confirmedAt: null,
    confirmedBy: null,
    publishedAt: null,
  });

  return data;
}
