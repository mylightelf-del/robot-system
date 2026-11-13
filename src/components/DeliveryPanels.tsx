"use client";

import { useState } from "react";
import { callDeliveryRobotAction, cancelDeliveryCallAction, deleteDeliveryRecipientsAction, deliverySyncNowAction, dispatchDeliveryAction, saveDeliveryRecipientsAction, setDeliveryRobotSiteAction } from "@/app/actions";
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

/** 배송 보내기·호출(Wide Bot 에서 지시). 트레이마다 목적지와 이 배송의 수신자(선택)를 고른다. */
export function DispatchPanel({ robots, users }: { robots: { id: string; name: string; destinations: string[]; busy: boolean }[]; users: { id: string; name: string }[] }) {
  const { pending, result, run } = useAction();
  const [robotId, setRobotId] = useState(robots[0]?.id ?? "");
  const robot = robots.find((r) => r.id === robotId);
  const dests = (robot?.destinations ?? []).filter((d) => d !== "출발지");
  const [trays, setTrays] = useState<{ destination: string; recipientUserIds: string[] }[]>([{ destination: "", recipientUserIds: [] }]);
  const [sort, setSort] = useState<"fixed" | "auto">("fixed");
  const [executeTask, setExecuteTask] = useState(true);
  const [callDest, setCallDest] = useState("");
  const setTray = (i: number, patch: Partial<{ destination: string; recipientUserIds: string[] }>) => setTrays((ts) => ts.map((t, k) => (k === i ? { ...t, ...patch } : t)));
  if (!robots.length) return <p className="text-sm text-gray-500">지시할 수 있는 배송로봇이 없습니다(사업장 지정·권한 확인).</p>;
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-600">로봇</span>
        <select className="border rounded px-2 py-1" value={robotId} onChange={(e) => setRobotId(e.target.value)}>
          {robots.map((r) => (
            <option key={r.id} value={r.id}>{r.name}{r.busy ? " (배송 중)" : ""}</option>
          ))}
        </select>
      </div>
      <div className="rounded-lg border p-2 space-y-2">
        <div className="font-medium text-xs">배송 보내기</div>
        {trays.map((t, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-gray-500 w-14">트레이 {i + 1}</span>
            <select className="border rounded px-2 py-1" value={t.destination} onChange={(e) => setTray(i, { destination: e.target.value })}>
              <option value="">목적지 선택</option>
              {dests.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
            <span className="text-xs text-gray-500">받는 사람(선택)</span>
            {users.map((u) => (
              <label key={u.id} className="inline-flex items-center gap-1 text-xs">
                <input type="checkbox" checked={t.recipientUserIds.includes(u.id)} onChange={() => setTray(i, { recipientUserIds: t.recipientUserIds.includes(u.id) ? t.recipientUserIds.filter((x) => x !== u.id) : [...t.recipientUserIds, u.id] })} /> {u.name}
              </label>
            ))}
            {trays.length > 1 && <button type="button" className={btn.small} onClick={() => setTrays((ts) => ts.filter((_, k) => k !== i))}>빼기</button>}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          {trays.length < 5 && <button type="button" className={btn.small} onClick={() => setTrays((ts) => [...ts, { destination: "", recipientUserIds: [] }])}>트레이 추가</button>}
          <label className="inline-flex items-center gap-1 text-xs"><input type="radio" checked={sort === "fixed"} onChange={() => setSort("fixed")} /> 적은 순서대로</label>
          <label className="inline-flex items-center gap-1 text-xs"><input type="radio" checked={sort === "auto"} onChange={() => setSort("auto")} /> 가까운 순서(로봇이 정함)</label>
          <label className="inline-flex items-center gap-1 text-xs"><input type="checkbox" checked={executeTask} onChange={(e) => setExecuteTask(e.target.checked)} /> 바로 출발</label>
          <button
            type="button"
            className={btn.primary}
            disabled={pending || !trays.some((t) => t.destination)}
            onClick={() => {
              const list = trays.filter((t) => t.destination).map((t) => t.destination).join(" → ");
              if (!confirm(`${robot?.name} 에 배송을 보냅니다: ${list}\n${executeTask ? "바로 출발합니다." : "로봇 화면에 임무만 넣고, 출발은 현장에서 누릅니다."} 물건을 실었는지 확인하셨나요?`)) return;
              run(async () => {
                const r = await dispatchDeliveryAction({ robotId, trays: trays.filter((t) => t.destination), sort, executeTask });
                if (r.ok) setTrays([{ destination: "", recipientUserIds: [] }]);
                return r;
              });
            }}
          >
            배송 보내기
          </button>
        </div>
        <p className="text-xs text-gray-500">받는 사람을 고르면 도착 알림이 그 사람에게 갑니다(안 고르면 목적지 수신자). 로봇이 배송 중이면 보낼 수 없습니다.</p>
      </div>
      <div className="rounded-lg border p-2 flex flex-wrap items-center gap-2">
        <span className="font-medium text-xs">호출</span>
        <select className="border rounded px-2 py-1" value={callDest} onChange={(e) => setCallDest(e.target.value)}>
          <option value="">목적지 선택</option>
          {(robot?.destinations ?? []).map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <button type="button" className={btn.small} disabled={pending || !callDest} onClick={() => { if (confirm(`${robot?.name} 을(를) ${callDest} 로 부릅니다.`)) run(() => callDeliveryRobotAction(robotId, callDest)); }}>호출</button>
        <button type="button" className={btn.small} disabled={pending || !callDest} onClick={() => run(() => cancelDeliveryCallAction(robotId, callDest))}>호출 취소</button>
        <span className="text-xs text-gray-500">대기 중이면 바로 오고, 배송 중이면 끝난 뒤에 옵니다. 취소하면 출발지로 돌아갑니다.</span>
      </div>
      <ResultLine result={result} />
    </div>
  );
}
