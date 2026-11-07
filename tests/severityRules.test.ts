import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { effectiveSeverity, listSeverityRules, setSeverityOverride, simulateIncident } from "@/lib/services/incidents";
import { ForbiddenError, ValidationError } from "@/lib/util/errors";
import { getDb, resetAndSeed, schema, user } from "./helpers";

const db = () => getDb();

describe("장애 등급 커스텀(코드별)", () => {
  beforeEach(async () => {
    await resetAndSeed();
  });

  it("본사 관리자만 설정, 설정 등급이 생성 시 적용, 미조치에만 소급, 해제하면 제조사 등급으로 복귀, 감사 기록", async () => {
    const hq = await user("u-hq");
    await expect(setSeverityOverride(await user("u-site-a"), "CleanWaterEmpty", "LOW")).rejects.toThrow(ForbiddenError);
    await expect(setSeverityOverride(hq, "  ", "LOW")).rejects.toThrow(ValidationError);
    // 기본: 제조사 등급 그대로
    expect(await effectiveSeverity("CleanWaterEmpty", "HIGH")).toBe("HIGH");
    // 목록에는 알려진 PUDU 코드·샘플 코드가 있고 설정은 비어 있다
    const before = await listSeverityRules(hq);
    expect(before.some((r) => r.code === "CleanWaterEmpty" && r.severity === null)).toBe(true);
    expect(before.some((r) => r.code === "OBSTACLE_STUCK")).toBe(true);
    // 미조치 장애 2건(샘플 코드) 중 하나는 복구해 둔다
    const a = (await simulateIncident(hq, "PW-R-001", "BRUSH_MOTOR", "HIGH", `sev-a-${Date.now()}`))!;
    const b = (await simulateIncident(hq, "PW-R-002", "BRUSH_MOTOR", "HIGH", `sev-b-${Date.now()}`))!;
    await db().update(schema.incidents).set({ status: "RESOLVED", resolvedAt: new Date().toISOString() }).where(eq(schema.incidents.id, b.id));
    const r = await setSeverityOverride(hq, "BRUSH_MOTOR", "LOW", { note: "현장 자체 처리 가능", applyOpen: true });
    expect(r.updatedOpen).toBeGreaterThanOrEqual(1);
    expect((await db().query.incidents.findFirst({ where: eq(schema.incidents.id, a.id) }))!.severity).toBe("LOW");
    expect((await db().query.incidents.findFirst({ where: eq(schema.incidents.id, b.id) }))!.severity).toBe("HIGH"); // 복구된 이력은 그대로
    expect(await effectiveSeverity("BRUSH_MOTOR", "HIGH")).toBe("LOW");
    const row = (await listSeverityRules(hq)).find((x) => x.code === "BRUSH_MOTOR")!;
    expect(row).toMatchObject({ severity: "LOW", note: "현장 자체 처리 가능" });
    expect(row.recentCount).toBeGreaterThanOrEqual(2);
    // 변경(덮어쓰기)과 해제
    await setSeverityOverride(hq, "BRUSH_MOTOR", "CRITICAL", { applyOpen: false });
    expect(await effectiveSeverity("BRUSH_MOTOR", "HIGH")).toBe("CRITICAL");
    expect((await db().query.incidents.findFirst({ where: eq(schema.incidents.id, a.id) }))!.severity).toBe("LOW"); // 소급 안 함
    await setSeverityOverride(hq, "BRUSH_MOTOR", null);
    expect(await effectiveSeverity("BRUSH_MOTOR", "HIGH")).toBe("HIGH");
    const audits = await db().select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "INCIDENT:SEVERITY_RULE"));
    expect(audits.length).toBe(3);
    expect(audits[0].params).toMatchObject({ code: "BRUSH_MOTOR", severity: "LOW", applyOpen: true });
  });
});
