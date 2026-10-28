/**
 * PUDU 명령 실기 시험(실제 로봇을 움직인다!). 우리 시스템의 명령 경로(issueCommand → PuduAdapter → 폴링 확인)를 그대로 쓴다.
 * 사용: VENDOR_MODE=live npm run pudu:command-test -- <내부 관리번호> <등록 작업 ID> --yes [--user 이메일] [--skip-start]
 *  --skip-start: 이미 청소 중인 로봇에 대해 일시정지부터 시작한다(작업 실행 생략).
 * 안전 장치:
 *  - --yes 가 없으면 사전 점검만 하고 끝낸다.
 *  - 로봇이 온라인 + 충전 중(task 202/203, is_charging=1) + 배터리 30% 이상 + 진행 중 작업 없음일 때만 시작한다(사용자 결정: "충전 중일 때만").
 *  - 순서: 작업 실행 → 일시정지 → 재개 → 중단 → 복귀. 각 단계는 폴링으로 실행 확인을 기다리고, 실패·시간 초과 시 즉시 중단·복귀를 보낸다.
 *  - 모든 명령은 감사 이력·명령 이력에 남는다(실제 운영과 동일).
 */
import { eq } from "drizzle-orm";
import { closeDb, getDb, schema } from "@/lib/db/client";
import { getUser } from "@/lib/db/repo";
import { issueCommand } from "@/lib/services/commands";
import { PuduAdapter, createPuduApi } from "@/lib/vendors/pudu/puduAdapter";
import { pollRobotStatus } from "@/worker/pudu";
import type { CommandType } from "@/lib/domain/types";

const args = process.argv.slice(2);
const robotId = args[0];
const taskId = args[1];
const yes = args.includes("--yes");
const skipStart = args.includes("--skip-start");
const userEmail = args[args.indexOf("--user") + 1] && args.includes("--user") ? args[args.indexOf("--user") + 1] : "hq-admin@example.invalid";
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!robotId || !taskId) {
    console.error("사용: npm run pudu:command-test -- <robotId> <taskId> --yes");
    process.exit(2);
  }
  const db = getDb();
  const robot = (await db.query.robots.findFirst({ where: eq(schema.robots.id, robotId) }))!;
  if (!robot || robot.vendor !== "PUDU" || robot.vendorMeta?.source !== "api") throw new Error("PUDU API 로 등록한 로봇이 아닙니다");
  const task = await db.query.registeredTasks.findFirst({ where: eq(schema.registeredTasks.id, taskId) });
  if (!task?.vendorTaskRef || task.robotId !== robot.id) throw new Error("이 로봇의 PUDU 등록 작업이 아닙니다");
  const userRow = await db.query.users.findFirst({ where: eq(schema.users.email, userEmail) });
  const user = userRow ? await getUser(userRow.id, db) : undefined;
  if (!user) throw new Error(`사용자를 찾을 수 없습니다: ${userEmail}`);
  const api = createPuduApi();
  const adapter = new PuduAdapter(api);

  // 사전 점검
  const v2 = await api.statusV2(robot.vendorRobotId);
  const d = await api.cleanDetail(robot.vendorRobotId);
  // 실기: 도킹 직후에는 task=202 인데 V2 의 is_charging 이 -1 로 남아 있기도 하다 → 둘 중 하나면 충전 중으로 본다
  const charging = d.cleanbot?.task === 202 || d.cleanbot?.task === 203 || v2.is_charging === 1;
  log(`사전 점검: ${robot.id} ${robot.name} sn=${robot.vendorRobotId} run_state=${v2.run_state} online=${d.online} task=${d.cleanbot?.task} is_charging=${v2.is_charging} battery=${d.battery} map=${d.map?.name} 진행 중=${d.cleanbot?.clean ? "있음" : "없음"}`);
  log(`시험 작업: ${task.name} (${task.vendorTaskRef})`);
  const okToStart = skipStart
    ? v2.run_state !== "OFFLINE" && d.online !== false && !!d.cleanbot?.clean
    : v2.run_state !== "OFFLINE" && d.online !== false && charging && (d.battery ?? 0) >= 30 && !d.cleanbot?.clean;
  if (!okToStart) {
    log(skipStart ? "조건 불충족(온라인·진행 중 작업 있음) — --skip-start 는 청소 중인 로봇에만 씁니다." : "조건 불충족(온라인·충전 중·배터리 30%↑·진행 중 작업 없음) — 시작하지 않습니다.");
    process.exit(1);
  }
  if (!yes) {
    log("조건 충족. 실제로 보내려면 --yes 를 붙이세요.");
    return;
  }
  await pollRobotStatus(robot, adapter);

  const current = async () => (await db.query.robotStatus.findFirst({ where: eq(schema.robotStatus.robotId, robot.id) }))!;
  const cmdRow = async (id: string) => (await db.query.commands.findFirst({ where: eq(schema.commands.id, id) }))!;
  const waitFor = async (label: string, pred: (common: string) => boolean, maxSec: number): Promise<string> => {
    const t0 = Date.now();
    while (Date.now() - t0 < maxSec * 1000) {
      await sleep(5000);
      await pollRobotStatus(robot, adapter);
      const st = await current();
      log(`  폴링: ${st.common} (${st.raw}) 진행 ${st.progressPct ?? "-"}%`);
      if (pred(st.common)) return st.common;
    }
    throw new Error(`${label}: ${maxSec}초 안에 기대 상태가 되지 않음`);
  };
  const step = async (type: CommandType, params: Record<string, unknown>, expect: (c: string) => boolean, maxSec: number) => {
    const t0 = Date.now();
    const c = await issueCommand(user, { robotId: robot.id, type, params });
    log(`${type}: 접수 결과 state=${c.state} trace=${c.vendorTraceId ?? "-"} msg=${c.message}`);
    if (c.state === "FAILED" || c.state === "UNKNOWN") throw new Error(`${type} 전송 실패: ${c.message}`);
    const reached = await waitFor(type, expect, maxSec);
    const row = await cmdRow(c.id);
    log(`${type}: 로봇 상태 ${reached} 도달 (${Math.round((Date.now() - t0) / 1000)}초), 명령 이력 state=${row.state} msg=${row.message}`);
    return c;
  };

  // 실기: 시작 직후(코드 304, 진행 0%)에는 일시정지가 CLEANBOT_NOT_IN_THE_CLEANING_STATE 로 거부된다 → 302 + 진행률 보고까지 기다린다
  const waitPausable = async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 240_000) {
      await sleep(5000);
      await pollRobotStatus(robot, adapter);
      const st = await current();
      log(`  청소 진입 대기: ${st.common} (${st.raw}) 진행 ${st.progressPct ?? "-"}%`);
      if (st.raw.includes("task=302") && (st.progressPct ?? 0) > 0) return;
    }
    throw new Error("240초 안에 일시정지 가능한 청소 상태(302 + 진행률)가 되지 않음");
  };
  try {
    if (!skipStart) await step("START_TASK", { taskId: task.id }, (c) => c === "CLEANING", 120);
    await waitPausable();
    await step("PAUSE", {}, (c) => c === "PAUSED", 60);
    await sleep(10000);
    await step("RESUME", {}, (c) => c === "CLEANING", 90);
    await sleep(15000);
    await step("STOP", {}, (c) => c !== "CLEANING" && c !== "PAUSED", 90);
    await sleep(5000);
    const st = await current();
    if (st.common !== "CHARGING" && st.common !== "RETURNING") {
      await step("GO_HOME", {}, (c) => c === "CHARGING", 300);
    } else {
      log(`중단 후 로봇이 스스로 ${st.common} 상태 — 복귀 명령 생략, 충전 도달 대기`);
      await waitFor("복귀 대기", (c) => c === "CHARGING", 300);
    }
    log("시험 완료: 작업 실행 → 일시정지 → 재개 → 중단 → 복귀");
  } catch (e) {
    log(`오류: ${(e as Error).message} — 안전을 위해 중단·복귀를 보냅니다`);
    try {
      const st = await current();
      if (st.common === "CLEANING" || st.common === "PAUSED") await issueCommand(user, { robotId: robot.id, type: "STOP", params: {} });
      await sleep(5000);
      await pollRobotStatus(robot, adapter);
      const st2 = await current();
      if (st2.common !== "CHARGING" && st2.common !== "RETURNING") await issueCommand(user, { robotId: robot.id, type: "GO_HOME", params: {} });
      await waitFor("복귀 대기", (c) => c === "CHARGING", 300);
    } catch (e2) {
      log(`복귀 시도 중 오류: ${(e2 as Error).message} — 현장 확인 필요`);
    }
    process.exitCode = 1;
  } finally {
    const rows = await db.select().from(schema.commands).where(eq(schema.commands.robotId, robot.id));
    log("명령 이력:");
    for (const r of rows.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)).slice(-8)) console.log(`  ${r.requestedAt} ${r.type} ${r.state} trace=${r.vendorTraceId ?? "-"} ${r.message}`);
    await closeDb();
  }
}

main().catch(async (e) => {
  console.error("실패:", e?.message ?? e);
  await closeDb();
  process.exit(1);
});
