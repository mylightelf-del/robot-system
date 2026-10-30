"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ReportContent, ReportPhoto } from "@/lib/domain/types";
import { adjustNumberAction, deletePhotoAction, updateContentAction, updatePhotoCaptionAction } from "@/app/actions";
import { btn, ResultLine, useAction } from "./ActionButton";

/** 수치 수정 칸(수정 모드). 바꾼 뒤 칸을 벗어나면 저장한다. 원래 값과 다르면 되돌리기 버튼이 나온다. */
export function EditableNum({ reportId, k, value, original, unit, step = 1 }: { reportId: string; k: string; value: number | null; original: number | null; unit?: string; step?: number }) {
  const router = useRouter();
  const [v, setV] = useState(value === null ? "" : String(value));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const adjusted = value !== original;
  const save = async (next: number | null) => {
    setBusy(true);
    setErr(null);
    const r = await adjustNumberAction(reportId, k, next);
    setBusy(false);
    if (!r.ok) setErr(r.error ?? "실패");
    else router.refresh();
  };
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      <input
        type="number"
        min={0}
        step={step}
        className={`w-24 border rounded px-1 py-0.5 text-right text-sm ${adjusted ? "border-amber-500 bg-amber-50" : "border-gray-300"}`}
        value={v}
        disabled={busy}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          const n = v.trim() === "" ? null : Number(v);
          if (n === value || (n !== null && Number.isNaN(n))) return;
          void save(n);
        }}
        aria-label={k}
      />
      {unit && <span className="text-xs text-gray-500">{unit}</span>}
      {adjusted && (
        <button type="button" className="text-[11px] text-amber-800 underline" title={`원래 값 ${original ?? "미제공"}`} disabled={busy} onClick={() => { setV(original === null ? "" : String(original)); void save(null); }}>
          되돌리기({original ?? "-"})
        </button>
      )}
      {err && <span className="text-[11px] text-red-700">{err}</span>}
    </span>
  );
}

const isoOk = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** 단계 일정 편집(설치 보고서). */
export function PhaseEditor({ reportId, phases }: { reportId: string; phases: NonNullable<ReportContent["phases"]> }) {
  const [rows, setRows] = useState(phases);
  const { pending, result, run } = useAction();
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-1 text-sm">
      {rows.map((p, i) => (
        <div key={i} className="flex flex-wrap gap-1 items-center">
          <input className="border rounded px-2 py-1 w-44" value={p.label} onChange={(e) => set(i, { label: e.target.value })} placeholder="단계 이름" />
          <input type="date" className="border rounded px-2 py-1" value={p.from} onChange={(e) => set(i, { from: e.target.value })} />
          <span>~</span>
          <input type="date" className="border rounded px-2 py-1" value={p.to} onChange={(e) => set(i, { to: e.target.value })} />
          <button type="button" className={btn.small} onClick={() => setRows(rows.filter((_, j) => j !== i))}>삭제</button>
        </div>
      ))}
      <div className="flex gap-1">
        <button type="button" className={btn.small} disabled={rows.length >= 8} onClick={() => setRows([...rows, { label: "", from: rows.at(-1)?.to ?? "", to: rows.at(-1)?.to ?? "" }])}>단계 추가</button>
        <button type="button" className={btn.primary} disabled={pending || rows.some((r) => !isoOk(r.from) || !isoOk(r.to))} onClick={() => run(() => updateContentAction(reportId, { phases: rows }))}>단계 저장</button>
      </div>
      <ResultLine result={result} />
    </div>
  );
}

/** 작업 일지 편집(구분·담당·작업 내용). */
export function WorkLogEditor({ reportId, rows: initial }: { reportId: string; rows: NonNullable<ReportContent["workLog"]> }) {
  const [rows, setRows] = useState(initial.length ? initial : [{ part: "", staff: "", content: "" }]);
  const { pending, result, run } = useAction();
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-1 text-sm">
      {rows.map((w, i) => (
        <div key={i} className="grid grid-cols-[6rem_8rem_1fr_auto] gap-1 items-start">
          <input className="border rounded px-2 py-1" value={w.part} onChange={(e) => set(i, { part: e.target.value })} placeholder="구분" />
          <input className="border rounded px-2 py-1" value={w.staff} onChange={(e) => set(i, { staff: e.target.value })} placeholder="담당" />
          <textarea className="border rounded px-2 py-1 min-h-[56px]" value={w.content} onChange={(e) => set(i, { content: e.target.value })} placeholder="작업 내용(줄마다 한 항목)" />
          <button type="button" className={btn.small} onClick={() => setRows(rows.filter((_, j) => j !== i))}>삭제</button>
        </div>
      ))}
      <div className="flex gap-1">
        <button type="button" className={btn.small} disabled={rows.length >= 20} onClick={() => setRows([...rows, { part: "", staff: "", content: "" }])}>행 추가</button>
        <button type="button" className={btn.primary} disabled={pending} onClick={() => run(() => updateContentAction(reportId, { workLog: rows }))}>작업 일지 저장</button>
      </div>
      <ResultLine result={result} />
    </div>
  );
}

/** 사진을 긴 변 maxPx 의 JPEG 로 줄인다(휴대폰 원본 수 MB → 수백 KB). */
async function shrink(file: File, maxPx = 1600): Promise<Blob> {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("변환 실패"))), "image/jpeg", 0.85));
}

/** 현장 사진: 보기 + (편집 가능하면) 올리기·설명 수정·삭제. */
export function PhotoPanel({ reportId, photos, editable }: { reportId: string; photos: ReportPhoto[]; editable: boolean }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [caption, setCaption] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setMsg(null);
    let okCount = 0;
    for (const f of Array.from(files)) {
      try {
        const blob = await shrink(f);
        const fd = new FormData();
        fd.append("file", blob, f.name.replace(/\.[^.]+$/, "") + ".jpg");
        fd.append("caption", caption || f.name.replace(/\.[^.]+$/, ""));
        const res = await fetch(`/api/reports/${encodeURIComponent(reportId)}/photos`, { method: "POST", body: fd });
        const j = (await res.json()) as { ok: boolean; error?: string };
        if (!j.ok) throw new Error(j.error ?? "실패");
        okCount += 1;
      } catch (e) {
        setMsg(`${f.name}: ${(e as Error).message}`);
      }
    }
    setBusy(false);
    setCaption("");
    if (fileRef.current) fileRef.current.value = "";
    if (okCount) router.refresh();
  };
  return (
    <div>
      {photos.length === 0 ? (
        <p className="text-sm text-gray-500 mb-2">{editable ? "아직 사진이 없습니다. 제품 입고·충전 스테이션·맵핑 사진 등을 올리세요." : "첨부 사진이 없습니다."}</p>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-2">
          {photos.map((p) => (
            <PhotoCard key={p.id} photo={p} editable={editable} />
          ))}
        </div>
      )}
      {editable && (
        <div className="flex flex-wrap gap-2 items-center text-sm print:hidden">
          <input className="border rounded px-2 py-1 w-56" placeholder="사진 설명(예: 충전스테이션 사진)" value={caption} onChange={(e) => setCaption(e.target.value)} />
          <input ref={fileRef} type="file" accept="image/*" multiple disabled={busy} onChange={(e) => void upload(e.target.files)} className="text-xs" />
          {busy && <span className="text-xs text-gray-500">올리는 중…</span>}
          {msg && <span className="text-xs text-red-700">{msg}</span>}
        </div>
      )}
    </div>
  );
}

function PhotoCard({ photo, editable }: { photo: ReportPhoto; editable: boolean }) {
  const router = useRouter();
  const [cap, setCap] = useState(photo.caption);
  const { pending, result, run } = useAction();
  return (
    <figure className="border rounded overflow-hidden bg-white break-inside-avoid">
      {/* eslint-disable-next-line @next/next/no-img-element -- 세션 인증이 필요한 사진이라 next/image 최적화를 쓰지 않는다 */}
      <img src={`/api/reports/photos/${photo.id}`} alt={photo.caption || "현장 사진"} className="w-full h-40 object-cover" loading="lazy" />
      {editable ? (
        <div className="p-1 flex gap-1 items-center print:hidden">
          <input className="border rounded px-1 py-0.5 text-xs flex-1 min-w-0" value={cap} onChange={(e) => setCap(e.target.value)} onBlur={() => cap !== photo.caption && run(() => updatePhotoCaptionAction(photo.id, cap))} />
          <button type="button" className="text-[11px] text-red-700 underline" disabled={pending} onClick={() => confirm("이 사진을 삭제할까요?") && run(async () => { const r = await deletePhotoAction(photo.id); if (r.ok) router.refresh(); return r; })}>
            삭제
          </button>
        </div>
      ) : null}
      <figcaption className={`text-center text-xs py-1 ${editable ? "hidden print:block" : ""}`}>&lt; {photo.caption || "현장 사진"} &gt;</figcaption>
      <ResultLine result={result} />
    </figure>
  );
}
