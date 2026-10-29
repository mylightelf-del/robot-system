"use client";

import { useState } from "react";
import { createFloorAction, createSiteAction, deleteFloorAction, deleteSiteAction, importPuduMapAction, listPuduMapsAction, refetchMapImageAction, renameFloorAction, updateSiteAction } from "@/app/actions";
import { btn, ResultLine, useAction } from "./ActionButton";

type FloorInfo = { id: string; name: string; map: { id: string; version: number; vendor: string | null; vendorMapName: string | null; imageUrl: string | null; widthPx: number; heightPx: number; hasCorners: boolean } | null; zones: number; robots: string[] };
type SiteInfo = { id: string; name: string; address: string; timezone: string; isSample: boolean; floors: FloorInfo[]; hasPuduRobot: boolean };

/** 사업장 추가 폼(본사 관리자). 시간대 기본 Asia/Seoul. */
export function NewSiteForm() {
  const { pending, result, run } = useAction();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [timezone, setTimezone] = useState("Asia/Seoul");
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap gap-2">
        <input className="border rounded px-2 py-1" placeholder="사업장 이름 (예: 포스코센터 선릉)" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="border rounded px-2 py-1 min-w-[260px]" placeholder="주소" value={address} onChange={(e) => setAddress(e.target.value)} />
        <input className="border rounded px-2 py-1 w-36" placeholder="시간대" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        <button type="button" className={btn.primary} disabled={pending || name.trim().length < 2} onClick={() => run(() => createSiteAction({ name, address, timezone }))}>
          사업장 추가
        </button>
      </div>
      <ResultLine result={result} />
    </div>
  );
}

export function SiteCard({ site }: { site: SiteInfo }) {
  const { pending, result, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(site.name);
  const [address, setAddress] = useState(site.address);
  const [timezone, setTimezone] = useState(site.timezone);
  const [newFloor, setNewFloor] = useState("");
  const deletable = site.floors.length === 0;
  return (
    <div className="border rounded p-3 text-sm">
      {editing ? (
        <div className="flex flex-wrap gap-1 items-center">
          <input className="border rounded px-2 py-1" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="border rounded px-2 py-1 min-w-[220px]" value={address} onChange={(e) => setAddress(e.target.value)} />
          <input className="border rounded px-2 py-1 w-32" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
          <button type="button" className={btn.small} disabled={pending} onClick={() => run(async () => { const r = await updateSiteAction(site.id, { name, address, timezone }); if (r.ok) setEditing(false); return r; })}>저장</button>
          <button type="button" className={btn.small} onClick={() => setEditing(false)}>취소</button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <div>
            <div className="font-semibold text-navy">{site.name}</div>
            <div className="text-xs text-gray-500">{site.address || "(주소 없음)"} · {site.timezone}{site.isSample ? " · 샘플" : ""} · <span className="font-mono">{site.id}</span></div>
          </div>
          <div className="ml-auto flex gap-1">
            <button type="button" className={btn.small} onClick={() => setEditing(true)}>수정</button>
            {deletable && (
              <button type="button" className={btn.small} disabled={pending} onClick={() => { if (confirm(`사업장 '${site.name}' 을(를) 삭제할까요?`)) run(() => deleteSiteAction(site.id)); }}>삭제</button>
            )}
          </div>
        </div>
      )}
      <ul className="mt-2 space-y-2">
        {site.floors.map((f) => (
          <FloorRow key={f.id} siteId={site.id} floor={f} hasPuduRobot={site.hasPuduRobot} />
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap gap-1 items-center">
        <input className="border rounded px-2 py-1 w-40" placeholder="층 추가 (예: 1층, B1)" value={newFloor} onChange={(e) => setNewFloor(e.target.value)} />
        <button type="button" className={btn.small} disabled={pending || !newFloor.trim()} onClick={() => run(async () => { const r = await createFloorAction(site.id, newFloor); if (r.ok) setNewFloor(""); return r; })}>층 추가</button>
      </div>
      <ResultLine result={result} />
    </div>
  );
}

function FloorRow({ siteId, floor, hasPuduRobot }: { siteId: string; floor: FloorInfo; hasPuduRobot: boolean }) {
  const { pending, result, run } = useAction();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(floor.name);
  const [maps, setMaps] = useState<{ name: string; floor: string; is_used?: number }[] | null>(null);
  const [mapName, setMapName] = useState("");
  const m = floor.map;
  return (
    <li className="border-t pt-2">
      <div className="flex flex-wrap items-center gap-1">
        {renaming ? (
          <>
            <input className="border rounded px-2 py-0.5 w-32" value={name} onChange={(e) => setName(e.target.value)} />
            <button type="button" className={btn.small} disabled={pending} onClick={() => run(async () => { const r = await renameFloorAction(floor.id, name); if (r.ok) setRenaming(false); return r; })}>저장</button>
            <button type="button" className={btn.small} onClick={() => setRenaming(false)}>취소</button>
          </>
        ) : (
          <>
            <span className="font-medium">{floor.name}</span>
            <span className="text-xs text-gray-500">
              지도 v{m?.version ?? "-"}
              {m?.imageUrl ? ` · ${m.vendor} ${m.vendorMapName} (${m.widthPx}×${m.heightPx}px)${m.imageUrl.startsWith("/api/") ? " · 이미지 보관됨" : " · 이미지 원격 참조(보관 실패)"}` : " · 샘플/빈 지도"}
              {m && !m.hasCorners ? " · 모서리 좌표 없음" : ""}
              {` · 구역 ${floor.zones}개`}
            </span>
            <button type="button" className={btn.small} onClick={() => setRenaming(true)}>이름</button>
            {floor.robots.length === 0 && (
              <button type="button" className={btn.small} disabled={pending} onClick={() => { if (confirm(`층 '${floor.name}' 을(를) 삭제할까요?`)) run(() => deleteFloorAction(floor.id)); }}>삭제</button>
            )}
            {m?.imageUrl && !m.imageUrl.startsWith("/api/") && (
              <button type="button" className={btn.small} disabled={pending} onClick={() => run(() => refetchMapImageAction(m.id))}>이미지 다시 받기</button>
            )}
            {hasPuduRobot && (
              <button
                type="button"
                className={btn.small}
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    const r = await listPuduMapsAction(siteId);
                    if (r.ok && r.maps) {
                      setMaps(r.maps);
                      setMapName(r.maps.find((x) => x.name === m?.vendorMapName)?.name ?? r.maps[0]?.name ?? "");
                    }
                    return r;
                  })
                }
              >
                PUDU 지도 가져오기…
              </button>
            )}
          </>
        )}
      </div>
      <div className="text-xs text-gray-600 ml-1">로봇: {floor.robots.join(", ") || "없음"}</div>
      {maps && (
        <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
          <select className="border rounded px-2 py-1 max-w-[360px]" value={mapName} onChange={(e) => setMapName(e.target.value)}>
            {maps.map((x) => (
              <option key={x.name} value={x.name}>
                {x.floor}층 · {x.name}{x.is_used === 1 ? " (사용 중)" : ""}
              </option>
            ))}
          </select>
          <button type="button" className={btn.primary} disabled={pending || !mapName} onClick={() => run(async () => { const r = await importPuduMapAction(floor.id, mapName); if (r.ok) setMaps(null); return r; })}>
            이 층의 지도로 가져오기
          </button>
          <button type="button" className={btn.small} onClick={() => setMaps(null)}>닫기</button>
          <span className="text-gray-500">지도 이름 『층#버전#이름』 에서 층 번호가 이 층과 맞는지 확인하세요. 가져오면 새 지도 버전이 되고 PUDU 구역(area)이 구역으로 들어옵니다.</span>
        </div>
      )}
      <ResultLine result={result} />
    </li>
  );
}
