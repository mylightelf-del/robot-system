import { beforeEach, describe, expect, it } from "vitest";
import { resetStore, getStore } from "@/lib/store/store";
import { getRobotDetail, getSiteView, listRobots } from "@/lib/services/robots";
import { getReport, listReports } from "@/lib/services/reports";
import { issueCommand } from "@/lib/services/commands";
import { listIncidents } from "@/lib/services/incidents";
import { getAdminData } from "@/lib/services/admin";
import { ForbiddenError, NotFoundError } from "@/lib/util/errors";
import type { User } from "@/lib/domain/types";

const user = (id: string): User => getStore().users.find((u) => u.id === id)!;

describe("사업장 범위 · 역할 인가 (서버 검증)", () => {
  beforeEach(() => {
    resetStore();
  });

  it("고객 기본 계정은 자기 사업장 로봇만 목록에 나온다", () => {
    const rows = listRobots(user("u-cust-1"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.site.id === "site-01")).toBe(true);
    // 고객에게는 내부 메모·제조사 ID 가 제거된다
    expect(rows[0].robot.internalNote).toBeUndefined();
    expect(rows[0].robot.vendorRobotId).toBeUndefined();
  });

  it("다른 사업장 로봇 ID 를 직접 지정하면 차단된다(존재 여부 비노출)", () => {
    expect(() => getRobotDetail(user("u-cust-1"), "PW-R-006")).toThrow(NotFoundError);
    expect(() => getRobotDetail(user("u-site-a"), "PW-R-010")).toThrow(NotFoundError); // 현장 A 는 사업장 1,2 만
    expect(() => getSiteView(user("u-cust-1"), "site-02")).toThrow(ForbiddenError);
  });

  it("다른 사업장 보고서 파일 직접 접근이 차단된다", () => {
    const prev = getStore().reports.find((r) => r.siteId === "site-01")!;
    expect(() => getReport(user("u-cust-2"), prev.id)).toThrow(NotFoundError); // 고객 2 는 사업장 2
    expect(getReport(user("u-cust-1"), prev.id).id).toBe(prev.id);
  });

  it("고객은 확정·공개본만 본다(초안·검토본 비노출)", () => {
    const s2 = getStore().reports.find((r) => r.siteId === "site-02")!; // REVIEW
    expect(() => getReport(user("u-cust-2"), s2.id)).toThrow(NotFoundError);
    expect(listReports(user("u-cust-2")).length).toBe(0);
    expect(listReports(user("u-site-a")).some((r) => r.id === s2.id)).toBe(true);
  });

  it("고객에게 오류 원문·내부 메모·통신 로그를 노출하지 않는다", () => {
    const inc = listIncidents(user("u-cust-1"), { includeResolved: true }).find((i) => i.id === "inc-001")!;
    expect(inc.rawMessage).toBeNull();
    expect(inc.notifications).toEqual([]);
    const staff = listIncidents(user("u-site-a"), { includeResolved: true }).find((i) => i.id === "inc-001")!;
    expect(staff.rawMessage).toContain("raw");
    const inc3 = listIncidents(user("u-site-b")).find((i) => i.id === "inc-003")!;
    expect(inc3.actions.some((a) => a.internal)).toBe(true);
  });

  it("고객 기본 계정의 명령 호출은 서버에서 차단되고 감사 기록에 DENIED 로 남는다", async () => {
    await expect(issueCommand(user("u-cust-1"), { robotId: "PW-R-001", type: "STOP" })).rejects.toThrow(ForbiddenError);
    const log = getStore().audit.find((a) => a.userId === "u-cust-1" && a.action === "COMMAND:STOP" && a.result === "DENIED");
    expect(log).toBeDefined();
  });

  it("고객 제어 계정은 부여된 명령만, 자기 사업장에서만 가능하다", async () => {
    const u = user("u-cust-2"); // site-02, START_TASK/PAUSE/RESUME/STOP
    const cmd = await issueCommand(u, { robotId: "PW-R-008", type: "PAUSE" }); // CLEANING 상태
    expect(cmd.state).toBe("ACCEPTED");
    await expect(issueCommand(u, { robotId: "PW-R-009", type: "GO_HOME" })).rejects.toThrow(ForbiddenError); // 미부여 명령
    await expect(issueCommand(u, { robotId: "PW-R-001", type: "PAUSE" })).rejects.toThrow(NotFoundError); // 타 사업장
  });

  it("비활성화된 사용자는 모든 접근이 차단된다", async () => {
    const u = user("u-inactive");
    expect(() => listRobots(u)).toThrow(ForbiddenError);
    expect(() => getRobotDetail(u, "PW-R-001")).toThrow(ForbiddenError);
    await expect(issueCommand(u, { robotId: "PW-R-001", type: "PAUSE" })).rejects.toThrow(ForbiddenError);
  });

  it("관리 설정은 본사 관리자만", () => {
    expect(() => getAdminData(user("u-site-a"))).toThrow(ForbiddenError);
    expect(() => getAdminData(user("u-cust-1"))).toThrow(ForbiddenError);
    expect(getAdminData(user("u-hq")).users.length).toBeGreaterThan(0);
  });
});
