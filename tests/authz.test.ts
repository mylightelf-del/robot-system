import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getRobotDetail, getSiteView, listRobots } from "@/lib/services/robots";
import { getReport, listReports } from "@/lib/services/reports";
import { issueCommand } from "@/lib/services/commands";
import { listIncidents } from "@/lib/services/incidents";
import { getAdminData } from "@/lib/services/admin";
import { ForbiddenError, NotFoundError } from "@/lib/util/errors";
import { getDb, resetAndSeed, schema, user } from "./helpers";

describe("사업장 범위 · 역할 인가 (서버 검증, DB)", () => {
  beforeAll(async () => {
    await resetAndSeed();
  });

  it("고객 기본 계정은 자기 사업장 로봇만 목록에 나온다", async () => {
    const rows = await listRobots(await user("u-cust-1"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.site.id === "site-01")).toBe(true);
    expect(rows[0].robot.internalNote).toBeUndefined();
    expect(rows[0].robot.vendorRobotId).toBeUndefined();
  });

  it("다른 사업장 로봇 ID 를 직접 지정하면 차단된다(존재 여부 비노출)", async () => {
    await expect(getRobotDetail(await user("u-cust-1"), "PW-R-006")).rejects.toThrow(NotFoundError);
    await expect(getRobotDetail(await user("u-site-a"), "PW-R-010")).rejects.toThrow(NotFoundError);
    await expect(getSiteView(await user("u-cust-1"), "site-02")).rejects.toThrow(ForbiddenError);
  });

  it("다른 사업장 보고서 직접 접근이 차단된다", async () => {
    const prev = (await getDb().select().from(schema.reportVersions).where(eq(schema.reportVersions.siteId, "site-01")))[0];
    await expect(getReport(await user("u-cust-2"), prev.id)).rejects.toThrow(NotFoundError);
    expect((await getReport(await user("u-cust-1"), prev.id)).id).toBe(prev.id);
  });

  it("고객은 확정·공개본만 본다(초안·검토본 비노출)", async () => {
    const s2 = (await getDb().select().from(schema.reportVersions).where(eq(schema.reportVersions.siteId, "site-02")))[0]; // REVIEW
    await expect(getReport(await user("u-cust-2"), s2.id)).rejects.toThrow(NotFoundError);
    expect((await listReports(await user("u-cust-2"))).length).toBe(0);
    expect((await listReports(await user("u-site-a"))).some((r) => r.id === s2.id)).toBe(true);
  });

  it("고객에게 오류 원문·내부 메모·통신 로그를 노출하지 않는다", async () => {
    const inc = (await listIncidents(await user("u-cust-1"), { includeResolved: true })).find((i) => i.id === "inc-001")!;
    expect(inc.rawMessage).toBeNull();
    expect(inc.notifications).toEqual([]);
    const staff = (await listIncidents(await user("u-site-a"), { includeResolved: true })).find((i) => i.id === "inc-001")!;
    expect(staff.rawMessage).toContain("raw");
    const inc3 = (await listIncidents(await user("u-site-b"))).find((i) => i.id === "inc-003")!;
    expect(inc3.actions.some((a) => a.internal)).toBe(true);
    const cust = (await listIncidents(await user("u-site-b"))).length; // 사업장 3·4·5
    expect(cust).toBeGreaterThan(0);
  });

  it("고객 기본 계정의 명령 호출은 서버에서 차단되고 감사 기록에 DENIED 로 남는다", async () => {
    await expect(issueCommand(await user("u-cust-1"), { robotId: "PW-R-001", type: "STOP" })).rejects.toThrow(ForbiddenError);
    const logs = await getDb().select().from(schema.auditLogs).where(eq(schema.auditLogs.userId, "u-cust-1"));
    expect(logs.some((a) => a.action === "COMMAND:STOP" && a.result === "DENIED")).toBe(true);
  });

  it("고객 제어 계정은 부여된 명령만, 자기 사업장에서만 가능하다", async () => {
    const u = await user("u-cust-2"); // site-02, START_TASK/PAUSE/RESUME/STOP
    const cmd = await issueCommand(u, { robotId: "PW-R-008", type: "PAUSE" }); // CLEANING 상태
    expect(cmd.state).toBe("ACCEPTED");
    await expect(issueCommand(u, { robotId: "PW-R-009", type: "GO_HOME" })).rejects.toThrow(ForbiddenError);
    await expect(issueCommand(u, { robotId: "PW-R-001", type: "PAUSE" })).rejects.toThrow(NotFoundError);
  });

  it("비활성화된 사용자는 모든 접근이 차단된다", async () => {
    const u = await user("u-inactive");
    await expect(listRobots(u)).rejects.toThrow(ForbiddenError);
    await expect(getRobotDetail(u, "PW-R-001")).rejects.toThrow(ForbiddenError);
    await expect(issueCommand(u, { robotId: "PW-R-001", type: "PAUSE" })).rejects.toThrow(ForbiddenError);
  });

  it("관리 설정은 본사 관리자만", async () => {
    await expect(getAdminData(await user("u-site-a"))).rejects.toThrow(ForbiddenError);
    await expect(getAdminData(await user("u-cust-1"))).rejects.toThrow(ForbiddenError);
    expect((await getAdminData(await user("u-hq"))).users.length).toBeGreaterThan(0);
  });
});
