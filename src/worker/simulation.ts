import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import { getRobot, listZonesByFloor, loadSettings, toStatus } from "@/lib/db/repo";
import { advanceCommand, applyHeartbeat } from "@/lib/vendors/sample/simulation";
import { nowIso } from "@/lib/util/time";

let lastTickAt: string | null = null;

/**
 * DB 기반 시뮬레이션 틱(샘플 모드 전용). 워커가 주기적으로 호출한다.
 * 1) 처리 중(ACCEPTED/EXECUTING) 시뮬레이션 명령을 진행시키고 상태·실적을 저장한다.
 * 2) 온라인 로봇의 하트비트·배터리·진행률을 갱신한다.
 */
export async function simulationTick(now: string = nowIso()): Promise<{ commands: number; statuses: number; runs: number }> {
  const db = getDb();
  const settings = await loadSettings(db);
  const elapsedMin = lastTickAt ? Math.max(0, (new Date(now).getTime() - new Date(lastTickAt).getTime()) / 60000) : 0;
  lastTickAt = now;
  let commands = 0;
  let statuses = 0;
  let runs = 0;

  const pending = await db
    .select()
    .from(schema.commands)
    .where(and(isNotNull(schema.commands.simulation), inArray(schema.commands.state, ["ACCEPTED", "EXECUTING"])))
    .orderBy(schema.commands.requestedAt);
  const robotsWithSimMission = new Set<string>();

  for (const row of pending) {
    const robot = await getRobot(row.robotId, db);
    const stRow = await db.query.robotStatus.findFirst({ where: eq(schema.robotStatus.robotId, row.robotId) });
    if (!robot || !stRow) continue;
    const st = toStatus(stRow);
    const { idempotencyKey: _k, ...cmd } = row;
    const task = cmd.type === "START_TASK" ? await db.query.registeredTasks.findFirst({ where: eq(schema.registeredTasks.id, String(cmd.params.taskId)) }) : null;
    const zones = await listZonesByFloor(robot.floorId, db);
    const res = advanceCommand(cmd, st, { robot, taskZoneIds: task?.zoneIds ?? null, zones, acceptedTimeoutSeconds: settings.commandAcceptedTimeoutSeconds }, now);
    if (cmd.state === "EXECUTING" && (cmd.type === "START_TASK" || cmd.type === "AREA_CLEAN")) robotsWithSimMission.add(robot.id);
    await db.transaction(async (tx) => {
      if (res.commandChanged) {
        await tx.update(schema.commands).set({ state: cmd.state, stateChangedAt: cmd.stateChangedAt, message: cmd.message }).where(eq(schema.commands.id, cmd.id));
        commands += 1;
      }
      if (res.statusChanged) {
        await tx.update(schema.robotStatus).set(st).where(eq(schema.robotStatus.robotId, st.robotId));
        statuses += 1;
      }
      if (res.newRun) {
        const inserted = await tx
          .insert(schema.actualRuns)
          .values({ ...res.newRun, vendor: robot.vendor, vendorRobotId: robot.vendorRobotId })
          .onConflictDoNothing({ target: [schema.actualRuns.vendor, schema.actualRuns.vendorRobotId, schema.actualRuns.vendorRunId] })
          .returning({ id: schema.actualRuns.id });
        runs += inserted.length;
      }
    });
  }

  // 하트비트(온라인 로봇)
  const online = await db.select().from(schema.robotStatus).where(eq(schema.robotStatus.online, true));
  for (const row of online) {
    const st = toStatus(row);
    if (applyHeartbeat(st, elapsedMin, robotsWithSimMission.has(st.robotId), now)) {
      await db.update(schema.robotStatus).set(st).where(eq(schema.robotStatus.robotId, st.robotId));
      statuses += 1;
    }
  }
  return { commands, statuses, runs };
}
