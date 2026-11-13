"use client";

import { useState } from "react";
import { deleteDeliveryRecipientsAction, deliverySyncNowAction, saveDeliveryRecipientsAction, setDeliveryRobotSiteAction } from "@/app/actions";
import { btn, ResultLine, useAction } from "./ActionButton";

type Channel = "PUSH" | "EMAIL" | "KAKAO";
const CH_LABEL: Record<Channel, string> = { PUSH: "앱 푸시", EMAIL: "메일", KAKAO: "카카오톡" };

export function DeliverySyncButton() {
  const { pending, result, run } = useAction();
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" className={btn.small} disabled={pending} onClick={() => run(() => deliverySyncNowAction())}>지금 동기화(로봇·상태)</button>
      <ResultLine result={result} />
    </span>
  );
}

export function RobotSiteSelect({ robotId, siteId, sites }: { robotId: string; siteId: string | null; sites: { id: string; name: string }[] }) {
  const { pending, result, run } = useAction();
  return (
    <span className="inline-flex items-center gap-1">
      <select className="border rounded px-1.5 py-0.5 text-xs" disabled={pending} value={siteId ?? ""} onChange={(e) => run(() => setDeliveryRobotSiteAction(robotId, e.target.value || null))}>
        <option value="">(사업장 미지정)</option>
        {sites.map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
      {result && !result.ok ? <ResultLine result={result} /> : null}
    </span>
  );
}

/** 목적지 → 수신자(직원) 설정. 기존 행 수정·삭제와 새 행 추가. '*' 는 사업장 기본 수신자. */
export function RecipientsEditor({
  sites,
  users,
  rows,
  destinationsBySite,
}: {
  sites: { id: string; name: string }[];
  users: { id: string; name: string; email: string }[];
  rows: { id: string; siteId: string; destination: string; userIds: string[]; channels: Channel[]; enabled: boolean }[];
  destinationsBySite: Record<string, string[]>;
}) {
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  const known = destinationsBySite[siteId] ?? [];
  const mine = rows.filter((r) => r.siteId === siteId).sort((a, b) => (a.destination === "*" ? -1 : b.destination === "*" ? 1 : a.destination.localeCompare(b.destination, "ko", { numeric: true })));
  const unused = known.filter((d) => !mine.some((r) => r.destination === d));
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-600">사업장</span>
        <select className="border rounded px-2 py-1" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <span className="text-xs text-gray-500">목적지별로 받을 직원을 고릅니다. 목적지 행이 없으면 「* 기본 수신자」가 받습니다.</span>
      </div>
      <div className="space-y-2">
        {mine.map((r) => (
          <RecipientRow key={r.id} siteId={siteId} users={users} initial={r} />
        ))}
        <RecipientRow key={`new-${siteId}`} siteId={siteId} users={users} suggestions={["*", ...unused]} />
      </div>
    </div>
  );
}

function RecipientRow({ siteId, users, initial, suggestions }: { siteId: string; users: { id: string; name: string; email: string }[]; initial?: { id: string; destination: string; userIds: string[]; channels: Channel[]; enabled: boolean }; suggestions?: string[] }) {
  const { pending, result, run } = useAction();
  const [dest, setDest] = useState(initial?.destination ?? "");
  const [userIds, setUserIds] = useState<string[]>(initial?.userIds ?? []);
  const [channels, setChannels] = useState<Channel[]>(initial?.channels ?? ["PUSH", "EMAIL"]);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <div className={`rounded-lg border p-2 ${initial ? "bg-white" : "bg-slate-50 border-dashed"}`}>
      <div className="flex flex-wrap items-center gap-2">
        {initial ? (
          <b className="min-w-16">{initial.destination === "*" ? "* 기본 수신자" : initial.destination}</b>
        ) : (
          <>
            <input className="border rounded px-2 py-1 w-36" list={`dest-${siteId}`} placeholder="목적지(예: 2601) 또는 *" value={dest} onChange={(e) => setDest(e.target.value)} />
            <datalist id={`dest-${siteId}`}>{(suggestions ?? []).map((d) => <option key={d} value={d} />)}</datalist>
          </>
        )}
        <span className="text-xs text-gray-500">채널</span>
        {(["PUSH", "EMAIL", "KAKAO"] as Channel[]).map((c) => (
          <label key={c} className="inline-flex items-center gap-1 text-xs">
            <input type="checkbox" checked={channels.includes(c)} onChange={() => setChannels((s) => toggle(s, c))} /> {CH_LABEL[c]}
          </label>
        ))}
        <label className="inline-flex items-center gap-1 text-xs ml-2">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> 사용
        </label>
        <span className="ml-auto flex gap-1">
          <button type="button" className={btn.small} disabled={pending || !(initial?.destination ?? dest).trim()} onClick={() => run(async () => { const r = await saveDeliveryRecipientsAction({ siteId, destination: initial?.destination ?? dest, userIds, channels, enabled }); if (r.ok && !initial) { setDest(""); setUserIds([]); } return r; })}>
            {initial ? "저장" : "추가"}
          </button>
          {initial && (
            <button type="button" className={btn.small} disabled={pending} onClick={() => { if (confirm(`'${initial.destination}' 수신자 설정을 삭제할까요?`)) run(() => deleteDeliveryRecipientsAction(initial.id)); }}>삭제</button>
          )}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        {users.map((u) => (
          <label key={u.id} className="inline-flex items-center gap-1 text-xs" title={u.email}>
            <input type="checkbox" checked={userIds.includes(u.id)} onChange={() => setUserIds((s) => toggle(s, u.id))} /> {u.name}
          </label>
        ))}
      </div>
      <ResultLine result={result} />
    </div>
  );
}
