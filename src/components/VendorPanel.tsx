"use client";

import { useState } from "react";
import { puduImportRobotsAction, puduSyncNowAction, puduTestConnectionAction } from "@/app/actions";
import { btn, ResultLine, useAction } from "./ActionButton";

type PuduRobotRow = { sn: string; productCode: string; model: string | null; shopId: number; shopName: string; nickname: string; registered: boolean };

export function PuduPanel({
  live,
  keyConfigured,
  cluster,
  clusterLabel,
  callbackUrl,
  callbackConfigured,
  floors,
}: {
  live: boolean;
  keyConfigured: boolean;
  cluster: string | null;
  clusterLabel: string | null;
  callbackUrl: string;
  callbackConfigured: boolean;
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
      </div>
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
