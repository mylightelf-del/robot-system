"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { deleteIncidentPhotoAction } from "@/app/actions";

type Photo = { id: string; caption: string; internal: boolean; createdAt: string };

async function shrink(file: File, maxPx = 1600): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("변환 실패"))), "image/jpeg", 0.85));
}

/** 장애 조치 사진: 썸네일 보기 + (담당자) 올리기·삭제. 고객에게는 비내부 사진만 내려온다. */
export function IncidentPhotos({ incidentId, photos, canEdit }: { incidentId: string; photos: Photo[]; canEdit: boolean }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [caption, setCaption] = useState("");
  const [internal, setInternal] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setMsg(null);
    let ok = 0;
    for (const f of Array.from(files)) {
      try {
        const blob = await shrink(f);
        const fd = new FormData();
        fd.append("file", blob, f.name.replace(/\.[^.]+$/, "") + ".jpg");
        fd.append("caption", caption || f.name.replace(/\.[^.]+$/, ""));
        fd.append("internal", internal ? "1" : "0");
        const res = await fetch(`/api/incidents/${encodeURIComponent(incidentId)}/photos`, { method: "POST", body: fd });
        const j = (await res.json()) as { ok: boolean; error?: string };
        if (!j.ok) throw new Error(j.error ?? "실패");
        ok += 1;
      } catch (e) {
        setMsg(`${f.name}: ${(e as Error).message}`);
      }
    }
    setBusy(false);
    setCaption("");
    if (fileRef.current) fileRef.current.value = "";
    if (ok) router.refresh();
  };
  if (photos.length === 0 && !canEdit) return null;
  return (
    <div className="mt-1 text-xs">
      {photos.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {photos.map((p) => (
            <figure key={p.id} className="relative w-24">
              <a href={`/api/incidents/photos/${encodeURIComponent(p.id)}`} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/incidents/photos/${encodeURIComponent(p.id)}`} alt={p.caption || "조치 사진"} className="w-24 h-20 object-cover rounded border" loading="lazy" />
              </a>
              <figcaption className="truncate text-gray-600" title={p.caption}>
                {p.internal ? <span className="text-amber-700">[내부] </span> : null}
                {p.caption || "사진"}
              </figcaption>
              {canEdit && (
                <button
                  type="button"
                  className="absolute -top-1 -right-1 rounded-full bg-white border text-[10px] px-1 leading-4"
                  title="삭제"
                  onClick={() => {
                    if (confirm("이 사진을 삭제할까요?")) void deleteIncidentPhotoAction(p.id).then(() => router.refresh());
                  }}
                >
                  ×
                </button>
              )}
            </figure>
          ))}
        </div>
      )}
      {canEdit && (
        <div className="mt-1 flex flex-wrap items-center gap-1 no-print">
          <input className="border rounded px-1 py-0.5 w-40" placeholder="사진 설명" value={caption} onChange={(e) => setCaption(e.target.value)} />
          <label className="inline-flex items-center gap-1">
            <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> 내부(고객 비공개)
          </label>
          <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple disabled={busy} onChange={(e) => void upload(e.target.files)} className="text-xs" />
          {busy && <span className="text-gray-500">올리는 중…</span>}
          {msg && <span className="text-red-700">{msg}</span>}
        </div>
      )}
    </div>
  );
}
