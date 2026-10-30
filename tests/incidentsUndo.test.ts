import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { acknowledgeIncident, addIncidentAction, assignIncident, deleteIncidentAction, dismissIncidents, listIncidents, resolveIncident, restoreIncident, revertIncidentStep, simulateIncident } from "@/lib/services/incidents";
import { ForbiddenError, ValidationError } from "@/lib/util/errors";
import { formatDurationMin } from "@/lib/util/time";
import { getDb, resetAndSeed, schema, user } from "./helpers";

const db = () => getDb();
const status = async (id: string) => (await db().query.incidents.findFirst({ where: eq(schema.incidents.id, id) }))!.status;

describe("장애·조치: 단계별 되돌리기 · 알림 삭제", () => {
  beforeEach(async () => {
    await resetAndSeed();
  });

  async function fresh() {
    const inc = await simulateIncident(await user("u-hq"), "PW-R-001", "BRUSH_STUCK", "HIGH", `undo-${Date.now()}-${Math.random()}`);
    return inc!.id;
  }

  it("확인 → 담당 → 조치 → 복구를 한 단계씩 되돌린다(사유 필수, 감사 기록)", async () => {
    const hq = await user("u-hq");
    const id = await fresh();
    await acknowledgeIncident(hq, id);
    await assignIncident(hq, id, "u-site-a");
    await addIncidentAction(hq, id, "현장 확인", true);
    await addIncidentAction(hq, id, "브러시 교체", false);
    await resolveIncident(hq, id, "복구 확인");
    expect(await status(id)).toBe("RESOLVED");
    await expect(revertIncidentStep(hq, id, " ")).rejects.toThrow(ValidationError);

    expect(await revertIncidentStep(hq, id, "복구 아님")).toEqual({ from: "RESOLVED", to: "IN_PROGRESS" });
    let row = (await db().query.incidents.findFirst({ where: eq(schema.incidents.id, id) }))!;
    expect(row.resolvedAt).toBeNull();
    expect((await db().select().from(schema.incidentActions).where(eq(schema.incidentActions.incidentId, id))).map((a) => a.note)).toEqual(["현장 확인", "브러시 교체"]);

    expect((await revertIncidentStep(hq, id, "잘못 씀")).to).toBe("IN_PROGRESS"); // 마지막 조치 취소, 하나 남음
    expect((await revertIncidentStep(hq, id, "잘못 씀")).to).toBe("ASSIGNED");
    expect((await revertIncidentStep(hq, id, "담당 변경")).to).toBe("ACKED");
    expect((await revertIncidentStep(hq, id, "확인 취소")).to).toBe("OPEN");
    row = (await db().query.incidents.findFirst({ where: eq(schema.incidents.id, id) }))!;
    expect(row.assigneeId).toBeNull();
    expect(row.acknowledgedAt).toBeNull();
    await expect(revertIncidentStep(hq, id, "더")).rejects.toThrow(ValidationError);
    const audits = await db().select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "INCIDENT:REVERT"));
    expect(audits.length).toBe(5);
    expect(audits.some((a) => a.detail === "복구 아님")).toBe(true);
  });

  it("조치 기록 하나만 취소하면 남은 기록에 맞춰 상태가 정해진다", async () => {
    const hq = await user("u-hq");
    const id = await fresh();
    await addIncidentAction(hq, id, "오타 메모", true);
    const act = (await db().select().from(schema.incidentActions).where(eq(schema.incidentActions.incidentId, id)))[0];
    await deleteIncidentAction(hq, act.id, "오타");
    expect(await status(id)).toBe("ACKED"); // 조치 등록 때 확인 시각이 채워졌다
  });

  it("불필요한 알림 삭제: 목록·대시보드에서 빠지고, 같은 이벤트는 다시 생기지 않으며, 본사 관리자만 복원", async () => {
    const hq = await user("u-hq");
    const siteA = await user("u-site-a");
    const eventId = "dismiss-evt-1";
    const inc = await simulateIncident(hq, "PW-R-001", "LOW_BATTERY", "LOW", eventId);
    await expect(dismissIncidents(siteA, [inc!.id], "")).rejects.toThrow(ValidationError);
    await expect(dismissIncidents(await user("u-cust-1"), [inc!.id], "x")).rejects.toThrow(ForbiddenError);
    expect(await dismissIncidents(siteA, [inc!.id], "정상 동작 중 경고")).toBe(1);
    expect((await listIncidents(hq)).some((i) => i.id === inc!.id)).toBe(false);
    const dismissed = await listIncidents(hq, { dismissed: true });
    expect(dismissed.find((i) => i.id === inc!.id)?.dismissReason).toBe("정상 동작 중 경고");
    expect(await simulateIncident(hq, "PW-R-001", "LOW_BATTERY", "LOW", eventId)).toBeNull(); // 같은 제조사 이벤트 재수신 → 무시
    await expect(acknowledgeIncident(hq, inc!.id)).rejects.toThrow(ValidationError);
    await expect(restoreIncident(siteA, inc!.id)).rejects.toThrow();
    await restoreIncident(hq, inc!.id);
    expect((await listIncidents(hq)).some((i) => i.id === inc!.id)).toBe(true);
  });

  it("경과 시간 표시: 분 → 시간 → 일", () => {
    expect(formatDurationMin(45)).toBe("45분");
    expect(formatDurationMin(60)).toBe("1시간");
    expect(formatDurationMin(135)).toBe("2시간 15분");
    expect(formatDurationMin(1440)).toBe("1일");
    expect(formatDurationMin(1500)).toBe("1일 1시간");
    expect(formatDurationMin(60 * 24 * 3 + 30)).toBe("3일");
  });
});
