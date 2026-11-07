"use client";

import { useState } from "react";
import { NOTIFY_CHANNEL_LABEL, NOTIFY_KINDS, type NotifyChannel, type NotifyKind } from "@/lib/domain/types";
import { subscribeMeAction, unsubscribeMeAction, updateMySubscriptionAction } from "@/app/actions";
import { btn, ResultLine, useAction } from "./ActionButton";
import { KindPicker, kindsSummary } from "./AdminPanels";

type Sub = { id: string; siteId: string; siteName: string; channel: NotifyChannel; hoursFrom: string; hoursTo: string; kinds: NotifyKind[] };

/** 내 계정 → 내 알림 구독: 접근 가능한 사업장의 알림을 내 이메일/카카오톡/앱 푸시로 받기, 종류·시간대 변경, 해제. */
export function MySubscriptions({ subs, sites, kakaoLinked, pushReady }: { subs: Sub[]; sites: { id: string; name: string }[]; kakaoLinked: boolean; pushReady: boolean }) {
  const { pending, result, run } = useAction();
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  const [channel, setChannel] = useState<NotifyChannel>("EMAIL");
  const [kinds, setKinds] = useState<NotifyKind[]>([...NOTIFY_KINDS]);
  return (
    <div className="space-y-2 text-sm">
      {subs.length === 0 ? (
        <p className="text-xs text-gray-500">아직 받는 알림이 없습니다. 아래에서 사업장을 골라 추가하세요(관리자가 등록해 준 수신자도 여기에 보입니다).</p>
      ) : (
        <ul className="space-y-1.5">
          {subs.map((s) => (
            <SubRow key={s.id} sub={s} />
          ))}
        </ul>
      )}
      {sites.length > 0 && (
        <div className="border-t pt-2 space-y-1 text-xs">
          <div className="flex flex-wrap items-center gap-1">
            <select className="border rounded px-1 py-0.5" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <select className="border rounded px-1 py-0.5" value={channel} onChange={(e) => setChannel(e.target.value as NotifyChannel)}>
              <option value="EMAIL">이메일</option>
              <option value="KAKAO" disabled={!kakaoLinked}>카카오톡{kakaoLinked ? "" : "(먼저 연결)"}</option>
              <option value="PUSH" disabled={!pushReady}>앱 푸시{pushReady ? "" : "(먼저 앱 로그인)"}</option>
            </select>
            <button type="button" className={btn.small} disabled={pending || !siteId || kinds.length === 0} onClick={() => run(() => subscribeMeAction(siteId, channel, kinds))}>이 사업장 알림 받기</button>
          </div>
          <div className="flex flex-wrap items-center gap-1">받을 통보: <KindPicker value={kinds} onChange={setKinds} /></div>
        </div>
      )}
      <ResultLine result={result} />
    </div>
  );
}

function SubRow({ sub }: { sub: Sub }) {
  const { pending, result, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [kinds, setKinds] = useState<NotifyKind[]>(sub.kinds);
  const [from, setFrom] = useState(sub.hoursFrom);
  const [to, setTo] = useState(sub.hoursTo);
  return (
    <li className="text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium text-sm">{sub.siteName}</span>
        <span className="rounded bg-gray-100 px-1">{NOTIFY_CHANNEL_LABEL[sub.channel]}</span>
        {!editing && <span className="text-gray-500">{kindsSummary(sub.kinds)} · {sub.hoursFrom}~{sub.hoursTo}</span>}
        {!editing && <button type="button" className={btn.small} onClick={() => setEditing(true)}>변경</button>}
        {!editing && <button type="button" className={btn.small} disabled={pending} onClick={() => { if (confirm(`'${sub.siteName}' 알림 수신을 해제할까요?`)) run(() => unsubscribeMeAction(sub.id)); }}>해제</button>}
      </div>
      {editing && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <KindPicker value={kinds} onChange={setKinds} disabled={pending} />
          <input type="time" className="border rounded px-1 py-0.5" value={from} onChange={(e) => setFrom(e.target.value)} />~
          <input type="time" className="border rounded px-1 py-0.5" value={to} onChange={(e) => setTo(e.target.value)} />
          <button type="button" className={btn.small} disabled={pending || kinds.length === 0} onClick={() => run(async () => { const r = await updateMySubscriptionAction(sub.id, { kinds, hoursFrom: from, hoursTo: to }); if (r.ok) setEditing(false); return r; })}>저장</button>
          <button type="button" className={btn.small} onClick={() => setEditing(false)}>취소</button>
        </div>
      )}
      <ResultLine result={result} />
    </li>
  );
}
