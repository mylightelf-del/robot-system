import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { addPhoto, adjustNumber, confirmReport, createDraft, createNextVersion, deletePhoto, effectiveAggregates, getPhotoData, getReport, listPhotos, publishReport, submitForReview, updateComments, updateContent } from "@/lib/services/reports";
import { applyAdjustments } from "@/lib/reports/adjust";
import { buildPptx, buildXlsx } from "@/lib/reports/export";
import { deleteFloor, updateSite } from "@/lib/services/sites";
import { periodKey, reportSchedule } from "@/lib/reports/schedule";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/util/errors";
import { localDateKey, nowIso } from "@/lib/util/time";
import { getDb, resetAndSeed, schema, user } from "./helpers";

const db = () => getDb();

describe("보고서 수정·사진·내보내기", () => {
  beforeEach(async () => {
    await resetAndSeed();
  });

  async function weeklyDraft() {
    const s1 = (await db().query.sites.findFirst({ where: eq(schema.sites.id, "site-01") }))!;
    const w1 = reportSchedule(s1.installedOn!, localDateKey(nowIso())).find((e) => e.kind === "WEEKLY")!;
    return createDraft(await user("u-hq"), "site-01", periodKey(w1));
  }

  it("수치 수정: 원래 값 보존, 보정값 반영(완료율 재계산), 되돌리기, 잘못된 키·음수 거절, 확정 뒤 불가", async () => {
    const hq = await user("u-hq");
    const r = await weeklyDraft();
    await adjustNumber(hq, r.id, "summary.totalRuns", 99);
    await adjustNumber(hq, r.id, "summary.plannedCompleted", 1);
    const floorId = r.aggregates.byFloor[0].floorId;
    await adjustNumber(hq, r.id, `byFloor.${floorId}.areaM2`, 1234);
    await expect(adjustNumber(hq, r.id, "summary.nope", 1)).rejects.toThrow(ValidationError);
    await expect(adjustNumber(hq, r.id, "summary.totalRuns", -1)).rejects.toThrow(ValidationError);
    await expect(adjustNumber(await user("u-cust-1"), r.id, "summary.totalRuns", 1)).rejects.toThrow();
    const row = await getReport(hq, r.id);
    expect(row.aggregates.totalRuns).toBe(r.aggregates.totalRuns); // 원래 집계는 그대로
    const eff = effectiveAggregates(row);
    expect(eff.totalRuns).toBe(99);
    expect(eff.byFloor[0].areaM2).toBe(1234);
    expect(eff.completionRatePct).toBe(Math.round((1 / eff.validPlanned) * 1000) / 10);
    expect(row.adjustments["summary.totalRuns"].original).toBe(r.aggregates.totalRuns);
    await adjustNumber(hq, r.id, "summary.totalRuns", null);
    expect((await getReport(hq, r.id)).adjustments["summary.totalRuns"]).toBeUndefined();
    expect((await db().select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "REPORT:ADJUST"))).length).toBe(4);
    // 확정 뒤에는 고칠 수 없고, 새 버전은 보정값을 이어받지 않는다(새 집계가 기준)
    await updateComments(hq, r.id, { overallOpinion: "정상" });
    await submitForReview(hq, r.id);
    await confirmReport(hq, r.id);
    await expect(adjustNumber(hq, r.id, "summary.totalRuns", 5)).rejects.toThrow(ValidationError);
    const v2 = await createNextVersion(hq, r.id);
    expect(v2.adjustments).toEqual({});
    expect(applyAdjustments(v2.aggregates, {})).toBe(v2.aggregates);
  });

  it("설치 보고서: 기본 단계 일정·작업 일지, 지도·주간 예약 스냅샷, 사진 올리기·권한·확정 뒤 고정", async () => {
    const hq = await user("u-hq");
    const today = localDateKey(nowIso());
    await updateSite(hq, "site-04", { installedOn: today });
    const inst = await createDraft(hq, "site-04", periodKey(reportSchedule(today, today)[0]));
    expect(inst.content.phases?.[0]).toMatchObject({ label: "제품 설치 및 맵핑", from: today, to: today });
    expect(inst.content.workLog?.map((w) => w.part)).toEqual(["오전", "오후", "명일 계획"]);
    expect(inst.aggregates.installation?.maps?.length).toBeGreaterThan(0);
    expect(inst.aggregates.installation?.maps?.[0].zones.length).toBeGreaterThan(0);
    expect(inst.aggregates.installation?.weekly?.length).toBeGreaterThan(0);
    await expect(updateContent(hq, inst.id, { phases: [{ label: "x", from: "2026-13-01", to: today }] })).rejects.toThrow(ValidationError);
    await updateContent(hq, inst.id, { workLog: [{ part: "오전", staff: "윤은호 외 2명", content: "MT1 3대 입고" }] });
    const jpg = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: "#336699" } }).jpeg().toBuffer();
    await expect(addPhoto(hq, inst.id, { caption: "가짜", data: Buffer.from("not an image") })).rejects.toThrow(ValidationError);
    const ph = await addPhoto(hq, inst.id, { caption: "제품 입고 사진", data: jpg });
    expect((await listPhotos(hq, inst.id)).map((p) => p.caption)).toEqual(["제품 입고 사진"]);
    expect((await getPhotoData(hq, ph.id)).contentType).toBe("image/jpeg");
    // 고객: 공개 전 보고서의 사진은 볼 수 없다(존재도 숨김)
    await expect(getPhotoData(await user("u-cust-1"), ph.id)).rejects.toThrow(NotFoundError);
    // 내보내기(설치): pptx/xlsx 가 만들어진다
    const full = await getReport(hq, inst.id);
    const input = { report: full, agg: effectiveAggregates(full), content: full.content, photos: (await db().select().from(schema.reportPhotos).where(eq(schema.reportPhotos.reportId, inst.id))), includeAdjustLog: true };
    const pptx = await buildPptx(input);
    const xlsx = await buildXlsx(input);
    expect(pptx.subarray(0, 2).toString()).toBe("PK");
    expect(xlsx.subarray(0, 2).toString()).toBe("PK");
    // 지도가 실린 층은 삭제할 수 없다(보고서 보존)
    await db().update(schema.robots).set({ floorId: "site-04-f2" }).where(eq(schema.robots.floorId, "site-04-f1"));
    await expect(deleteFloor(hq, "site-04-f1")).rejects.toThrow(ConflictError);
    // 확정·공개 뒤에는 사진을 지울 수 없고, 고객이 볼 수 있다
    await updateComments(hq, inst.id, { overallOpinion: "설치 완료" });
    await submitForReview(hq, inst.id);
    await confirmReport(hq, inst.id);
    await expect(deletePhoto(hq, ph.id)).rejects.toThrow(ValidationError);
    await publishReport(hq, inst.id);
    await db().insert(schema.sitePermissions).values({ userId: "u-cust-1", siteId: "site-04", allowedCommands: [] }).onConflictDoNothing();
    expect((await getPhotoData(await user("u-cust-1"), ph.id)).data.length).toBe(jpg.length);
    // 새 버전은 사진·작업 일지를 이어받는다
    const v2 = await createNextVersion(hq, inst.id);
    expect((await db().select().from(schema.reportPhotos).where(and(eq(schema.reportPhotos.reportId, v2.id)))).length).toBe(1);
    expect(v2.content.workLog?.[0].staff).toBe("윤은호 외 2명");
  });
});
