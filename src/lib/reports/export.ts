/**
 * 보고서 내보내기: 편집 가능한 PowerPoint(.pptx)·Excel(.xlsx).
 * - 표는 PPT 표/엑셀 셀, 청소 구역은 PPT 도형(다각형)으로 넣어 받는 쪽에서 고칠 수 있다.
 * - 수치는 웹에서 보정한 값(* 표시)을 반영한다. 원래 집계값은 엑셀 '보정 내역' 시트에 함께 남긴다.
 * - 엑셀의 지도는 이미지(구역 색칠)로 넣는다(엑셀은 다각형 도형을 만들 수 없다). 글자는 서버 글꼴 문제를 피하려고 그림에 넣지 않고 표로 준다.
 */
import PptxGenJS from "pptxgenjs";
import ExcelJS from "exceljs";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import type { ReportAggregates, ReportContent, ReportPhoto, ReportVersion } from "@/lib/domain/types";
import { commentLabels, periodText } from "@/lib/reports/schedule";
import { REPORT_STATUS_LABEL } from "@/lib/domain/status";
import { formatDateTime, formatTime } from "@/lib/util/time";

export interface ExportInput {
  report: ReportVersion & { title: string; siteName: string };
  agg: ReportAggregates; // 보정 반영
  content: ReportContent;
  photos: (ReportPhoto & { data: Buffer })[];
  /** 담당자용: 엑셀에 '보정 내역'(원래 집계값) 시트를 넣는다. 고객 내려받기에는 넣지 않는다. */
  includeAdjustLog: boolean;
}

const NAVY = "1E3A5F";
const BLUE = "3B82C4";
const PALETTE = ["2563EB", "16A34A", "D97706", "DB2777", "7C3AED", "0891B2", "DC2626", "65A30D"];
const DAY_LABEL = ["일", "월", "화", "수", "목", "금", "토"];
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const hm = (min: number) => `${Math.floor(min / 60)}시간 ${Math.round(min % 60)}분`;
const md = (k: string) => `${Number(k.slice(5, 7))}.${Number(k.slice(8, 10))}`;

type MapSnap = NonNullable<NonNullable<ReportAggregates["installation"]>["maps"]>[number];

async function mapImage(mapVersionId: string): Promise<{ data: Buffer; contentType: string } | null> {
  const row = await getDb().query.mapImages.findFirst({ where: eq(schema.mapImages.mapVersionId, mapVersionId) });
  return row ? { data: row.bytes, contentType: row.contentType } : null;
}

/** 지도 + 구역 색칠 PNG(엑셀용). 이미지가 없는 층은 흰 바탕. 긴 변 1400px 로 맞춘다. */
async function zoneMapPng(m: MapSnap): Promise<Buffer> {
  const scale = Math.min(1, 1400 / Math.max(m.widthPx, m.heightPx));
  const w = Math.max(1, Math.round(m.widthPx * scale));
  const h = Math.max(1, Math.round(m.heightPx * scale));
  const polys = m.zones
    .map((z, i) => `<polygon points="${z.polygon.map(([x, y]) => `${(x * scale).toFixed(1)},${(y * scale).toFixed(1)}`).join(" ")}" fill="#${PALETTE[i % PALETTE.length]}" fill-opacity="0.35" stroke="#${PALETTE[i % PALETTE.length]}" stroke-width="3"/>`)
    .join("");
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${polys}</svg>`);
  const img = m.hasImage ? await mapImage(m.mapVersionId) : null;
  const base = img ? sharp(img.data).resize(w, h, { fit: "fill" }).flatten({ background: "#ffffff" }) : sharp({ create: { width: w, height: h, channels: 3, background: "#ffffff" } });
  return base.composite([{ input: overlay }]).png().toBuffer();
}

async function toJpegOrPng(p: { data: Buffer; contentType: string }): Promise<{ data: Buffer; ext: "jpeg" | "png" }> {
  if (p.contentType === "image/jpeg") return { data: p.data, ext: "jpeg" };
  if (p.contentType === "image/png") return { data: p.data, ext: "png" };
  return { data: await sharp(p.data).jpeg({ quality: 85 }).toBuffer(), ext: "jpeg" };
}

async function imageSize(buf: Buffer): Promise<{ w: number; h: number }> {
  const meta = await sharp(buf).metadata();
  return { w: meta.width ?? 1, h: meta.height ?? 1 };
}

function dataUrl(buf: Buffer, contentType: string): string {
  return `data:${contentType};base64,${buf.toString("base64")}`;
}

function summaryRows(a: ReportAggregates, adjusted: Set<string>): [string, string][] {
  const m = (...keys: string[]) => (keys.some((k) => adjusted.has(`summary.${k}`)) ? " *" : "");
  return [
    ["운영 대수", `${a.robotCount}대${m("robotCount")}`],
    ["계획 완료율", `${a.completionRatePct === null ? "해당 없음" : `${a.completionRatePct}% (${a.plannedCompleted}/${a.validPlanned}회)`}${m("completionRatePct", "plannedCompleted", "validPlanned")}`],
    ["총 작업", `${a.totalRuns}건 (즉시·원격 ${a.adhocRuns}건 별도)${m("totalRuns", "adhocRuns")}`],
    ["누적 청소 면적", `${a.cumulativeAreaM2.toLocaleString()}㎡ (반복 구역 포함)${m("cumulativeAreaM2")}`],
    ["총 작업 시간", `${hm(a.totalDurationMin)}${m("totalDurationMin")}`],
    ["물 / 세제", `${a.waterL === null ? "미제공" : `${a.waterL}L`} / ${a.detergentMl === null ? "미제공" : `${a.detergentMl}mL`}${m("waterL", "detergentMl")}`],
    ["장애", `${a.incidents.length}건`],
    ["미실행 / 취소 / 제외", `${a.missed} / ${a.cancelled} / ${a.excluded}${m("missed", "cancelled", "excluded")}`],
  ];
}

// ---------------------------------------------------------------- PPTX
const W = 13.333;
const H = 7.5;
const hdrCell = (t: string) => ({ text: t, options: { bold: true, color: "FFFFFF", fill: { color: NAVY }, align: "center" as const } });

export async function buildPptx(input: ExportInput): Promise<Buffer> {
  const { report: r, agg: a, content, photos } = input;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = `${r.siteName} ${r.title}`;
  const font = "Malgun Gothic";
  const labels = commentLabels(r.kind);
  const period = periodText(r);
  const titleText = `■ ${r.siteName} 청소로봇 운영 리포트 · ${r.title} (${period})`;

  const newSlide = (sub?: string) => {
    const s = pptx.addSlide();
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 0.75, fill: { color: NAVY } });
    s.addText(titleText, { x: 0.3, y: 0.08, w: W - 0.6, h: 0.6, fontFace: font, fontSize: 20, bold: true, color: "FFFFFF" });
    if (sub) s.addText(sub, { x: 0.3, y: 0.85, w: W - 0.6, h: 0.35, fontFace: font, fontSize: 14, bold: true, color: NAVY });
    s.addText(`v${r.version} · ${REPORT_STATUS_LABEL[r.status]} · 집계 ${formatDateTime(r.aggregates.generatedAt)}`, { x: W - 4.3, y: H - 0.35, w: 4, h: 0.3, fontFace: font, fontSize: 9, color: "6B7280", align: "right" });
    return s;
  };
  const table = (s: PptxGenJS.Slide, head: string[], rows: (string | number)[][], opt: { x: number; y: number; w: number; colW?: number[]; fontSize?: number }) => {
    s.addTable([head.map(hdrCell), ...rows.map((row) => row.map((c) => ({ text: String(c) })))], { x: opt.x, y: opt.y, w: opt.w, colW: opt.colW, fontFace: font, fontSize: opt.fontSize ?? 10, border: { type: "solid", pt: 0.5, color: "C7CDD6" }, autoPage: true, autoPageRepeatHeader: true });
  };

  /** 지도 + 구역 도형(편집 가능). box 안에 비율 유지로 맞춘다. */
  const drawMap = async (s: PptxGenJS.Slide, m: MapSnap, box: { x: number; y: number; w: number; h: number }) => {
    const k = Math.min(box.w / m.widthPx, box.h / m.heightPx);
    const w = m.widthPx * k;
    const h = m.heightPx * k;
    const x0 = box.x + (box.w - w) / 2;
    const y0 = box.y;
    const img = m.hasImage ? await mapImage(m.mapVersionId) : null;
    if (img) s.addImage({ data: dataUrl(img.data, img.contentType), x: x0, y: y0, w, h });
    else s.addShape(pptx.ShapeType.rect, { x: x0, y: y0, w, h, fill: { color: "FFFFFF" }, line: { color: "C7CDD6", width: 0.75 } });
    m.zones.forEach((z, i) => {
      const xs = z.polygon.map((p) => p[0] * k);
      const ys = z.polygon.map((p) => p[1] * k);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const pw = Math.max(0.01, Math.max(...xs) - minX);
      const ph = Math.max(0.01, Math.max(...ys) - minY);
      const c = PALETTE[i % PALETTE.length];
      s.addShape("custGeom" as PptxGenJS.ShapeType, { // 런타임 지원(타입 선언에만 빠짐)
        x: x0 + minX,
        y: y0 + minY,
        w: pw,
        h: ph,
        fill: { color: c, transparency: 65 },
        line: { color: c, width: 1.5 },
        points: [...z.polygon.map((p, j) => ({ x: p[0] * k - minX, y: p[1] * k - minY, ...(j === 0 ? { moveTo: true } : {}) })), { close: true as const }],
      });
      s.addText(z.name, { x: x0 + minX, y: y0 + minY + ph / 2 - 0.15, w: pw, h: 0.3, fontFace: font, fontSize: 9, bold: true, color: "111827", align: "center", valign: "middle" });
    });
    return { x: x0, y: y0, w, h };
  };

  if (r.kind === "INSTALLATION") {
    const ins = a.installation;
    const maps = ins?.maps ?? [];
    // 1장: 첨부 양식처럼 — 지도(청소 범위) · 사진 · 작업 일지 · 단계 일정
    const s = newSlide(maps[0] ? `< ${maps[0].floorName} > 청소 범위` : "설치 현황");
    if (maps[0]) await drawMap(s, maps[0], { x: 0.4, y: 1.25, w: W - 0.8, h: 2.35 });
    const ph = photos.slice(0, 4);
    const pw = (W - 0.8 - 0.2 * 3) / 4;
    for (let i = 0; i < ph.length; i++) {
      const img = await toJpegOrPng(ph[i]);
      const sz = await imageSize(img.data);
      const boxH = 1.75;
      const k = Math.min(pw / sz.w, boxH / sz.h);
      const x = 0.4 + i * (pw + 0.2);
      s.addImage({ data: dataUrl(img.data, img.ext === "png" ? "image/png" : "image/jpeg"), x: x + (pw - sz.w * k) / 2, y: 3.7 + (boxH - sz.h * k) / 2, w: sz.w * k, h: sz.h * k });
      s.addText(`< ${ph[i].caption || "현장 사진"} >`, { x, y: 5.45, w: pw, h: 0.28, fontFace: font, fontSize: 10, bold: true, align: "center" });
    }
    const log = content.workLog ?? [];
    if (log.length) table(s, ["구분", "담당", "작업 내용"], log.map((w) => [w.part, w.staff, w.content.split("\n").filter(Boolean).map((l) => `○ ${l}`).join("\n")]), { x: 0.4, y: 5.8, w: 8.2, colW: [1.1, 1.6, 5.5], fontSize: 9 });
    const phases = content.phases ?? [];
    phases.forEach((p, i) => {
      const cw = 4.3 / Math.max(1, phases.length);
      s.addShape(i === 0 ? pptx.ShapeType.homePlate : pptx.ShapeType.chevron, { x: 8.75 + i * cw, y: 5.85, w: cw + 0.05, h: 0.75, fill: { color: i === phases.length - 1 ? NAVY : BLUE }, line: { color: "FFFFFF", width: 1 } });
      s.addText(`${p.label}\n${p.from === p.to ? md(p.from) : `${md(p.from)} ~ ${md(p.to)}`}`, { x: 8.85 + i * cw, y: 5.85, w: cw - 0.15, h: 0.75, fontFace: font, fontSize: 8, bold: true, color: "FFFFFF", align: "center", valign: "middle" });
    });
    // 추가 층 지도
    for (const m of maps.slice(1)) {
      const sm = newSlide(`< ${m.floorName} > 청소 범위 — 구역 ${m.zones.length}개 · ${m.zones.reduce((t, z) => t + z.areaM2, 0).toLocaleString()}㎡`);
      await drawMap(sm, m, { x: 0.4, y: 1.3, w: W - 0.8, h: H - 1.9 });
    }
    // 남은 사진
    for (let i = 4; i < photos.length; i += 6) {
      const sp = newSlide("현장 사진");
      const batch = photos.slice(i, i + 6);
      for (let j = 0; j < batch.length; j++) {
        const img = await toJpegOrPng(batch[j]);
        const sz = await imageSize(img.data);
        const cw = (W - 0.8 - 0.4) / 3;
        const chh = 2.55;
        const k = Math.min(cw / sz.w, (chh - 0.3) / sz.h);
        const x = 0.4 + (j % 3) * (cw + 0.2);
        const y = 1.3 + Math.floor(j / 3) * (chh + 0.2);
        sp.addImage({ data: dataUrl(img.data, img.ext === "png" ? "image/png" : "image/jpeg"), x: x + (cw - sz.w * k) / 2, y, w: sz.w * k, h: sz.h * k });
        sp.addText(`< ${batch[j].caption || "현장 사진"} >`, { x, y: y + chh - 0.3, w: cw, h: 0.28, fontFace: font, fontSize: 10, bold: true, align: "center" });
      }
    }
    // 주간 예약: 위는 한눈에 보는 막대(요일 × 0~24시), 아래는 읽고 고칠 수 있는 표
    const weekly = ins?.weekly ?? [];
    const st = newSlide("주간 청소 계획(예약)");
    const gx = 1.0;
    const gw = W - 1.4;
    const gy = 1.5;
    const rowH = 0.3;
    for (let hh = 0; hh <= 24; hh += 3) st.addText(String(hh), { x: gx + (hh / 24) * gw - 0.2, y: 1.22, w: 0.4, h: 0.25, fontFace: font, fontSize: 9, align: "center", color: "6B7280" });
    const robots = Array.from(new Set(weekly.map((w) => w.robotName)));
    WEEK.forEach((d, row) => {
      const y = gy + row * rowH;
      st.addText(DAY_LABEL[d], { x: 0.4, y, w: 0.5, h: rowH, fontFace: font, fontSize: 10, bold: true, valign: "middle", color: d === 0 ? "DC2626" : d === 6 ? "1D4ED8" : "111827" });
      st.addShape(pptx.ShapeType.line, { x: gx, y, w: gw, h: 0, line: { color: "D1D5DB", width: 0.5 } });
      const items = weekly.filter((w) => w.daysOfWeek.includes(d));
      items.forEach((w, i) => {
        const start = Number(w.time.slice(0, 2)) * 60 + Number(w.time.slice(3, 5));
        const dur = w.durationMin ?? 60;
        const bh = Math.max(0.04, (rowH - 0.06) / Math.max(1, items.length));
        st.addShape(pptx.ShapeType.rect, {
          x: gx + (start / 1440) * gw,
          y: y + 0.03 + i * bh,
          w: Math.max(0.08, (Math.min(dur, 1440 - start) / 1440) * gw),
          h: bh,
          fill: { color: PALETTE[robots.indexOf(w.robotName) % PALETTE.length], transparency: w.durationMin === null ? 45 : 0 },
          line: { color: "FFFFFF", width: 0.25 },
        });
      });
    });
    const legendY = gy + 7 * rowH + 0.05;
    st.addText(robots.map((n, i) => ({ text: `■ ${n}   `, options: { color: PALETTE[i % PALETTE.length] } })).concat([{ text: "막대 길이 = 최근 실적 평균 소요 시간(옅은 막대는 실적이 없어 60분 표시)", options: { color: "6B7280" } }]), { x: 0.4, y: legendY, w: W - 0.8, h: 0.3, fontFace: font, fontSize: 9 });
    if (weekly.length) {
      table(
        st,
        ["시각", "로봇", "작업", "층", ...WEEK.map((d) => DAY_LABEL[d]), "예상 소요"],
        weekly.map((w) => [w.time, w.robotName, w.taskName, w.floorName, ...WEEK.map((d) => (w.daysOfWeek.includes(d) ? "●" : "")), w.durationMin === null ? "미정" : `${w.durationMin}분`]),
        { x: 0.4, y: legendY + 0.4, w: W - 0.8, colW: [0.8, 1.8, 3.5, 1.4, ...WEEK.map(() => 0.45), 1.18], fontSize: 9 },
      );
    } else st.addText("사용 중인 예약이 없습니다.", { x: gx, y: legendY + 0.5, w: gw, h: 0.4, fontFace: font, fontSize: 12, align: "center", color: "6B7280" });
    // 설치 로봇 + 의견
    const so = newSlide("설치 로봇 · 의견");
    table(so, ["로봇", "모델", "배치 층"], (ins?.robots ?? []).map((x) => [x.name, x.model, x.floorName]), { x: 0.4, y: 1.3, w: 5.4, colW: [1.8, 2, 1.6] });
    so.addText(
      [
        [labels.overallOpinion, r.comments.overallOpinion],
        [labels.incompleteReasons, r.comments.incompleteReasons],
        [labels.improvements, r.comments.improvements],
        [labels.focusZones, r.comments.focusZones],
        [labels.nextMonthPlan, r.comments.nextMonthPlan],
      ].flatMap(([h, t]) => [{ text: `${h}\n`, options: { bold: true, color: NAVY } }, { text: `${t || "(작성 전)"}\n\n`, options: {} }]),
      { x: 6.1, y: 1.3, w: W - 6.5, h: H - 1.8, fontFace: font, fontSize: 11, valign: "top" },
    );
  } else {
    // 1장: 요약 + 종합 의견
    const s = newSlide(`${r.title} — 요약 (${period})`);
    const adjustedKeys = new Set(Object.keys(r.adjustments ?? {}));
    table(s, ["항목", "값"], summaryRows(a, adjustedKeys), { x: 0.4, y: 1.3, w: 5.6, colW: [2, 3.6], fontSize: 11 });
    if (adjustedKeys.size) s.addText(`* 담당자가 현장 기록으로 확인해 보정한 수치가 있습니다(${adjustedKeys.size}건).`, { x: 0.4, y: H - 0.75, w: 8, h: 0.3, fontFace: font, fontSize: 9, color: "B45309" });
    s.addText([{ text: `${labels.overallOpinion}\n`, options: { bold: true, color: NAVY } }, { text: r.comments.overallOpinion || "(작성 전)" }], { x: 6.3, y: 1.3, w: W - 6.7, h: 4.5, fontFace: font, fontSize: 12, valign: "top" });
    // 작업 일지(일간)
    if (r.kind === "DAILY" && (content.workLog ?? []).some((w) => w.content || w.staff)) {
      const sw = newSlide("작업 일지");
      table(sw, ["구분", "담당", "작업 내용"], (content.workLog ?? []).map((w) => [w.part, w.staff, w.content.split("\n").filter(Boolean).map((l) => `○ ${l}`).join("\n")]), { x: 0.4, y: 1.3, w: W - 0.8, colW: [1.4, 2, W - 4.2] });
    }
    if (r.kind === "DAILY" && a.runList?.length) {
      const sr = newSlide("작업 목록");
      table(sr, ["시작", "로봇", "층", "구분", "결과", "면적(㎡)", "시간(분)"], a.runList.map((x) => [formatTime(x.startedAt), x.robotName, x.floorName, x.origin === "PLANNED" ? "계획" : x.origin === "REMOTE" ? "원격" : "즉시", x.result, x.areaM2, x.durationMin]), { x: 0.4, y: 1.3, w: W - 0.8, fontSize: 9 });
    }
    if (a.byDay?.length) {
      const sd = newSlide("일자별 실적");
      table(sd, ["날짜", "작업", "정상 완료", "누적 면적(㎡)", "작업 시간(분)"], a.byDay.map((d) => [md(d.date), d.runs, d.completed, d.areaM2, d.durationMin]), { x: 0.4, y: 1.3, w: 7, fontSize: a.byDay.length > 15 ? 8 : 10 });
    }
    const sf = newSlide("층별 · 로봇별 실적");
    table(sf, ["층", "작업", "누적 면적(㎡)", "작업 시간(분)"], a.byFloor.map((f) => [f.floorName, f.runs, f.areaM2, f.durationMin]), { x: 0.4, y: 1.3, w: 6, fontSize: 10 });
    table(sf, ["로봇", "모델", "작업", "정상 완료", "누적 면적(㎡)"], a.byRobot.map((b) => [b.name, b.model, b.runs, b.completed, b.areaM2]), { x: 6.7, y: 1.3, w: W - 7.1, fontSize: 10 });
    const si = newSlide("장애 · 점검");
    if (a.incidents.length) table(si, ["발생", "내용", "조치", "복구"], a.incidents.map((i) => [formatDateTime(i.occurredAt), i.customerMessage, i.actionSummary, i.resolvedAt ? formatDateTime(i.resolvedAt) : "미복구"]), { x: 0.4, y: 1.3, w: 8.4, colW: [1.6, 2.8, 2.6, 1.4], fontSize: 9 });
    else si.addText("이 기간에 기록된 장애가 없습니다.", { x: 0.4, y: 1.3, w: 8, h: 0.4, fontFace: font, fontSize: 11 });
    if (a.inspections.length) table(si, ["점검 항목", "완료 / 예정"], a.inspections.map((x) => [x.item, `${x.done} / ${x.total}`]), { x: 9.1, y: 1.3, w: W - 9.5, fontSize: 10 });
    if (photos.length) {
      for (let i = 0; i < photos.length; i += 6) {
        const sp = newSlide("현장 사진");
        const batch = photos.slice(i, i + 6);
        for (let j = 0; j < batch.length; j++) {
          const img = await toJpegOrPng(batch[j]);
          const sz = await imageSize(img.data);
          const cw = (W - 1.2) / 3;
          const chh = 2.55;
          const k = Math.min(cw / sz.w, (chh - 0.3) / sz.h);
          const x = 0.4 + (j % 3) * (cw + 0.2);
          const y = 1.3 + Math.floor(j / 3) * (chh + 0.2);
          sp.addImage({ data: dataUrl(img.data, img.ext === "png" ? "image/png" : "image/jpeg"), x: x + (cw - sz.w * k) / 2, y, w: sz.w * k, h: sz.h * k });
          sp.addText(`< ${batch[j].caption || "현장 사진"} >`, { x, y: y + chh - 0.3, w: cw, h: 0.28, fontFace: font, fontSize: 10, bold: true, align: "center" });
        }
      }
    }
    const so = newSlide("의견 · 계획");
    so.addText(
      [
        [labels.incompleteReasons, r.comments.incompleteReasons],
        [labels.improvements, r.comments.improvements],
        [labels.focusZones, r.comments.focusZones],
        [labels.nextMonthPlan, r.comments.nextMonthPlan],
      ].flatMap(([h, t]) => [{ text: `${h}\n`, options: { bold: true, color: NAVY } }, { text: `${t || "(작성 전)"}\n\n`, options: {} }]),
      { x: 0.4, y: 1.3, w: W - 0.8, h: H - 1.8, fontFace: font, fontSize: 12, valign: "top" },
    );
  }
  const out = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  return out;
}

// ---------------------------------------------------------------- XLSX
export async function buildXlsx(input: ExportInput): Promise<Buffer> {
  const { report: r, agg: a, content, photos } = input;
  const wb = new ExcelJS.Workbook();
  wb.creator = "청소로봇 통합관제";
  wb.created = new Date();
  const labels = commentLabels(r.kind);
  const head = (ws: ExcelJS.Worksheet, cols: { header: string; key: string; width: number }[]) => {
    ws.columns = cols;
    const row = ws.getRow(1);
    row.font = { bold: true, color: { argb: "FFFFFFFF" } };
    row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${NAVY}` } };
    row.alignment = { vertical: "middle", horizontal: "center" };
    ws.views = [{ state: "frozen", ySplit: 1 }];
  };

  const sum = wb.addWorksheet("요약");
  sum.columns = [{ width: 24 }, { width: 70 }];
  sum.addRow([`${r.siteName} 청소로봇 운영 리포트`]).font = { bold: true, size: 14, color: { argb: `FF${NAVY}` } };
  sum.addRow(["보고서", r.title]);
  sum.addRow(["대상 기간", periodText(r)]);
  sum.addRow(["버전 · 상태", `v${r.version} · ${REPORT_STATUS_LABEL[r.status]}`]);
  sum.addRow(["집계 기준", formatDateTime(r.aggregates.generatedAt)]);
  sum.addRow([]);
  if (r.kind === "INSTALLATION") {
    (content.phases ?? []).forEach((p) => sum.addRow([`단계: ${p.label}`, p.from === p.to ? p.from : `${p.from} ~ ${p.to}`]));
  } else {
    sum.addRow(["운영 대수", a.robotCount]);
    sum.addRow(["유효 계획 회차", a.validPlanned]);
    sum.addRow(["정상 완료(계획)", a.plannedCompleted]);
    sum.addRow(["계획 완료율(%)", a.completionRatePct ?? "해당 없음"]);
    sum.addRow(["총 작업(건)", a.totalRuns]);
    sum.addRow(["즉시·원격 작업(건)", a.adhocRuns]);
    sum.addRow(["누적 청소 면적(㎡, 반복 포함)", a.cumulativeAreaM2]);
    sum.addRow(["총 작업 시간(분)", a.totalDurationMin]);
    sum.addRow(["물(L)", a.waterL ?? "미제공"]);
    sum.addRow(["세제(mL)", a.detergentMl ?? "미제공"]);
    sum.addRow(["미실행 / 취소 / 제외", `${a.missed} / ${a.cancelled} / ${a.excluded}`]);
    sum.addRow(["장애(건)", a.incidents.length]);
  }
  if (Object.keys(r.adjustments ?? {}).length) sum.addRow(["", `* 담당자가 현장 기록으로 확인해 보정한 수치가 반영되어 있습니다(${Object.keys(r.adjustments ?? {}).length}건).`]).getCell(2).font = { italic: true, color: { argb: "FFB45309" } };
  sum.addRow([]);
  for (const [h, t] of [
    [labels.overallOpinion, r.comments.overallOpinion],
    [labels.incompleteReasons, r.comments.incompleteReasons],
    [labels.improvements, r.comments.improvements],
    [labels.focusZones, r.comments.focusZones],
    [labels.nextMonthPlan, r.comments.nextMonthPlan],
  ]) {
    const row = sum.addRow([h, t || ""]);
    row.getCell(1).font = { bold: true };
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
  }
  sum.getColumn(1).font = { bold: true };

  if ((content.workLog ?? []).length) {
    const ws = wb.addWorksheet("작업 일지");
    head(ws, [{ header: "구분", key: "part", width: 12 }, { header: "담당", key: "staff", width: 18 }, { header: "작업 내용", key: "content", width: 90 }]);
    (content.workLog ?? []).forEach((w) => (ws.addRow(w).getCell(3).alignment = { wrapText: true }));
  }

  if (r.kind === "INSTALLATION" && a.installation) {
    const ins = a.installation;
    const wr = wb.addWorksheet("설치 로봇");
    head(wr, [{ header: "로봇", key: "name", width: 20 }, { header: "모델", key: "model", width: 18 }, { header: "배치 층", key: "floorName", width: 16 }]);
    ins.robots.forEach((x) => wr.addRow(x));
    const ww = wb.addWorksheet("주간 예약");
    head(ww, [{ header: "시각", key: "time", width: 8 }, { header: "로봇", key: "robot", width: 16 }, { header: "작업", key: "task", width: 28 }, { header: "층", key: "floor", width: 12 }, ...WEEK.map((d) => ({ header: DAY_LABEL[d], key: `d${d}`, width: 5 })), { header: "예상 소요(분)", key: "dur", width: 12 }]);
    (ins.weekly ?? []).forEach((w) => {
      const row: Record<string, string | number> = { time: w.time, robot: w.robotName, task: w.taskName, floor: w.floorName, dur: w.durationMin ?? "미정" };
      WEEK.forEach((d) => (row[`d${d}`] = w.daysOfWeek.includes(d) ? "●" : ""));
      ww.addRow(row);
    });
    const wz = wb.addWorksheet("청소 구역");
    head(wz, [{ header: "층", key: "floor", width: 14 }, { header: "구역", key: "zone", width: 24 }, { header: "면적(㎡)", key: "area", width: 10 }, { header: "지도 색", key: "color", width: 8 }]);
    for (const m of ins.maps ?? []) {
      m.zones.forEach((z, i) => {
        const row = wz.addRow({ floor: m.floorName, zone: z.name, area: z.areaM2, color: "" });
        row.getCell(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${PALETTE[i % PALETTE.length]}` } };
      });
    }
    if ((ins.maps ?? []).length) {
      const wm = wb.addWorksheet("지도");
      wm.getColumn(1).width = 120;
      let row = 1;
      for (const m of ins.maps ?? []) {
        wm.getCell(row, 1).value = `< ${m.floorName} > 청소 구역 ${m.zones.length}개 (색은 '청소 구역' 시트 참고)`;
        wm.getCell(row, 1).font = { bold: true };
        const png = await zoneMapPng(m);
        const sz = await imageSize(png);
        const k = Math.min(1, 860 / sz.w);
        const id = wb.addImage({ buffer: png as unknown as ExcelJS.Buffer, extension: "png" });
        wm.addImage(id, { tl: { col: 0, row }, ext: { width: sz.w * k, height: sz.h * k } });
        row += Math.ceil((sz.h * k) / 20) + 3;
      }
    }
  } else {
    if (a.byDay?.length) {
      const ws = wb.addWorksheet("일자별");
      head(ws, [{ header: "날짜", key: "date", width: 12 }, { header: "작업", key: "runs", width: 8 }, { header: "정상 완료", key: "completed", width: 10 }, { header: "누적 면적(㎡)", key: "areaM2", width: 14 }, { header: "작업 시간(분)", key: "durationMin", width: 14 }]);
      a.byDay.forEach((d) => ws.addRow(d));
      const n = a.byDay.length + 1;
      ws.addRow({ date: "합계", runs: { formula: `SUM(B2:B${n})` }, completed: { formula: `SUM(C2:C${n})` }, areaM2: { formula: `SUM(D2:D${n})` }, durationMin: { formula: `SUM(E2:E${n})` } }).font = { bold: true };
    }
    if (a.runList?.length) {
      const ws = wb.addWorksheet("작업 목록");
      head(ws, [{ header: "시작", key: "t", width: 18 }, { header: "로봇", key: "robot", width: 16 }, { header: "층", key: "floor", width: 12 }, { header: "구분", key: "origin", width: 8 }, { header: "결과", key: "result", width: 10 }, { header: "면적(㎡)", key: "area", width: 10 }, { header: "시간(분)", key: "dur", width: 10 }]);
      a.runList.forEach((x) => ws.addRow({ t: formatDateTime(x.startedAt), robot: x.robotName, floor: x.floorName, origin: x.origin === "PLANNED" ? "계획" : x.origin === "REMOTE" ? "원격" : "즉시", result: x.result, area: x.areaM2, dur: x.durationMin }));
    }
    const wf = wb.addWorksheet("층별");
    head(wf, [{ header: "층", key: "floorName", width: 14 }, { header: "작업", key: "runs", width: 8 }, { header: "누적 면적(㎡)", key: "areaM2", width: 14 }, { header: "작업 시간(분)", key: "durationMin", width: 14 }]);
    a.byFloor.forEach((f) => wf.addRow(f));
    if (a.byZone.length) {
      const wz = wb.addWorksheet("구역별");
      head(wz, [{ header: "층", key: "floorName", width: 14 }, { header: "구역", key: "zoneName", width: 24 }, { header: "작업", key: "runs", width: 8 }, { header: "배분 면적(㎡, 근사)", key: "areaM2", width: 18 }]);
      a.byZone.forEach((z) => wz.addRow(z));
    }
    const wr = wb.addWorksheet("로봇별");
    head(wr, [{ header: "로봇", key: "name", width: 16 }, { header: "모델", key: "model", width: 16 }, { header: "작업", key: "runs", width: 8 }, { header: "정상 완료", key: "completed", width: 10 }, { header: "누적 면적(㎡)", key: "areaM2", width: 14 }]);
    a.byRobot.forEach((b) => wr.addRow(b));
    const wi = wb.addWorksheet("장애");
    head(wi, [{ header: "발생", key: "at", width: 18 }, { header: "등급", key: "sev", width: 8 }, { header: "내용", key: "msg", width: 40 }, { header: "조치", key: "act", width: 40 }, { header: "복구", key: "res", width: 18 }]);
    a.incidents.forEach((i) => wi.addRow({ at: formatDateTime(i.occurredAt), sev: i.severity, msg: i.customerMessage, act: i.actionSummary, res: i.resolvedAt ? formatDateTime(i.resolvedAt) : "미복구" }));
    if (a.inspections.length) {
      const wk = wb.addWorksheet("점검");
      head(wk, [{ header: "항목", key: "item", width: 20 }, { header: "완료", key: "done", width: 8 }, { header: "예정", key: "total", width: 8 }]);
      a.inspections.forEach((x) => wk.addRow(x));
    }
  }

  if (photos.length) {
    const wp = wb.addWorksheet("사진");
    wp.getColumn(1).width = 60;
    wp.getColumn(2).width = 60;
    for (let i = 0; i < photos.length; i++) {
      const img = await toJpegOrPng(photos[i]);
      const sz = await imageSize(img.data);
      const k = Math.min(400 / sz.w, 300 / sz.h);
      const col = i % 2;
      const row = Math.floor(i / 2) * 18;
      wp.getCell(row + 1, col + 1).value = `< ${photos[i].caption || "현장 사진"} >`;
      wp.getCell(row + 1, col + 1).font = { bold: true };
      const id = wb.addImage({ buffer: img.data as unknown as ExcelJS.Buffer, extension: img.ext });
      wp.addImage(id, { tl: { col, row: row + 1 }, ext: { width: sz.w * k, height: sz.h * k } });
    }
  }

  const adj = input.includeAdjustLog ? Object.entries(r.adjustments ?? {}) : [];
  if (adj.length) {
    const wa = wb.addWorksheet("보정 내역");
    head(wa, [{ header: "항목", key: "k", width: 40 }, { header: "원래 집계", key: "o", width: 12 }, { header: "보정값", key: "v", width: 12 }, { header: "보정 시각", key: "at", width: 20 }]);
    adj.forEach(([k, v]) => wa.addRow({ k, o: v.original ?? "미제공", v: v.value, at: formatDateTime(v.at) }));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
