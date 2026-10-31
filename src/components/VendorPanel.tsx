"use client";

import { useState } from "react";
import { alignFloorMapsAction, puduCallbackSelfTestAction, puduImportRobotsAction, puduSyncNowAction, puduTestConnectionAction } from "@/app/actions";
import { btn, ResultLine, useAction } from "./ActionButton";

type PuduRobotRow = { sn: string; productCode: string; model: string | null; shopId: string; shopName: string; nickname: string; registered: boolean };

export function PuduPanel({
  live,
  keyConfigured,
  cluster,
  clusterLabel,
  callbackUrl,
  callbackConfigured,
  callbackPublic,
  lastCallbackAt,
  callbacksLast24h,
  shopIds,
  floors,
}: {
  live: boolean;
  keyConfigured: boolean;
  cluster: string | null;
  clusterLabel: string | null;
  callbackUrl: string;
  callbackConfigured: boolean;
  callbackPublic: boolean;
  lastCallbackAt: string | null;
  callbacksLast24h: number;
  shopIds: string[];
  floors: { id: string; siteId: string; name: string; siteName: string }[];
}) {
  const { pending, result, run } = useAction();
  const [robots, setRobots] = useState<PuduRobotRow[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [floorId, setFloorId] = useState(floors[0]?.id ?? "");
  const floor = floors.find((f) => f.id === floorId);

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-700">
        <span>모드: <b>{live ? "실제 연동(live)" : keyConfigured ? "설정됨 · 샘플 모드" : "미설정"}</b></span>
        <span>클러스터: <b>{cluster ? `${cluster} (${clusterLabel})` : "미지정"}</b></span>
        <span>키: <b>{keyConfigured ? "서버 환경변수에 설정됨" : "없음"}</b></span>
        <span>콜백 URL: <code className="bg-gray-100 px-1">{callbackUrl}</code> · CallbackCode {callbackConfigured ? "설정됨" : "없음"}</span>
        <span>허용 매장(shop_id): <b>{shopIds.length ? shopIds.join(", ") : "없음"}</b></span>
      </div>
      {keyConfigured && shopIds.length === 0 && <p className="text-xs text-amber-800">허용 매장(PUDU_SHOP_IDS)이 없어 실제 연동이 켜지지 않습니다. 대리점 키는 다른 고객사의 로봇까지 보이므로 우리 매장의 shop_id 만 서버 .env 에 적습니다(찾기: <code>npm run pudu:check -- --shops 검색어</code>).</p>}
      {!keyConfigured && <p className="text-xs text-amber-800">서버의 .env 에 PUDU_API_CLUSTER / PUDU_API_APP_KEY / PUDU_API_APP_SECRET 을 넣고 VENDOR_MODE=live(또는 PUDU_MODE=live)로 재시작하면 실제 연동이 켜집니다. 키는 화면에서 입력하지 않습니다.</p>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={btn.primary}
          disabled={pending || !keyConfigured}
          onClick={() =>
            run(async () => {
              const r = await puduTestConnectionAction();
              if (r.ok && "robots" in r && r.robots) setRobots(r.robots);
              return r;
            })
          }
        >
          연결 확인 + 로봇 조회
        </button>
        {(["status", "reports", "catalog", "events"] as const).map((job) => (
          <button key={job} type="button" className={btn.secondary} disabled={pending || !live} onClick={() => run(() => puduSyncNowAction(job))}>
            지금 동기화: {{ status: "상태", reports: "보고서·장애", catalog: "작업·예약·소모품", events: "콜백 처리" }[job]}
          </button>
        ))}
      </div>
      <ResultLine result={result} />
      <AlignMaps live={live} />
      <div className="border rounded p-2 bg-slate-50 text-xs space-y-1">
        <div className="font-medium">콜백(알림 수신) 등록</div>
        <div>
          등록할 URL: <code className="bg-white border px-1">{callbackUrl}</code>
          {!callbackPublic && <span className="ml-1 text-amber-800">— 아직 공개 HTTPS 주소가 아닙니다(서버 배포 후 APP_BASE_URL 을 도메인으로). PUDU 는 공개 HTTPS URL 에만 보낼 수 있습니다.</span>}
        </div>
        <div>
          CallbackCode: <b>{callbackConfigured ? "설정됨" : "없음"}</b> · 최근 수신: <b>{lastCallbackAt ? new Date(lastCallbackAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "없음"}</b> · 24시간 {callbacksLast24h}건
        </div>
        <div className="text-gray-600">
          절차: 대리점 플랫폼(VD ROBOTICS 계정) → Application Center → Open Platform 에서 위 URL 을 콜백 주소로 입력 → PUDU 가 callback_code 를 돌려줌 → 서버 .env 의 PUDU_CALLBACK_CODE 에 넣고 재시작 → 아래 자가 점검. 기본적으로 알림은 꺼져 있어 콜백 종류(청소 상태·예약 상태·로봇 상태·온/오프라인·장애)를 함께 신청해야 합니다.
        </div>
        <button type="button" className={btn.secondary} disabled={pending || !callbackConfigured} onClick={() => run(() => puduCallbackSelfTestAction())}>
          콜백 URL 자가 점검
        </button>
      </div>
      {robots && (
        <div className="border rounded p-3 bg-slate-50">
          <div className="font-medium mb-1">PUDU 계정의 로봇 {robots.length}대</div>
          <table className="data">
            <thead>
              <tr>
                <th></th>
                <th>SN</th>
                <th>product_code → 모델</th>
                <th>매장</th>
                <th>별칭</th>
                <th>등록</th>
              </tr>
            </thead>
            <tbody>
              {robots.map((r) => (
                <tr key={r.sn}>
                  <td>{!r.registered && r.model && <input type="checkbox" checked={selected.includes(r.sn)} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, r.sn] : s.filter((x) => x !== r.sn)))} />}</td>
                  <td className="font-mono text-xs">{r.sn}</td>
                  <td>
                    {r.productCode} → {r.model ?? <span className="text-red-700">문서에 없는 코드(보류)</span>}
                  </td>
                  <td>{r.shopName} ({r.shopId})</td>
                  <td>{r.nickname}</td>
                  <td>{r.registered ? <span className="text-emerald-700">등록됨</span> : "미등록"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex flex-wrap gap-2 items-center mt-2">
            <select className="border rounded px-2 py-1" value={floorId} onChange={(e) => setFloorId(e.target.value)}>
              {floors.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.siteName} / {f.name}
                </option>
              ))}
            </select>
            <button type="button" className={btn.primary} disabled={pending || selected.length === 0 || !floor} onClick={() => run(() => puduImportRobotsAction(floor!.siteId, floor!.id, selected))}>
              선택 {selected.length}대를 이 사업장·층에 등록
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

type AlignRow = { floorId: string; site: string; floor: string; current: string | null; map: string | null; status: string; result: string };

/** 로봇이 지금 쓰는 PUDU 지도와 층 지도 비교 → 고른 층만 적용. 로봇 자체의 지도는 바꾸지 않는다. */
function AlignMaps({ live }: { live: boolean }) {
  const [rows, setRows] = useState<AlignRow[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const call = async (apply: boolean) => {
    setBusy(true);
    setErr(null);
    const r = await alignFloorMapsAction(apply, picked);
    setBusy(false);
    if (!r.ok) return setErr(r.error ?? "실패");
    if (apply) {
      const done = new Map((r.rows ?? []).map((x) => [x.floorId, x]));
      setRows((prev) => (prev ?? []).map((x) => done.get(x.floorId) ?? x));
      setPicked([]);
    } else setRows(r.rows ?? []);
  };
  return (
    <div className="border rounded p-2 bg-slate-50 text-xs space-y-1">
      <div className="font-medium">층 지도 확인 · 맞추기</div>
      <div className="text-gray-600">
        로봇이 지금 쓰는 PUDU 지도와 이 시스템의 층 지도를 비교합니다. <b>로봇 자체의 지도·층은 바꾸지 않습니다</b>(제조사에 명령을 보내지 않음). 적용하면 이 시스템의 그 층 지도·청소 구역만 로봇 지도 기준으로 바뀝니다.
      </div>
      <button type="button" className={btn.secondary} disabled={busy || !live} onClick={() => void call(false)}>
        {busy ? "확인 중…" : "비교하기(바꾸지 않음)"}
      </button>
      {err && <div className="text-red-700">{err}</div>}
      {rows && (
        <>
          <table className="data bg-white">
            <thead><tr><th></th><th>사업장</th><th>층</th><th>층 지도</th><th>로봇 지도</th><th>결과</th></tr></thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.floorId}>
                  <td>{x.status === "DIFFERENT" && <input type="checkbox" checked={picked.includes(x.floorId)} onChange={(e) => setPicked(e.target.checked ? [...picked, x.floorId] : picked.filter((f) => f !== x.floorId))} aria-label="적용할 층" />}</td>
                  <td>{x.site}</td><td>{x.floor}</td><td>{x.current ?? "-"}</td><td>{x.map ?? "-"}</td><td>{x.result}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.some((x) => x.status === "DIFFERENT") && (
            <button
              type="button"
              className={btn.primary}
              disabled={busy || picked.length === 0}
              onClick={() => {
                if (!confirm(`고른 ${picked.length}개 층의 지도·청소 구역을 로봇 지도로 바꿉니다(이 시스템 안에서만). 계속할까요?`)) return;
                void call(true);
              }}
            >
              고른 층에 적용
            </button>
          )}
        </>
      )}
    </div>
  );
}
