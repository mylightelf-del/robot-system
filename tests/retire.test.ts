import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, gt } from "drizzle-orm";
import { restoreSite, retireSite, setRobotActive } from "@/lib/services/admin";
import { accessibleSiteIds } from "@/lib/auth/authz";
import { getDashboard } from "@/lib/services/dashboard";
import { getRobotDetail, listRobots, listSites } from "@/lib/services/robots";
import { issueCommand } from "@/lib/services/commands";
import { escalateOverdueIncidents } from "@/lib/services/incidents";
import { autoCreateScheduledDrafts } from "@/lib/services/reports";
import { nowIso } from "@/lib/util/time";
import { getDb, resetAndSeed, schema, setRobotStatus, user } from "./helpers";

const db = () => getDb();

describe("로봇 사용 중지 · 사업장 사용 중지(이력 보존)", () => {
  beforeEach(async () => {
    await resetAndSeed();
  });

  it("로봇 사용 중지: 사유 필수, 목록·대시보드·명령에서 빠지고 이력은 남는다, 미래 예정 회차 취소, 다시 사용 가능", async () => {
    const hq = await user("u-hq");
    const siteMgr = await user("u-site-a");
    const robotId = "PW-R-003";
    const runsBefore = (await db().select().from(schema.actualRuns).where(eq(schema.actualRuns.robotId, robotId))).length;
    expect(runsBefore).toBeGreaterThan(0);
    const futureBefore = await db().select().from(schema.plannedRuns).where(and(eq(schema.plannedRuns.robotId, robotId), eq(schema.plannedRuns.status, "PLANNED"), gt(schema.plannedRuns.plannedAt, nowIso())));

    await expect(setRobotActive(siteMgr, robotId, false, "현장 판단")).rejects.toThrow(); // 본사 관리자만
    await expect(setRobotActive(hq, robotId, false)).rejects.toThrow(/사유/);
    await setRobotStatus(robotId, { common: "CLEANING" });
    await expect(setRobotActive(hq, robotId, false, "미사용")).rejects.toThrow(/작업 중/);
    await setRobotStatus(robotId, { common: "IDLE" });
    await setRobotActive(hq, robotId, false, "더 이상 사용하지 않는 기기");

    const robot = (await db().query.robots.findFirst({ where: eq(schema.robots.id, robotId) }))!;
    expect(robot.active).toBe(false);
    expect((await listRobots(hq)).some((r) => r.robot.id === robotId)).toBe(false);
    expect((await listRobots(hq, undefined, { includeInactive: true })).some((r) => r.robot.id === robotId)).toBe(true);
    const site01 = (await getDashboard(hq)).sites.find((s) => s.siteId === "site-01")!;
    expect(site01.robotCount).toBe((await db().select().from(schema.robots).where(eq(schema.robots.siteId, "site-01"))).length - 1);
    // 상세는 열리되(이력) 명령은 없음
    const detail = await getRobotDetail(hq, robotId);
    expect(detail.allowedCommands).toEqual([]);
    expect(detail.runs.length).toBeGreaterThan(0);
    await expect(issueCommand(hq, { robotId, type: "START_TASK", params: { taskId: "task-PW-R-003-night" } })).rejects.toThrow(/사용 중지/);
    const denied = (await db().select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "COMMAND:START_TASK"))).at(-1)!;
    expect(denied).toMatchObject({ result: "DENIED", detail: "사용 중지된 로봇" });
    // 이력 보존 · 예정 회차 취소
    expect((await db().select().from(schema.actualRuns).where(eq(schema.actualRuns.robotId, robotId))).length).toBe(runsBefore);
    const future = await db().select().from(schema.plannedRuns).where(and(eq(schema.plannedRuns.robotId, robotId), gt(schema.plannedRuns.plannedAt, nowIso())));
    expect(future.filter((p) => p.status === "PLANNED")).toHaveLength(0);
    expect(future.filter((p) => p.reason === "로봇 사용 중지")).toHaveLength(futureBefore.length);
    const a = (await db().select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "ROBOT:DEACTIVATE"))).at(-1)!;
    expect(a).toMatchObject({ robotId, detail: "더 이상 사용하지 않는 기기", result: "OK" });
    expect(a.params).toMatchObject({ cancelledPlannedRuns: futureBefore.length });

    await setRobotActive(hq, robotId, true, "재사용");
    expect((await db().query.robots.findFirst({ where: eq(schema.robots.id, robotId) }))!.active).toBe(true);
    expect((await listRobots(hq)).some((r) => r.robot.id === robotId)).toBe(true);
    expect((await db().select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "ROBOT:ACTIVATE"))).length).toBe(1);
  });

  it("사업장 사용 중지: 권한 계산·목록·대시보드·보고서 일정·확대 통보에서 빠지고 로봇 전부 중지, 이력 보존, 다시 사용 시 로봇은 중지 상태 유지", async () => {
    const hq = await user("u-hq");
    const siteId = "site-02";
    const robotsBefore = await db().select().from(schema.robots).where(eq(schema.robots.siteId, siteId));
    expect(robotsBefore.some((r) => r.active)).toBe(true);
    const runsBefore = (await db().select().from(schema.actualRuns).where(eq(schema.actualRuns.siteId, siteId))).length;
    const incidentsBefore = (await db().select().from(schema.incidents).where(eq(schema.incidents.siteId, siteId))).length;
    const reportsBefore = (await db().select().from(schema.reportVersions).where(eq(schema.reportVersions.siteId, siteId))).length;
    expect(runsBefore).toBeGreaterThan(0);

    await expect(retireSite(await user("u-site-b"), siteId, "x")).rejects.toThrow();
    await expect(retireSite(hq, siteId)).rejects.toThrow(/사유/);
    const r = await retireSite(hq, siteId, "사용하지 않는 사업장");
    expect(r.robots).toBe(robotsBefore.filter((x) => x.active).length);

    const site = (await db().query.sites.findFirst({ where: eq(schema.sites.id, siteId) }))!;
    expect(site.retiredAt).toBeTruthy();
    expect(site.remoteControlEnabled).toBe(false);
    expect(await accessibleSiteIds(hq)).not.toContain(siteId);
    expect((await listSites(hq)).some((s) => s.id === siteId)).toBe(false);
    expect((await getDashboard(hq)).sites.some((s) => s.siteId === siteId)).toBe(false);
    expect((await listRobots(hq, undefined, { includeInactive: true })).some((x) => x.site.id === siteId)).toBe(false);
    await expect(listRobots(hq, siteId)).rejects.toThrow(); // 접근 불가 취급
    for (const rb of await db().select().from(schema.robots).where(eq(schema.robots.siteId, siteId))) expect(rb.active).toBe(false);
    expect(await db().select().from(schema.plannedRuns).where(and(eq(schema.plannedRuns.siteId, siteId), eq(schema.plannedRuns.status, "PLANNED"), gt(schema.plannedRuns.plannedAt, nowIso())))).toHaveLength(0);
    // 이력 보존
    expect((await db().select().from(schema.actualRuns).where(eq(schema.actualRuns.siteId, siteId))).length).toBe(runsBefore);
    expect((await db().select().from(schema.incidents).where(eq(schema.incidents.siteId, siteId))).length).toBe(incidentsBefore);
    expect((await db().select().from(schema.reportVersions).where(eq(schema.reportVersions.siteId, siteId))).length).toBe(reportsBefore);
    // 보고서 일정·확대 통보 제외
    await db().update(schema.sites).set({ installedOn: nowIso().slice(0, 10) }).where(eq(schema.sites.id, siteId));
    await db().delete(schema.reportVersions).where(eq(schema.reportVersions.siteId, siteId));
    expect((await autoCreateScheduledDrafts()).created.some((id) => id.includes(siteId))).toBe(false);
    await db().update(schema.notificationSettings).set({ escalateAfterMinutes: 1 }).where(eq(schema.notificationSettings.siteId, siteId));
    await db().delete(schema.notificationLogs);
    await db().update(schema.incidents).set({ status: "OPEN", occurredAt: nowIso() }).where(eq(schema.incidents.siteId, siteId));
    await escalateOverdueIncidents(new Date(Date.now() + 10 * 60_000).toISOString());
    const logs = await db().select().from(schema.notificationLogs);
    const siteIncidentIds = new Set((await db().select({ id: schema.incidents.id }).from(schema.incidents).where(eq(schema.incidents.siteId, siteId))).map((x) => x.id));
    expect(logs.some((l) => l.incidentId && siteIncidentIds.has(l.incidentId))).toBe(false);
    const a = (await db().select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "SITE:RETIRE"))).at(-1)!;
    expect(a).toMatchObject({ siteId, detail: "사용하지 않는 사업장" });
    await expect(retireSite(hq, siteId, "다시")).rejects.toThrow(/이미/);

    await restoreSite(hq, siteId, "재가동");
    expect((await db().query.sites.findFirst({ where: eq(schema.sites.id, siteId) }))!.retiredAt).toBeNull();
    expect(await accessibleSiteIds(hq)).toContain(siteId);
    for (const rb of await db().select().from(schema.robots).where(eq(schema.robots.siteId, siteId))) expect(rb.active).toBe(false);
    expect((await db().select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "SITE:RESTORE"))).length).toBe(1);
  });
});
