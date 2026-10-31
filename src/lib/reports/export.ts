/**
 * 보고서 내보내기: 편집 가능한 PowerPoint(.pptx)·Excel(.xlsx).
 * - PPT: 모든 장에 같은 머리띠(사업장·보고서·기간)와 꼬리(버전·집계 시각·쪽 번호)를 슬라이드 마스터로 넣는다 → 표가 넘쳐 자동으로 늘어난 장에도 그대로 나온다.
 *   핵심 수치는 카드, 일자별 실적은 PPT 차트(데이터 편집 가능), 표·청소 구역 도형·글상자는 모두 PPT 에서 고칠 수 있다.
 * - Excel: 시트별 표(테두리·숫자 서식·필터·틀 고정·가로 인쇄), 요약 시트는 지표·단위·비고 표와 의견.
 * - 수치는 웹에서 보정한 값(* 표시)을 반영한다. 원래 집계값은 담당자용 엑셀 '보정 내역' 시트에만 둔다.
 * - 엑셀의 지도는 구역 색칠 그림(엑셀은 다각형 도형을 만들 수 없음). 서버 글꼴 문제를 피하려고 그림에 글자를 넣지 않고 구역 표로 준다.
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
const GRAY = "6B7280";
const LIGHT = "F3F6FA";
const LINE = "D9DEE7";
const PALETTE = ["2563EB", "16A34A", "D97706", "DB2777", "7C3AED", "0891B2", "DC2626", "65A30D"];
const DAY_LABEL = ["일", "월", "화", "수", "목", "금", "토"];
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const FONT = "Malgun Gothic";
const n0 = (v: number | null | undefined) => (v === null || v === undefined ? "-" : Math.round(v).toLocaleString("ko-KR"));
const hm = (min: number) => `${Math.floor(min / 60)}시간 ${Math.round(min % 60)}분`;
const md = (k: string) => `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))}`;
const dow = (k: string) => DAY_LABEL[new Date(`${k}T00:00:00Z`).getUTCDay()];
const originLabel = (o: string) => (o === "PLANNED" ? "계획" : o === "REMOTE" ? "원격" : "즉시");
const bullets = (t: string) => t.split("\n").filter(Boolean).map((l) => `○ ${l}`).join("\n");

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

const dataUrl = (buf: Buffer, contentType: string) => `data:${contentType};base64,${buf.toString("base64")}`;

/** 요약 지표(보정 여부 포함). PPT 카드·엑셀 요약 표가 같이 쓴다. */
function kpis(a: ReportAggregates, adjusted: Set<string>) {
  const adj = (...k: string[]) => k.some((x) => adjusted.has(`summary.${x}`));
  return [
    { label: "운영 대수", value: `${n0(a.robotCount)}대`, num: a.robotCount, unit: "대", note: "", adj: adj("robotCount") },
    { label: "계획 완료율", value: a.completionRatePct === null ? "해당 없음" : `${a.completionRatePct}%`, num: a.completionRatePct, unit: "%", note: `정상 완료 ${n0(a.plannedCompleted)} / 유효 계획 ${n0(a.validPlanned)}회`, adj: adj("completionRatePct", "plannedCompleted", "validPlanned") },
    { label: "총 작업", value: `${n0(a.totalRuns)}건`, num: a.totalRuns, unit: "건", note: `즉시·원격 ${n0(a.adhocRuns)}건 포함`, adj: adj("totalRuns", "adhocRuns") },
    { label: "누적 청소 면적", value: `${n0(a.cumulativeAreaM2)}㎡`, num: a.cumulativeAreaM2, unit: "㎡", note: "반복 구역 포함", adj: adj("cumulativeAreaM2") },
    { label: "총 작업 시간", value: hm(a.totalDurationMin), num: a.totalDurationMin, unit: "분", note: `${n0(a.totalDurationMin)}분`, adj: adj("totalDurationMin") },
    { label: "장애", value: `${n0(a.incidents.length)}건`, num: a.incidents.length, unit: "건", note: `미실행 ${n0(a.missed)} · 취소 ${n0(a.cancelled)} · 제외 ${n0(a.excluded)}`, adj: false },
  ];
}

// =================================================================== PPTX
const W = 13.333;

const M = 0.4; // 좌우 여백
const TOP = 0.85; // 머리띠 아래 본문 시작
const BOTTOM = 7.0; // 꼬리 위 본문 끝
const MASTER = "REPORT";

type Slide = PptxGenJS.Slide;

export async function buildPptx(input: ExportInput): Promise<Buffer> {
  const { report: r, agg: a, content, photos } = input;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = `${r.siteName} ${r.title}`;
  pptx.company = "청소로봇 통합관제";
  const labels = commentLabels(r.kind);
  const period = periodText(r);
  const adjusted = new Set(Object.keys(r.adjustments ?? {}));

  pptx.defineSlideMaster({
    title: MASTER,
    background: { color: "FFFFFF" },
    objects: [
      { rect: { x: 0, y: 0, w: W, h: 0.62, fill: { color: NAVY } } },
      { text: { text: `${r.siteName} · ${r.title}`, options: { x: M, y: 0.06, w: 8.8, h: 0.5, fontFace: FONT, fontSize: 18, bold: true, color: "FFFFFF", valign: "middle" } } },
      { text: { text: period, options: { x: 9.2, y: 0.06, w: W - 9.2 - M, h: 0.5, fontFace: FONT, fontSize: 13, color: "DCE6F2", align: "right", valign: "middle" } } },
      { line: { x: M, y: 7.08, w: W - 2 * M, h: 0, line: { color: LINE, width: 0.75 } } },
      { text: { text: `청소로봇 통합관제 · v${r.version} ${REPORT_STATUS_LABEL[r.status]} · 집계 ${formatDateTime(r.aggregates.generatedAt)}`, options: { x: M, y: 7.1, w: 9, h: 0.3, fontFace: FONT, fontSize: 8, color: "9CA3AF" } } },
    ],
    slideNumber: { x: W - M - 0.6, y: 7.1, w: 0.6, h: 0.3, fontFace: FONT, fontSize: 8, color: "9CA3AF", align: "right" },
  });

  const newSlide = (section: string) => {
    const s = pptx.addSlide({ masterName: MASTER });
    s.addText(section, { x: M, y: 0.7, w: W - 2 * M, h: 0.4, fontFace: FONT, fontSize: 15, bold: true, color: NAVY });
    return s;
  };

  /** 표: 머리 행 색, 줄무늬, 숫자 열 오른쪽 정렬, 넘치면 다음 장(머리 반복, 마스터 유지). */
  const table = (s: Slide, head: string[], rows: (string | number)[][], o: { x: number; y: number; w: number; colW?: number[]; fontSize?: number; numCols?: number[]; rowH?: number }) => {
    const fs = o.fontSize ?? 10;
    const headRow = head.map((t) => ({ text: t, options: { bold: true, color: "FFFFFF", fill: { color: NAVY }, align: "center" as const, valign: "middle" as const } }));
    const body = rows.map((row, i) =>
      row.map((c, j) => ({
        text: typeof c === "number" ? n0(c) : String(c),
        options: { align: (o.numCols?.includes(j) || typeof c === "number" ? "right" : "left") as "right" | "left", valign: "middle" as const, ...(i % 2 ? { fill: { color: "F8FAFC" } } : {}) },
      })),
    );
    s.addTable([headRow, ...body], {
      x: o.x,
      y: o.y,
      w: o.w,
      colW: o.colW,
      rowH: o.rowH ?? 0.3,
      fontFace: FONT,
      fontSize: fs,
      color: "111827",
      border: { type: "solid", pt: 0.5, color: LINE },
      margin: [0.03, 0.06, 0.03, 0.06],
      autoPage: true,
      autoPageRepeatHeader: true,
      autoPageHeaderRows: 1,
      autoPageSlideStartY: TOP + 0.4,
    });
  };

  /** 지표 카드. */
  const card = (s: Slide, x: number, y: number, w: number, h: number, label: string, value: string, note = "", mark = false) => {
    s.addShape(pptx.ShapeType.roundRect, { x, y, w, h, fill: { color: LIGHT }, line: { color: LINE, width: 0.75 }, rectRadius: 0.08 });
    s.addText(label, { x: x + 0.12, y: y + 0.06, w: w - 0.24, h: 0.28, fontFace: FONT, fontSize: 10, color: GRAY });
    s.addText(`${value}${mark ? " *" : ""}`, { x: x + 0.12, y: y + 0.3, w: w - 0.24, h: 0.46, fontFace: FONT, fontSize: 20, bold: true, color: NAVY, fit: "shrink" });
    if (note) s.addText(note, { x: x + 0.12, y: y + h - 0.32, w: w - 0.24, h: 0.26, fontFace: FONT, fontSize: 8, color: GRAY, fit: "shrink" });
  };

  /** 제목 있는 글상자(의견 등). */
  const box = (s: Slide, x: number, y: number, w: number, h: number, title: string, body: string) => {
    s.addShape(pptx.ShapeType.rect, { x, y, w, h, fill: { color: "FFFFFF" }, line: { color: LINE, width: 0.75 } });
    s.addShape(pptx.ShapeType.rect, { x, y, w: 0.06, h, fill: { color: BLUE }, line: { color: BLUE, width: 0 } });
    s.addText(title, { x: x + 0.18, y: y + 0.06, w: w - 0.3, h: 0.32, fontFace: FONT, fontSize: 11, bold: true, color: NAVY });
    s.addText(body || "(작성 전)", { x: x + 0.18, y: y + 0.38, w: w - 0.3, h: h - 0.46, fontFace: FONT, fontSize: 10.5, color: body ? "111827" : "9CA3AF", valign: "top", fit: "shrink", paraSpaceAfter: 2 });
  };

  /** 사진 격자(한 장에 cols×rows). */
  const photoGrid = async (list: typeof photos, cols: number, rows: number, title = "현장 사진") => {
    for (let i = 0; i < list.length; i += cols * rows) {
      const s = newSlide(title);
      const cw = (W - 2 * M - 0.25 * (cols - 1)) / cols;
      const chh = (BOTTOM - TOP - 0.45 - 0.2 * (rows - 1)) / rows;
      const batch = list.slice(i, i + cols * rows);
      for (let j = 0; j < batch.length; j++) {
        const img = await toJpegOrPng(batch[j]);
        const sz = await imageSize(img.data);
        const bh = chh - 0.32;
        const k = Math.min(cw / sz.w, bh / sz.h);
        const x = M + (j % cols) * (cw + 0.25);
        const y = TOP + 0.45 + Math.floor(j / cols) * (chh + 0.2);
        s.addImage({ data: dataUrl(img.data, img.ext === "png" ? "image/png" : "image/jpeg"), x: x + (cw - sz.w * k) / 2, y: y + (bh - sz.h * k) / 2, w: sz.w * k, h: sz.h * k });
        s.addText(`< ${batch[j].caption || "현장 사진"} >`, { x, y: y + bh + 0.02, w: cw, h: 0.28, fontFace: FONT, fontSize: 10, bold: true, align: "center" });
      }
    }
  };

  /** 지도 + 구역 도형(편집 가능). box 안에 비율 유지로 맞춘다. */
  const drawMap = async (s: Slide, m: MapSnap, b: { x: number; y: number; w: number; h: number }) => {
    const k = Math.min(b.w / m.widthPx, b.h / m.heightPx);
    const w = m.widthPx * k;
    const h = m.heightPx * k;
    const x0 = b.x + (b.w - w) / 2;
    const y0 = b.y;
    const img = m.hasImage ? await mapImage(m.mapVersionId) : null;
    if (img) s.addImage({ data: dataUrl(img.data, img.contentType), x: x0, y: y0, w, h });
    else s.addShape(pptx.ShapeType.rect, { x: x0, y: y0, w, h, fill: { color: "FFFFFF" }, line: { color: LINE, width: 0.75 } });
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
      s.addText(z.name, { x: x0 + minX, y: y0 + minY + ph / 2 - 0.15, w: pw, h: 0.3, fontFace: FONT, fontSize: 9, bold: true, color: "111827", align: "center", valign: "middle", fit: "shrink" });
    });
  };

  const notes = (s: Slide, y: number) => {
    const lines = [...(adjusted.size ? [`* 담당자가 현장 기록으로 확인해 보정한 수치(${adjusted.size}건)`] : []), ...a.unsupportedMetrics];
    if (lines.length) s.addText(lines.map((l) => `· ${l}`).join("\n"), { x: M, y, w: W - 2 * M, h: BOTTOM - y, fontFace: FONT, fontSize: 8, color: GRAY, valign: "top" });
  };

  if (r.kind === "INSTALLATION") {
    const ins = a.installation;
    const maps = ins?.maps ?? [];
    const weekly = ins?.weekly ?? [];
    // 1장: 지도(청소 범위) · 사진 4장 · 작업 일지 · 단계 일정 (첨부 양식 배치)
    const s = newSlide(maps[0] ? `< ${maps[0].floorName} > 청소 범위 · 설치 현황` : "설치 현황");
    if (maps[0]) await drawMap(s, maps[0], { x: M, y: TOP + 0.4, w: W - 2 * M, h: 2.25 });
    const ph = photos.slice(0, 4);
    const pw = (W - 2 * M - 0.2 * 3) / 4;
    for (let i = 0; i < ph.length; i++) {
      const img = await toJpegOrPng(ph[i]);
      const sz = await imageSize(img.data);
      const boxH = 1.6;
      const k = Math.min(pw / sz.w, boxH / sz.h);
      const x = M + i * (pw + 0.2);
      s.addImage({ data: dataUrl(img.data, img.ext === "png" ? "image/png" : "image/jpeg"), x: x + (pw - sz.w * k) / 2, y: 3.6 + (boxH - sz.h * k) / 2, w: sz.w * k, h: sz.h * k });
      s.addText(`< ${ph[i].caption || "현장 사진"} >`, { x, y: 5.22, w: pw, h: 0.26, fontFace: FONT, fontSize: 10, bold: true, align: "center" });
    }
    const log = content.workLog ?? [];
    if (log.length) table(s, ["구분", "담당", "작업 내용"], log.map((w) => [w.part, w.staff, bullets(w.content)]), { x: M, y: 5.55, w: 8.1, colW: [1.0, 1.6, 5.5], fontSize: 9, rowH: 0.26 });
    const phases = content.phases ?? [];
    phases.forEach((p, i) => {
      const cw = (W - M - 8.75) / Math.max(1, phases.length);
      s.addShape(i === 0 ? pptx.ShapeType.homePlate : pptx.ShapeType.chevron, { x: 8.75 + i * cw, y: 5.6, w: cw + 0.05, h: 0.8, fill: { color: i === phases.length - 1 ? NAVY : BLUE }, line: { color: "FFFFFF", width: 1 } });
      s.addText([{ text: p.label, options: { bold: true, breakLine: true } }, { text: p.from === p.to ? md(p.from) : `${md(p.from)} ~ ${md(p.to)}` }], { x: 8.85 + i * cw, y: 5.6, w: cw - 0.15, h: 0.8, fontFace: FONT, fontSize: 8, color: "FFFFFF", align: "center", valign: "middle", fit: "shrink" });
    });
    // 2장~: 다른 층 지도
    for (const m of maps.slice(1)) {
      const sm = newSlide(`< ${m.floorName} > 청소 범위 — 구역 ${m.zones.length}개 · ${n0(m.zones.reduce((t, z) => t + z.areaM2, 0))}㎡`);
      await drawMap(sm, m, { x: M, y: TOP + 0.45, w: W - 2 * M, h: BOTTOM - TOP - 0.55 });
    }
    // 주간 청소 계획: 요약 카드 + 막대(요일 × 0~24시) + 표
    const st = newSlide("주간 청소 계획(예약)");
    const zoneCount = maps.reduce((t, m) => t + m.zones.length, 0);
    const zoneArea = maps.reduce((t, m) => t + m.zones.reduce((u, z) => u + z.areaM2, 0), 0);
    const weeklyRuns = weekly.reduce((t, w) => t + w.daysOfWeek.length, 0);
    const weeklyMin = weekly.reduce((t, w) => t + w.daysOfWeek.length * (w.durationMin ?? 0), 0);
    const cw4 = (W - 2 * M - 0.2 * 3) / 4;
    [["설치 로봇", `${ins?.robots.length ?? 0}대`, ""], ["청소 구역", `${zoneCount}개`, `합계 ${n0(zoneArea)}㎡`], ["주간 예약", `${weeklyRuns}회`, ""], ["주간 예상 청소 시간", weeklyMin ? hm(weeklyMin) : "미정", "최근 실적 평균 기준"]].forEach(([l, v, nt], i) => card(st, M + i * (cw4 + 0.2), TOP + 0.4, cw4, 0.95, l, v, nt));
    const gx = M + 0.5;
    const gw = W - 2 * M - 0.5;
    const gy = TOP + 1.65;
    const rowH = 0.27;
    for (let hh = 0; hh <= 24; hh += 3) st.addText(String(hh), { x: gx + (hh / 24) * gw - 0.2, y: gy - 0.25, w: 0.4, h: 0.22, fontFace: FONT, fontSize: 8, align: "center", color: GRAY });
    const robots = Array.from(new Set(weekly.map((w) => w.robotName)));
    WEEK.forEach((d, row) => {
      const y = gy + row * rowH;
      st.addText(DAY_LABEL[d], { x: M, y, w: 0.4, h: rowH, fontFace: FONT, fontSize: 9, bold: true, valign: "middle", color: d === 0 ? "DC2626" : d === 6 ? "1D4ED8" : "111827" });
      st.addShape(pptx.ShapeType.rect, { x: gx, y, w: gw, h: rowH, fill: { color: row % 2 ? "FFFFFF" : "F8FAFC" }, line: { color: LINE, width: 0.25 } });
      const items = weekly.filter((w) => w.daysOfWeek.includes(d));
      items.forEach((w, i) => {
        const start = Number(w.time.slice(0, 2)) * 60 + Number(w.time.slice(3, 5));
        const dur = w.durationMin ?? 60;
        const bh = Math.max(0.04, (rowH - 0.06) / Math.max(1, items.length));
        st.addShape(pptx.ShapeType.rect, { x: gx + (start / 1440) * gw, y: y + 0.03 + i * bh, w: Math.max(0.08, (Math.min(dur, 1440 - start) / 1440) * gw), h: bh, fill: { color: PALETTE[robots.indexOf(w.robotName) % PALETTE.length], transparency: w.durationMin === null ? 45 : 0 }, line: { color: "FFFFFF", width: 0.25 } });
      });
    });
    const legendY = gy + 7 * rowH + 0.05;
    st.addText(robots.map((nm, i) => ({ text: `■ ${nm}   `, options: { color: PALETTE[i % PALETTE.length] } })).concat([{ text: "막대 길이 = 최근 실적 평균 소요 시간(옅은 막대는 실적이 없어 60분 표시)", options: { color: GRAY } }]), { x: M, y: legendY, w: W - 2 * M, h: 0.28, fontFace: FONT, fontSize: 8 });
    if (weekly.length) table(st, ["시각", "로봇", "작업", "층", ...WEEK.map((d) => DAY_LABEL[d]), "예상 소요"], weekly.map((w) => [w.time, w.robotName, w.taskName, w.floorName, ...WEEK.map((d) => (w.daysOfWeek.includes(d) ? "●" : "")), w.durationMin === null ? "미정" : `${w.durationMin}분`]), { x: M, y: legendY + 0.35, w: W - 2 * M, colW: [0.75, 1.8, 3.8, 1.4, ...WEEK.map(() => 0.42), 1.31], fontSize: 9, rowH: 0.26 });
    else st.addText("사용 중인 예약이 없습니다.", { x: M, y: legendY + 0.4, w: W - 2 * M, h: 0.4, fontFace: FONT, fontSize: 12, align: "center", color: GRAY });
    // 설치 로봇 · 의견
    const so = newSlide("설치 로봇 · 의견");
    table(so, ["로봇", "모델", "배치 층"], (ins?.robots ?? []).map((x) => [x.name, x.model, x.floorName]), { x: M, y: TOP + 0.4, w: 4.9, colW: [1.7, 1.8, 1.4] });
    const bx = 5.6;
    const bw = (W - M - bx - 0.2) / 2;
    const bh = (BOTTOM - TOP - 0.4 - 0.4) / 3;
    box(so, bx, TOP + 0.4, W - M - bx, bh, labels.overallOpinion, r.comments.overallOpinion);
    box(so, bx, TOP + 0.6 + bh, bw, bh, labels.incompleteReasons, r.comments.incompleteReasons);
    box(so, bx + bw + 0.2, TOP + 0.6 + bh, bw, bh, labels.improvements, r.comments.improvements);
    box(so, bx, TOP + 0.8 + 2 * bh, bw, bh, labels.focusZones, r.comments.focusZones);
    box(so, bx + bw + 0.2, TOP + 0.8 + 2 * bh, bw, bh, labels.nextMonthPlan, r.comments.nextMonthPlan);
    if (photos.length > 4) await photoGrid(photos.slice(4), 3, 2);
  } else {
    // 1장: 핵심 수치 카드 + (일간: 작업 일지/의견) (주간·월간: 일자별 차트 + 종합 의견)
    const s = newSlide(`요약 — ${r.title}`);
    const cards = kpis(a, adjusted);
    const cw = (W - 2 * M - 0.15 * (cards.length - 1)) / cards.length;
    cards.forEach((c, i) => card(s, M + i * (cw + 0.15), TOP + 0.4, cw, 1.05, c.label, c.value, c.note, c.adj));
    const y2 = TOP + 1.65;
    if (r.kind === "DAILY") {
      const log = (content.workLog ?? []).filter((w) => w.content || w.staff);
      const leftW = 7.9;
      if (log.length) {
        s.addText("작업 일지", { x: M, y: y2, w: leftW, h: 0.3, fontFace: FONT, fontSize: 11, bold: true, color: NAVY });
        table(s, ["구분", "담당", "작업 내용"], log.map((w) => [w.part, w.staff, bullets(w.content)]), { x: M, y: y2 + 0.32, w: leftW, colW: [1.0, 1.6, 5.3], fontSize: 9.5, rowH: 0.3 });
      }
      const listY = log.length ? y2 + 0.45 + 0.32 * (log.length + 1) + 0.2 : y2;
      s.addText(`작업 목록 (${a.runList?.length ?? 0}건)`, { x: M, y: listY, w: leftW, h: 0.3, fontFace: FONT, fontSize: 11, bold: true, color: NAVY });
      if (a.runList?.length) table(s, ["시작", "로봇", "층", "구분", "결과", "면적(㎡)", "시간(분)"], a.runList.map((x) => [formatTime(x.startedAt), x.robotName, x.floorName, originLabel(x.origin), x.result, x.areaM2, x.durationMin]), { x: M, y: listY + 0.32, w: leftW, colW: [0.8, 1.6, 1.5, 0.7, 1.1, 1.1, 1.1], fontSize: 9, rowH: 0.26 });
      else s.addText("이 날 수신된 작업이 없습니다.", { x: M, y: listY + 0.35, w: leftW, h: 0.3, fontFace: FONT, fontSize: 10, color: GRAY });
      const rx = M + leftW + 0.25;
      const rw = W - M - rx;
      const bh = (BOTTOM - y2 - 0.3) / 3;
      box(s, rx, y2, rw, bh, labels.overallOpinion, r.comments.overallOpinion);
      box(s, rx, y2 + bh + 0.15, rw, bh, labels.incompleteReasons, r.comments.incompleteReasons);
      box(s, rx, y2 + 2 * bh + 0.3, rw, bh, labels.nextMonthPlan, r.comments.nextMonthPlan);
    } else {
      const chartW = 8.4;
      const days = a.byDay ?? [];
      s.addText("일자별 누적 청소 면적(㎡)", { x: M, y: y2, w: chartW, h: 0.3, fontFace: FONT, fontSize: 11, bold: true, color: NAVY });
      if (days.length) {
        s.addChart(pptx.ChartType.bar, [{ name: "누적 청소 면적(㎡)", labels: days.map((d) => md(d.date)), values: days.map((d) => d.areaM2) }], {
          x: M,
          y: y2 + 0.3,
          w: chartW,
          h: 3.6,
          barDir: "col",
          chartColors: [BLUE],
          showLegend: false,
          catAxisLabelFontSize: days.length > 14 ? 7 : 9,
          catAxisLabelFontFace: FONT,
          valAxisLabelFontSize: 8,
          valAxisLabelFormatCode: "#,##0",
          valGridLine: { color: "E5E7EB", size: 0.5 },
          showValue: days.length <= 10,
          dataLabelFormatCode: "#,##0",
          dataLabelFontSize: 8,
        });
      }
      box(s, M + chartW + 0.25, y2, W - 2 * M - chartW - 0.25, 3.9, labels.overallOpinion, r.comments.overallOpinion);
      notes(s, y2 + 4.05);
    }
    if (r.kind === "DAILY" && adjusted.size) s.addText(`* 담당자가 현장 기록으로 확인해 보정한 수치(${adjusted.size}건)`, { x: M, y: BOTTOM - 0.28, w: 7.9, h: 0.26, fontFace: FONT, fontSize: 8, color: "B45309" });

    // 실적 표(주간·월간): 일자별(16일씩 두 단) / 층·로봇·구역별
    if (r.kind !== "DAILY") {
      const days = a.byDay ?? [];
      if (days.length) {
        const sd = newSlide("일자별 실적");
        const half = Math.ceil(days.length / 2);
        const cols = days.length > 16 ? [days.slice(0, half), days.slice(half)] : [days];
        const tw = cols.length === 2 ? (W - 2 * M - 0.3) / 2 : 7.5;
        const rowH = Math.min(0.3, (BOTTOM - TOP - 0.5) / (Math.max(...cols.map((c) => c.length)) + 1));
        cols.forEach((part, i) =>
          table(sd, ["날짜", "작업(건)", "완료(건)", "면적(㎡)", "시간(분)"], part.map((d) => [`${md(d.date)} (${dow(d.date)})`, d.runs, d.completed, d.areaM2, d.durationMin]), { x: M + i * (tw + 0.3), y: TOP + 0.4, w: tw, colW: [tw * 0.24, tw * 0.17, tw * 0.17, tw * 0.22, tw * 0.2], fontSize: rowH < 0.27 ? 9 : 10, rowH }),
        );
        const tot = days.reduce((t, d) => ({ runs: t.runs + d.runs, completed: t.completed + d.completed, area: t.area + d.areaM2, min: t.min + d.durationMin }), { runs: 0, completed: 0, area: 0, min: 0 });
        sd.addText(`합계  작업 ${n0(tot.runs)}건 · 정상 완료 ${n0(tot.completed)}건 · 면적 ${n0(tot.area)}㎡ · 시간 ${n0(tot.min)}분`, { x: M, y: BOTTOM - 0.32, w: W - 2 * M, h: 0.3, fontFace: FONT, fontSize: 10, bold: true, color: NAVY, align: "right" });
      }
      const sf = newSlide("층 · 로봇 · 구역별 실적");
      const lw = (W - 2 * M - 0.3) / 2;
      sf.addText("층별", { x: M, y: TOP + 0.35, w: lw, h: 0.28, fontFace: FONT, fontSize: 11, bold: true, color: NAVY });
      table(sf, ["층", "작업(건)", "면적(㎡)", "시간(분)"], a.byFloor.map((f) => [f.floorName, f.runs, f.areaM2, f.durationMin]), { x: M, y: TOP + 0.65, w: lw, colW: [lw * 0.34, lw * 0.2, lw * 0.24, lw * 0.22], fontSize: 10 });
      const ry = TOP + 0.65 + 0.3 * (a.byFloor.length + 1) + 0.35;
      sf.addText("로봇별", { x: M, y: ry, w: lw, h: 0.28, fontFace: FONT, fontSize: 11, bold: true, color: NAVY });
      table(sf, ["로봇", "모델", "작업(건)", "완료(건)", "면적(㎡)"], a.byRobot.map((b) => [b.name, b.model, b.runs, b.completed, b.areaM2]), { x: M, y: ry + 0.3, w: lw, colW: [lw * 0.24, lw * 0.26, lw * 0.15, lw * 0.15, lw * 0.2], fontSize: 10 });
      const rx = M + lw + 0.3;
      if (a.byZone.length) {
        sf.addText("구역별(작업 면적을 구역 수로 나눈 근사)", { x: rx, y: TOP + 0.35, w: lw, h: 0.28, fontFace: FONT, fontSize: 11, bold: true, color: NAVY });
        table(sf, ["층", "구역", "작업(건)", "면적(㎡)"], a.byZone.map((z) => [z.floorName, z.zoneName, z.runs, z.areaM2]), { x: rx, y: TOP + 0.65, w: lw, colW: [lw * 0.24, lw * 0.36, lw * 0.18, lw * 0.22], fontSize: 9.5, rowH: Math.min(0.3, (BOTTOM - TOP - 0.8) / (a.byZone.length + 1)) });
      } else {
        box(sf, rx, TOP + 0.35, lw, 1.2, "구역별 실적", "제조사 실적에 구역 정보가 없어 층별·로봇별로 집계했습니다.");
      }
    }

    // 장애 · 점검
    if (a.incidents.length || a.inspections.length) {
      const si = newSlide("장애 · 조치 · 점검");
      const iw = a.inspections.length ? 8.6 : W - 2 * M;
      if (a.incidents.length) table(si, ["발생", "내용", "조치", "복구"], a.incidents.map((i) => [formatDateTime(i.occurredAt), i.customerMessage, i.actionSummary, i.resolvedAt ? formatDateTime(i.resolvedAt) : "미복구"]), { x: M, y: TOP + 0.4, w: iw, colW: [1.55, (iw - 3.1) / 2, (iw - 3.1) / 2, 1.55], fontSize: 9, rowH: 0.3 });
      else si.addText("이 기간에 기록된 장애가 없습니다.", { x: M, y: TOP + 0.45, w: iw, h: 0.35, fontFace: FONT, fontSize: 11, color: GRAY });
      if (a.inspections.length) table(si, ["점검 항목", "완료", "예정"], a.inspections.map((x) => [x.item, x.done, x.total]), { x: M + iw + 0.25, y: TOP + 0.4, w: W - 2 * M - iw - 0.25, colW: [2.0, 0.85, 0.83], fontSize: 10 });
    }

    // 의견 · 계획(주간·월간 — 일간은 1장에 있음)
    if (r.kind !== "DAILY") {
      const so = newSlide("의견 · 계획");
      const bw = (W - 2 * M - 0.25) / 2;
      const bh = (BOTTOM - TOP - 0.4 - 0.25) / 2;
      box(so, M, TOP + 0.4, bw, bh, labels.incompleteReasons, r.comments.incompleteReasons);
      box(so, M + bw + 0.25, TOP + 0.4, bw, bh, labels.improvements, r.comments.improvements);
      box(so, M, TOP + 0.65 + bh, bw, bh, labels.focusZones, r.comments.focusZones);
      box(so, M + bw + 0.25, TOP + 0.65 + bh, bw, bh, labels.nextMonthPlan, r.comments.nextMonthPlan);
    } else if (r.comments.improvements || r.comments.focusZones) {
      const so = newSlide("조치 · 집중 관리");
      const bw = (W - 2 * M - 0.25) / 2;
      box(so, M, TOP + 0.4, bw, 2.4, labels.improvements, r.comments.improvements);
      box(so, M + bw + 0.25, TOP + 0.4, bw, 2.4, labels.focusZones, r.comments.focusZones);
    }
    if (photos.length) await photoGrid(photos, 3, 2);
  }
  return (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
}

// =================================================================== XLSX
const XL_NAVY = `FF${NAVY}`;
const thin = { style: "thin" as const, color: { argb: "FFD9DEE7" } };
const BORDER = { top: thin, left: thin, bottom: thin, right: thin };

/** 표 시트 공통: 머리 행 스타일, 테두리, 숫자 서식, 틀 고정, 필터, 가로 인쇄. */
function styledSheet(wb: ExcelJS.Workbook, name: string, cols: { header: string; key: string; width: number; num?: "int" | "dec1" | "pct" }[], rows: Record<string, unknown>[], opts: { total?: Record<string, unknown> } = {}) {
  const ws = wb.addWorksheet(name, { pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 }, views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const head = ws.getRow(1);
  head.height = 22;
  head.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: XL_NAVY } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = BORDER;
  });
  for (const r of rows) ws.addRow(r);
  if (opts.total) {
    const t = ws.addRow(opts.total);
    t.font = { bold: true };
    t.eachCell((c) => (c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F6FA" } }));
  }
  const last = ws.rowCount;
  for (let i = 2; i <= last; i++) {
    const row = ws.getRow(i);
    cols.forEach((c, j) => {
      const cell = row.getCell(j + 1);
      cell.border = BORDER;
      cell.alignment = { vertical: "top", wrapText: true, horizontal: c.num ? "right" : "left" };
      if (c.num === "int") cell.numFmt = "#,##0";
      if (c.num === "dec1") cell.numFmt = "#,##0.0";
      if (c.num === "pct") cell.numFmt = "0.0";
    });
  }
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  return ws;
}

export async function buildXlsx(input: ExportInput): Promise<Buffer> {
  const { report: r, agg: a, content, photos } = input;
  const wb = new ExcelJS.Workbook();
  wb.creator = "청소로봇 통합관제";
  wb.created = new Date();
  const labels = commentLabels(r.kind);
  const adjusted = new Set(Object.keys(r.adjustments ?? {}));

  // ---- 요약
  const sum = wb.addWorksheet("요약", { pageSetup: { orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
  sum.columns = [{ width: 26 }, { width: 18 }, { width: 8 }, { width: 46 }];
  sum.mergeCells("A1:D1");
  sum.getCell("A1").value = `${r.siteName} 청소로봇 운영 리포트`;
  sum.getCell("A1").font = { bold: true, size: 16, color: { argb: XL_NAVY } };
  sum.getRow(1).height = 28;
  sum.mergeCells("A2:D2");
  sum.getCell("A2").value = `${r.title} · ${periodText(r)} · v${r.version} ${REPORT_STATUS_LABEL[r.status]} · 집계 ${formatDateTime(r.aggregates.generatedAt)}`;
  sum.getCell("A2").font = { color: { argb: "FF6B7280" } };
  const section = (title: string) => {
    const row = sum.addRow([title]);
    sum.mergeCells(`A${row.number}:D${row.number}`);
    row.getCell(1).font = { bold: true, size: 12, color: { argb: XL_NAVY } };
    row.height = 22;
  };
  const headRow = (cells: string[]) => {
    const row = sum.addRow(cells);
    row.eachCell((c) => {
      c.font = { bold: true, color: { argb: "FFFFFFFF" } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: XL_NAVY } };
      c.alignment = { horizontal: "center", vertical: "middle" };
      c.border = BORDER;
    });
  };
  sum.addRow([]);
  if (r.kind === "INSTALLATION") {
    section("단계 일정");
    headRow(["단계", "시작", "", "끝"]);
    for (const p of content.phases ?? []) {
      const row = sum.addRow([p.label, p.from, "~", p.to]);
      row.getCell(3).alignment = { horizontal: "center" };
      row.eachCell({ includeEmpty: true }, (c) => (c.border = BORDER));
    }
    const ins = a.installation;
    const maps = ins?.maps ?? [];
    const weekly = ins?.weekly ?? [];
    sum.addRow([]);
    section("설치 요약");
    headRow(["항목", "값", "단위", "비고"]);
    for (const [l, v, u, nt] of [
      ["설치 로봇", ins?.robots.length ?? 0, "대", ""],
      ["청소 구역", maps.reduce((t, m) => t + m.zones.length, 0), "개", `합계 ${n0(maps.reduce((t, m) => t + m.zones.reduce((x, z) => x + z.areaM2, 0), 0))}㎡`],
      ["주간 예약", weekly.reduce((t, w) => t + w.daysOfWeek.length, 0), "회", ""],
    ] as const) {
      const row = sum.addRow([l, v, u, nt]);
      row.getCell(2).numFmt = "#,##0";
      row.eachCell({ includeEmpty: true }, (c) => (c.border = BORDER));
    }
  } else {
    section("핵심 지표");
    headRow(["지표", "값", "단위", "비고"]);
    const rows: [string, number | string | null, string, string, string[]][] = [
      ["운영 대수", a.robotCount, "대", "", ["robotCount"]],
      ["유효 계획 회차", a.validPlanned, "회", "취소·제외 빼고, 아직 안 된 미래 회차 제외", ["validPlanned"]],
      ["정상 완료(계획)", a.plannedCompleted, "회", "", ["plannedCompleted"]],
      ["계획 완료율", a.completionRatePct ?? "해당 없음", "%", "정상 완료 ÷ 유효 계획", ["completionRatePct", "plannedCompleted", "validPlanned"]],
      ["총 작업", a.totalRuns, "건", "", ["totalRuns"]],
      ["즉시·원격 작업", a.adhocRuns, "건", "총 작업에 포함, 완료율 계산에서는 제외", ["adhocRuns"]],
      ["누적 청소 면적", a.cumulativeAreaM2, "㎡", "반복 구역 포함(고유 면적 아님)", ["cumulativeAreaM2"]],
      ["총 작업 시간", a.totalDurationMin, "분", hm(a.totalDurationMin), ["totalDurationMin"]],
      ["물 사용량", a.waterL ?? "미제공", "L", "", ["waterL"]],
      ["세제 사용량", a.detergentMl ?? "미제공", "mL", "", ["detergentMl"]],
      ["미실행 / 취소 / 제외", `${a.missed} / ${a.cancelled} / ${a.excluded}`, "회", "", ["missed", "cancelled", "excluded"]],
      ["장애", a.incidents.length, "건", "", []],
    ];
    for (const [l, v, u, nt, keys] of rows) {
      const mark = keys.some((k) => adjusted.has(`summary.${k}`));
      const row = sum.addRow([l, v, u, [nt, mark ? "* 담당자 보정" : ""].filter(Boolean).join(" · ")]);
      const vc = row.getCell(2);
      if (typeof v === "number") vc.numFmt = u === "%" ? "0.0" : u === "L" ? "#,##0.0" : "#,##0";
      vc.alignment = { horizontal: "right" };
      row.getCell(3).alignment = { horizontal: "center" };
      row.eachCell({ includeEmpty: true }, (c) => (c.border = BORDER));
      if (mark) row.getCell(4).font = { color: { argb: "FFB45309" } };
    }
  }
  sum.addRow([]);
  section("의견");
  for (const [h, t] of [
    [labels.overallOpinion, r.comments.overallOpinion],
    [labels.incompleteReasons, r.comments.incompleteReasons],
    [labels.improvements, r.comments.improvements],
    [labels.focusZones, r.comments.focusZones],
    [labels.nextMonthPlan, r.comments.nextMonthPlan],
  ]) {
    const row = sum.addRow([h, t || "(작성 전)"]);
    sum.mergeCells(`B${row.number}:D${row.number}`);
    row.getCell(1).font = { bold: true };
    row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F6FA" } };
    row.getCell(1).alignment = { vertical: "top" };
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
    row.height = Math.max(20, Math.ceil(((t || " ").length + 1) / 34) * 16 + (t.match(/\n/g)?.length ?? 0) * 16);
    for (let c = 1; c <= 4; c++) row.getCell(c).border = BORDER;
  }
  if (a.unsupportedMetrics.length) {
    sum.addRow([]);
    for (const m of a.unsupportedMetrics) {
      const row = sum.addRow([`· ${m}`]);
      sum.mergeCells(`A${row.number}:D${row.number}`);
      row.getCell(1).font = { size: 9, color: { argb: "FF6B7280" } };
    }
  }

  // ---- 작업 일지
  const log = (content.workLog ?? []).filter((w) => w.part || w.staff || w.content);
  if (log.length) styledSheet(wb, "작업 일지", [{ header: "구분", key: "part", width: 12 }, { header: "담당", key: "staff", width: 18 }, { header: "작업 내용", key: "content", width: 80 }], log.map((w) => ({ ...w, content: bullets(w.content) })));

  if (r.kind === "INSTALLATION" && a.installation) {
    const ins = a.installation;
    styledSheet(wb, "설치 로봇", [{ header: "로봇", key: "name", width: 22 }, { header: "모델", key: "model", width: 18 }, { header: "배치 층", key: "floorName", width: 16 }], ins.robots);
    styledSheet(
      wb,
      "주간 예약",
      [{ header: "시각", key: "time", width: 8 }, { header: "로봇", key: "robot", width: 16 }, { header: "작업", key: "task", width: 30 }, { header: "층", key: "floor", width: 12 }, ...WEEK.map((d) => ({ header: DAY_LABEL[d], key: `d${d}`, width: 5 })), { header: "예상 소요(분)", key: "dur", width: 12, num: "int" as const }],
      (ins.weekly ?? []).map((w) => ({ time: w.time, robot: w.robotName, task: w.taskName, floor: w.floorName, dur: w.durationMin ?? "미정", ...Object.fromEntries(WEEK.map((d) => [`d${d}`, w.daysOfWeek.includes(d) ? "●" : ""])) })),
    ).eachRow((row, i) => i > 1 && WEEK.forEach((_, k) => (row.getCell(5 + k).alignment = { horizontal: "center" })));
    const wz = styledSheet(wb, "청소 구역", [{ header: "층", key: "floor", width: 14 }, { header: "구역", key: "zone", width: 26 }, { header: "면적(㎡)", key: "area", width: 12, num: "int" }, { header: "지도 색", key: "color", width: 9 }], (ins.maps ?? []).flatMap((m) => m.zones.map((z) => ({ floor: m.floorName, zone: z.name, area: z.areaM2, color: "" }))));
    let i = 2;
    for (const m of ins.maps ?? []) m.zones.forEach((_, k) => (wz.getRow(i++).getCell(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${PALETTE[k % PALETTE.length]}` } }));
    if ((ins.maps ?? []).length) {
      const wm = wb.addWorksheet("지도", { pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
      wm.getColumn(1).width = 120;
      let row = 1;
      for (const m of ins.maps ?? []) {
        wm.getCell(row, 1).value = `< ${m.floorName} > 청소 구역 ${m.zones.length}개 — 색은 '청소 구역' 시트 참고`;
        wm.getCell(row, 1).font = { bold: true, size: 12, color: { argb: XL_NAVY } };
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
      const n = a.byDay.length + 1;
      styledSheet(
        wb,
        "일자별",
        [{ header: "날짜", key: "date", width: 13 }, { header: "요일", key: "dow", width: 6 }, { header: "작업(건)", key: "runs", width: 10, num: "int" }, { header: "정상 완료(건)", key: "completed", width: 13, num: "int" }, { header: "누적 면적(㎡)", key: "areaM2", width: 14, num: "int" }, { header: "작업 시간(분)", key: "durationMin", width: 14, num: "int" }],
        a.byDay.map((d) => ({ ...d, dow: dow(d.date) })),
        { total: { date: "합계", runs: { formula: `SUM(C2:C${n})` }, completed: { formula: `SUM(D2:D${n})` }, areaM2: { formula: `SUM(E2:E${n})` }, durationMin: { formula: `SUM(F2:F${n})` } } },
      );
    }
    if (a.runList?.length)
      styledSheet(wb, "작업 목록", [{ header: "시작", key: "t", width: 18 }, { header: "로봇", key: "robot", width: 16 }, { header: "층", key: "floor", width: 14 }, { header: "구분", key: "origin", width: 8 }, { header: "결과", key: "result", width: 10 }, { header: "면적(㎡)", key: "area", width: 11, num: "int" }, { header: "시간(분)", key: "dur", width: 10, num: "int" }], a.runList.map((x) => ({ t: formatDateTime(x.startedAt), robot: x.robotName, floor: x.floorName, origin: originLabel(x.origin), result: x.result, area: x.areaM2, dur: x.durationMin })));
    styledSheet(wb, "층별", [{ header: "층", key: "floorName", width: 16 }, { header: "작업(건)", key: "runs", width: 10, num: "int" }, { header: "누적 면적(㎡)", key: "areaM2", width: 14, num: "int" }, { header: "작업 시간(분)", key: "durationMin", width: 14, num: "int" }], a.byFloor);
    if (a.byZone.length) styledSheet(wb, "구역별", [{ header: "층", key: "floorName", width: 14 }, { header: "구역", key: "zoneName", width: 24 }, { header: "작업(건)", key: "runs", width: 10, num: "int" }, { header: "배분 면적(㎡, 근사)", key: "areaM2", width: 18, num: "int" }], a.byZone);
    styledSheet(wb, "로봇별", [{ header: "로봇", key: "name", width: 16 }, { header: "모델", key: "model", width: 18 }, { header: "작업(건)", key: "runs", width: 10, num: "int" }, { header: "정상 완료(건)", key: "completed", width: 13, num: "int" }, { header: "누적 면적(㎡)", key: "areaM2", width: 14, num: "int" }], a.byRobot);
    styledSheet(wb, "장애", [{ header: "발생", key: "at", width: 18 }, { header: "내용", key: "msg", width: 44 }, { header: "조치", key: "act", width: 44 }, { header: "복구", key: "res", width: 18 }], a.incidents.map((i) => ({ at: formatDateTime(i.occurredAt), msg: i.customerMessage, act: i.actionSummary, res: i.resolvedAt ? formatDateTime(i.resolvedAt) : "미복구" })));
    if (a.inspections.length) styledSheet(wb, "점검", [{ header: "항목", key: "item", width: 22 }, { header: "완료", key: "done", width: 8, num: "int" }, { header: "예정", key: "total", width: 8, num: "int" }], a.inspections);
  }

  if (photos.length) {
    const wp = wb.addWorksheet("사진", { pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
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

  const adjRows = input.includeAdjustLog ? Object.entries(r.adjustments ?? {}) : [];
  if (adjRows.length) styledSheet(wb, "보정 내역", [{ header: "항목", key: "k", width: 40 }, { header: "원래 집계", key: "o", width: 12, num: "int" }, { header: "보정값", key: "v", width: 12, num: "int" }, { header: "보정 시각", key: "at", width: 20 }], adjRows.map(([k, v]) => ({ k, o: v.original ?? "미제공", v: v.value, at: formatDateTime(v.at) })));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
