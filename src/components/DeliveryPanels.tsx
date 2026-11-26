"use client";

import { useState } from "react";
import { addContactPresetsAction, createDeliveryContactAction, callDeliveryRobotAction, cancelDeliveryCallAction, deleteDeliveryContactAction, importDeliveryContactsAction, updateDeliveryContactAction, deleteDeliveryPresetAction, deleteDeliveryRecipientsAction, deliverySyncNowAction, dispatchDeliveryAction, saveDeliveryPresetAction, saveDeliveryRecipientsAction, sendDeliveryPresetAction, setDeliveryRobotSiteAction } from "@/app/actions";
import { btn, ResultLine, useAction } from "./ActionButton";

type Channel = "PUSH" | "EMAIL" | "KAKAO" | "TEAMS";
const CH_LABEL: Record<Channel, string> = { PUSH: "앱 푸시", EMAIL: "메일", KAKAO: "카카오톡", TEAMS: "Teams" };

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
        {(["PUSH", "EMAIL", "KAKAO", "TEAMS"] as Channel[]).map((c) => (
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
type Preset = { id: string; siteId: string; name: string; trays: { destination: string; recipientUserIds: string[]; recipientContactIds?: string[] }[]; sort: string; executeTask: boolean };
export type ContactLite = { id: string; siteId: string; name: string; dept: string | null; floor: string | null; destination: string | null; active: boolean };
type Tray = { destination: string; recipientUserIds: string[]; recipientContactIds: string[] };
const EMPTY_TRAY: Tray = { destination: "", recipientUserIds: [], recipientContactIds: [] };

/** 이름으로 받는 사람 찾기(명부). 고르면 그 사람의 목적지가 비어 있는 트레이에 채워진다. */
function ContactPicker({ contacts, chosen, onPick, onRemove, max = 99 }: { contacts: ContactLite[]; chosen: string[]; onPick: (c: ContactLite) => void; onRemove: (id: string) => void; max?: number }) {
  const [q, setQ] = useState("");
  const hits = q.trim() ? contacts.filter((c) => c.active && !chosen.includes(c.id) && (c.name.includes(q.trim()) || (c.dept ?? "").includes(q.trim()))).slice(0, 6) : [];
  const nameOf = (id: string) => contacts.find((c) => c.id === id)?.name ?? id;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {chosen.map((id) => (
        <span key={id} className="inline-flex items-center gap-1 rounded-full bg-blue-50 text-blue-800 px-2 py-0.5 text-xs">
          {nameOf(id)}
          <button type="button" aria-label={`${nameOf(id)} 빼기`} onClick={() => onRemove(id)}>×</button>
        </span>
      ))}
      {contacts.length > 0 && chosen.length < max && (
        <span className="relative">
          <input className="border rounded px-2 py-1 text-xs w-32" placeholder="이름·부서 검색" value={q} onChange={(e) => setQ(e.target.value)} />
          {hits.length > 0 && (
            <span className="absolute z-10 left-0 top-full mt-1 w-56 rounded border bg-white shadow">
              {hits.map((c) => (
                <button key={c.id} type="button" className="block w-full text-left px-2 py-1 text-xs hover:bg-slate-50" onClick={() => { onPick(c); setQ(""); }}>
                  <b>{c.name}</b> <span className="text-gray-500">{c.dept ?? ""} · {c.destination ?? "목적지 미지정"}</span>
                </button>
              ))}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

export function DispatchPanel({ robots, users, presets = [], contacts = [] }: { robots: { id: string; name: string; siteId: string; destinations: string[]; busy: boolean }[]; users: { id: string; name: string }[]; presets?: Preset[]; contacts?: ContactLite[] }) {
  const { pending, result, run } = useAction();
  const [robotId, setRobotId] = useState(robots[0]?.id ?? "");
  const robot = robots.find((r) => r.id === robotId);
  const dests = (robot?.destinations ?? []).filter((d) => d !== "출발지");
  const [trays, setTrays] = useState<Tray[]>([EMPTY_TRAY]);
  const siteContacts = contacts.filter((c) => c.siteId === robot?.siteId);
  const contactName = (id: string) => contacts.find((c) => c.id === id)?.name ?? id;
  const [presetQ, setPresetQ] = useState("");
  const [sort, setSort] = useState<"fixed" | "auto">("fixed");
  const [executeTask, setExecuteTask] = useState(true);
  const [callDest, setCallDest] = useState("");
  const [presetName, setPresetName] = useState("");
  const myPresets = presets.filter((p) => p.siteId === robot?.siteId && (!presetQ.trim() || p.name.includes(presetQ.trim())));
  const userName = (id: string) => users.find((u) => u.id === id)?.name ?? id;
  const setTray = (i: number, patch: Partial<Tray>) => setTrays((ts) => ts.map((t, k) => (k === i ? { ...t, ...patch } : t)));
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
      {presets.some((p) => p.siteId === robot?.siteId) && (
        <div className="rounded-lg border p-2 space-y-1 max-h-72 overflow-y-auto">
          <div className="flex items-center gap-2">
            <span className="font-medium text-xs">자주 쓰는 배송(즐겨찾기)</span>
            <input className="border rounded px-2 py-0.5 text-xs w-36 ml-auto" placeholder="이름으로 찾기" value={presetQ} onChange={(e) => setPresetQ(e.target.value)} />
          </div>
          {myPresets.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-2 text-xs">
              <b>{p.name}</b>
              <span className="text-gray-600">{p.trays.map((t) => { const who = [...t.recipientUserIds.map(userName), ...(t.recipientContactIds ?? []).map(contactName)]; return `${t.destination}${who.length ? `(${who.join("·")} 문자·알림)` : ""}`; }).join(" → ")}{p.executeTask ? "" : " · 출발은 현장에서"}</span>
              <span className="ml-auto flex gap-1">
                <button type="button" className={btn.primary} disabled={pending} onClick={() => { if (confirm(`'${p.name}' 으로 ${robot?.name} 에 배송을 보냅니다. 물건을 실었는지 확인하셨나요?`)) run(() => sendDeliveryPresetAction(p.id, robotId)); }}>보내기</button>
                <button type="button" className={btn.small} disabled={pending} onClick={() => { if (confirm(`즐겨찾기 '${p.name}' 을(를) 삭제할까요?`)) run(() => deleteDeliveryPresetAction(p.id)); }}>삭제</button>
              </span>
            </div>
          ))}
        </div>
      )}
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
            <span className="text-xs text-gray-500">받는 사람</span>
            <ContactPicker
              contacts={siteContacts}
              chosen={t.recipientContactIds}
              max={1}
              onPick={(c) => setTray(i, { recipientContactIds: [...t.recipientContactIds, c.id], ...(t.destination || !c.destination || !dests.includes(c.destination) ? {} : { destination: c.destination }) })}
              onRemove={(id) => setTray(i, { recipientContactIds: t.recipientContactIds.filter((x) => x !== id) })}
            />
            {users.map((u) => (
              <label key={u.id} className="inline-flex items-center gap-1 text-xs">
                <input type="checkbox" checked={t.recipientUserIds.includes(u.id)} onChange={() => setTray(i, { recipientUserIds: t.recipientUserIds.includes(u.id) ? t.recipientUserIds.filter((x) => x !== u.id) : [...t.recipientUserIds, u.id] })} /> {u.name}
              </label>
            ))}
            {trays.length > 1 && <button type="button" className={btn.small} onClick={() => setTrays((ts) => ts.filter((_, k) => k !== i))}>빼기</button>}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          {trays.length < 5 && <button type="button" className={btn.small} onClick={() => setTrays((ts) => [...ts, EMPTY_TRAY])}>트레이 추가</button>}
          <label className="inline-flex items-center gap-1 text-xs"><input type="radio" checked={sort === "fixed"} onChange={() => setSort("fixed")} /> 적은 순서대로</label>
          <label className="inline-flex items-center gap-1 text-xs"><input type="radio" checked={sort === "auto"} onChange={() => setSort("auto")} /> 가까운 순서(로봇이 정함)</label>
          <label className="inline-flex items-center gap-1 text-xs"><input type="checkbox" checked={executeTask} onChange={(e) => setExecuteTask(e.target.checked)} /> 바로 출발</label>
          <span className="basis-full text-xs text-amber-700">로봇 화면이 「배송(임무 편집)」 화면일 때만 원격 배송을 받습니다. 보내기 전에 로봇 화면을 배송 화면으로 열어 두세요(응답까지 최대 20초).</span>
          <button
            type="button"
            className={btn.primary}
            disabled={pending || !trays.some((t) => t.destination)}
            onClick={() => {
              const list = trays.filter((t) => t.destination).map((t) => t.destination).join(" → ");
              if (!confirm(`${robot?.name} 에 배송을 보냅니다: ${list}\n${executeTask ? "바로 출발합니다." : "로봇 화면에 임무만 넣고, 출발은 현장에서 누릅니다."} 물건을 실었는지 확인하셨나요?`)) return;
              run(async () => {
                const r = await dispatchDeliveryAction({ robotId, trays: trays.filter((t) => t.destination), sort, executeTask });
                if (r.ok) setTrays([EMPTY_TRAY]);
                return r;
              });
            }}
          >
            배송 보내기
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t pt-2">
          <input className="border rounded px-2 py-1 text-xs w-40" placeholder="즐겨찾기 이름(예: 오전 우편)" value={presetName} onChange={(e) => setPresetName(e.target.value)} />
          <button type="button" className={btn.small} disabled={pending || !presetName.trim() || !trays.some((t) => t.destination) || !robot} onClick={() => run(async () => { const r = await saveDeliveryPresetAction({ siteId: robot!.siteId, name: presetName, trays: trays.filter((t) => t.destination), sort, executeTask }); if (r.ok) setPresetName(""); return r; })}>지금 내용을 즐겨찾기로 저장</button>
        </div>
        <p className="text-xs text-gray-500">이름으로 고른 사람(명부)의 번호는 배송 지시와 함께 로봇에 들어가 <b>로봇이 도착 문자</b>를 보냅니다(트레이마다 1명). 체크한 직원 계정에게는 앱/메일 알림이 갑니다. 아무도 안 고르면 목적지 수신자에게 갑니다. 로봇이 배송 중이면 보낼 수 없습니다.</p>
      </div>
      <div className="rounded-lg border p-2 flex flex-wrap items-center gap-2">
        <span className="font-medium text-xs">이동(호출)</span>
        <select className="border rounded px-2 py-1" value={callDest} onChange={(e) => setCallDest(e.target.value)}>
          <option value="">목적지 선택</option>
          {(robot?.destinations ?? []).map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <button type="button" className={btn.small} disabled={pending || !callDest} onClick={() => { if (confirm(`${robot?.name} 을(를) ${callDest} 로 이동시킵니다(물건 없이 이동). 주변에 사람이 있는지 확인하셨나요?`)) run(() => callDeliveryRobotAction(robotId, callDest)); }}>이동</button>
        <button type="button" className={btn.small} disabled={pending || !callDest} onClick={() => run(() => cancelDeliveryCallAction(robotId, callDest))}>이동 취소(원위치)</button>
        <span className="text-xs text-gray-500">대기 중이면 바로, 배송 중이면 끝난 뒤 이동합니다. 도착하면 그 자리에서 기다리고, 취소하면 출발지로 돌아갑니다. 이 화면에서 보낸 이동만 취소할 수 있습니다.</span>
      </div>
      <ResultLine result={result} />
    </div>
  );
}


/** 배송 받는 사람 명부: 엑셀 올리기, 목적지 지정, 이름 즐겨찾기 만들기. 휴대폰 번호는 가려서 보인다. */
export function ContactsPanel({ sites, contacts, destinationsBySite }: { sites: { id: string; name: string }[]; contacts: (ContactLite & { phoneMasked: string; ext: string | null })[]; destinationsBySite: Record<string, string[]> }) {
  const { pending, result, run } = useAction();
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  const [q, setQ] = useState("");
  const [onlyNoDest, setOnlyNoDest] = useState(false);
  const all = contacts.filter((c) => c.siteId === siteId);
  const list = all.filter((c) => (!q.trim() || c.name.includes(q.trim()) || (c.dept ?? "").includes(q.trim()) || (c.floor ?? "").includes(q.trim())) && (!onlyNoDest || !c.destination));
  const dests = destinationsBySite[siteId] ?? [];
  const blank = { name: "", phone: "", floor: "", dept: "", ext: "", destination: "" };
  const [add, setAdd] = useState(blank);
  const [editId, setEditId] = useState<string | null>(null);
  const [edit, setEdit] = useState(blank);
  const startEdit = (c: ContactLite & { ext: string | null }) => {
    setEditId(c.id);
    setEdit({ name: c.name, phone: "", floor: c.floor ?? "", dept: c.dept ?? "", ext: c.ext ?? "", destination: c.destination ?? "" });
  };
  const field = "border rounded px-1.5 py-0.5 text-xs";
  return (
    <div className="space-y-3 text-sm">
      <form
        className="flex flex-wrap items-center gap-2"
        action={(fd) => run(() => importDeliveryContactsAction(fd))}
      >
        <select name="siteId" className="border rounded px-2 py-1" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <input type="file" name="file" accept=".xlsx" className="text-xs" required />
        <button type="submit" className={btn.secondary} disabled={pending}>엑셀 올리기</button>
        <span className="text-xs text-gray-500">머리글: 성명·근무층·부서명·전화번호·내선번호. 같은 이름+번호는 갱신됩니다. 근무층(예: 8F)은 로봇 목적지(8층)로 자동 연결됩니다.</span>
      </form>
      <form
        className="flex flex-wrap items-center gap-1.5 rounded border p-2"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const r = await createDeliveryContactAction({ siteId, ...add });
            if (r.ok) setAdd(blank);
            return r;
          });
        }}
      >
        <span className="text-xs font-medium mr-1">한 명 추가</span>
        <input id="dct-add-name" className={`${field} w-24`} placeholder="이름*" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} required />
        <input id="dct-add-phone" className={`${field} w-32`} placeholder="휴대폰* 010-…" value={add.phone} onChange={(e) => setAdd({ ...add, phone: e.target.value })} required inputMode="tel" />
        <input id="dct-add-floor" className={`${field} w-16`} placeholder="근무층(8F)" value={add.floor} onChange={(e) => setAdd({ ...add, floor: e.target.value })} />
        <input id="dct-add-dept" className={`${field} w-28`} placeholder="부서" value={add.dept} onChange={(e) => setAdd({ ...add, dept: e.target.value })} />
        <input id="dct-add-ext" className={`${field} w-28`} placeholder="내선" value={add.ext} onChange={(e) => setAdd({ ...add, ext: e.target.value })} />
        <select id="dct-add-dest" className={field} value={add.destination} onChange={(e) => setAdd({ ...add, destination: e.target.value })}>
          <option value="">목적지(근무층으로 자동)</option>
          {dests.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <button type="submit" className={btn.small} disabled={pending || !siteId}>추가</button>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        <input className="border rounded px-2 py-1 text-xs w-44" placeholder="이름·부서·층 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="inline-flex items-center gap-1 text-xs"><input type="checkbox" checked={onlyNoDest} onChange={(e) => setOnlyNoDest(e.target.checked)} /> 목적지 없는 사람만</label>
        <span className="text-xs text-gray-500">{list.length} / {all.length}명</span>
        <button type="button" className={`${btn.small} ml-auto`} disabled={pending || !list.length} onClick={() => { if (confirm(`보이는 ${list.length}명을 각각 「이름(목적지)」 즐겨찾기로 만듭니다. 이미 있는 이름은 건너뜁니다.`)) run(() => addContactPresetsAction(list.map((c) => c.id))); }}>보이는 사람 모두 즐겨찾기에 추가</button>
      </div>
      <ResultLine result={result} />
      {all.length === 0 ? (
        <p className="text-xs text-gray-500">명부가 없습니다. 위에서 엑셀을 올리세요.</p>
      ) : (
        <div className="overflow-x-auto max-h-96 overflow-y-auto">
          <table className="data">
            <thead>
              <tr><th>이름</th><th>근무층</th><th>부서</th><th>휴대폰</th><th>내선</th><th>목적지</th><th>사용</th><th></th></tr>
            </thead>
            <tbody>
              {list.slice(0, 300).map((c) =>
                editId === c.id ? (
                  <tr key={c.id} className="bg-blue-50/50">
                    <td><input className={`${field} w-20`} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} aria-label="이름" /></td>
                    <td><input className={`${field} w-14`} value={edit.floor} onChange={(e) => setEdit({ ...edit, floor: e.target.value })} aria-label="근무층" /></td>
                    <td><input className={`${field} w-24`} value={edit.dept} onChange={(e) => setEdit({ ...edit, dept: e.target.value })} aria-label="부서" /></td>
                    <td><input className={`${field} w-28`} placeholder={`${c.phoneMasked} (바꿀 때만)`} value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} aria-label="새 휴대폰 번호" inputMode="tel" /></td>
                    <td><input className={`${field} w-24`} value={edit.ext} onChange={(e) => setEdit({ ...edit, ext: e.target.value })} aria-label="내선" /></td>
                    <td>
                      <select className={field} value={edit.destination} onChange={(e) => setEdit({ ...edit, destination: e.target.value })} aria-label="목적지">
                        <option value="">미지정</option>
                        {Array.from(new Set([...(edit.destination ? [edit.destination] : []), ...dests])).map((d) => (
                          <option key={d} value={d}>{d}</option>
                        ))}
                      </select>
                    </td>
                    <td colSpan={2} className="whitespace-nowrap">
                      <button
                        type="button"
                        className={btn.small}
                        disabled={pending}
                        onClick={() =>
                          run(async () => {
                            const r = await updateDeliveryContactAction(c.id, { name: edit.name, floor: edit.floor || null, dept: edit.dept || null, ext: edit.ext || null, destination: edit.destination || null, ...(edit.phone.trim() ? { phone: edit.phone } : {}) });
                            if (r.ok) setEditId(null);
                            return r;
                          })
                        }
                      >
                        저장
                      </button>{" "}
                      <button type="button" className={btn.small} onClick={() => setEditId(null)}>취소</button>
                    </td>
                  </tr>
                ) : (
                <tr key={c.id} className={c.active ? "" : "opacity-50"}>
                  <td className="whitespace-nowrap font-medium">{c.name}</td>
                  <td>{c.floor ?? "-"}</td>
                  <td className="whitespace-nowrap">{c.dept ?? "-"}</td>
                  <td className="whitespace-nowrap tabular-nums">{c.phoneMasked}</td>
                  <td className="whitespace-nowrap tabular-nums">{c.ext ?? "-"}</td>
                  <td>
                    <select className="border rounded px-1 py-0.5 text-xs" value={c.destination ?? ""} disabled={pending} onChange={(e) => run(() => updateDeliveryContactAction(c.id, { destination: e.target.value || null }))}>
                      <option value="">미지정</option>
                      {Array.from(new Set([...(c.destination ? [c.destination] : []), ...dests])).map((d) => (
                        <option key={d} value={d}>{d}</option>
                      ))}
                    </select>
                  </td>
                  <td><input type="checkbox" checked={c.active} disabled={pending} onChange={(e) => run(() => updateDeliveryContactAction(c.id, { active: e.target.checked }))} aria-label={`${c.name} 사용`} /></td>
                  <td className="whitespace-nowrap">
                    <button type="button" className={btn.small} disabled={pending} onClick={() => startEdit(c)}>수정</button>{" "}
                    <button type="button" className={btn.small} disabled={pending || !c.destination} onClick={() => run(() => addContactPresetsAction([c.id]))}>★ 즐겨찾기</button>{" "}
                    <button type="button" className={btn.small} disabled={pending} onClick={() => { if (confirm(`${c.name} 을(를) 명부에서 지울까요?`)) run(() => deleteDeliveryContactAction(c.id)); }}>삭제</button>
                  </td>
                </tr>
                ),
              )}
            </tbody>
          </table>
          {list.length > 300 && <p className="text-xs text-gray-500 mt-1">앞 300명만 보입니다. 검색으로 좁히세요.</p>}
        </div>
      )}
    </div>
  );
}
