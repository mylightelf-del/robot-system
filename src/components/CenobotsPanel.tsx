"use client";

import { useState } from "react";
import { cenobotsImportRobotsAction, cenobotsSyncNowAction, cenobotsTestConnectionAction, cenobotsWebhookSelfTestAction } from "@/app/actions";
import { btn, ResultLine, useAction } from "./ActionButton";

type DeviceRow = { deviceOpenId: string; licensePlate: string; registered: string | null; mock: boolean };

const MODE_LABEL: Record<string, string> = { live: "실제 연동(live)", mock: "모의(mock) — 내부 픽스처", unconfigured: "꺼짐·미설정", sample: "샘플" };

/** 고급 설정 → 「CENOBOTS Open API」(조회 전용). 키 값은 화면에 오지 않는다. */
export function CenobotsPanel({
  mode,
  dryRun,
  host,
  keyConfigured,
  allowed,
  webhookUrl,
  webhookConfigured,
  webhookPublic,
  lastWebhookAt,
  webhooksLast24h,
  robots,
  floors,
}: {
  mode: string;
  dryRun: boolean;
  host: string | null;
  keyConfigured: boolean;
  allowed: string[];
  webhookUrl: string;
  webhookConfigured: boolean;
  webhookPublic: boolean;
  lastWebhookAt: string | null;
  webhooksLast24h: number;
  robots: { id: string; name: string; plate: string; openId: string | null; active: boolean; boundMode: string | null; placement: string }[];
  floors: { id: string; siteId: string; name: string; siteName: string }[];
}) {
  const { pending, result, run } = useAction();
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [floorId, setFloorId] = useState(floors[0]?.id ?? "");
  const floor = floors.find((f) => f.id === floorId);
  const on = mode === "live" || mode === "mock";

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-700">
        <span>모드: <b className={mode === "mock" ? "text-amber-700" : ""}>{MODE_LABEL[mode] ?? mode}</b>{dryRun ? <span className="text-amber-700"> · 운영 서버라 DB 적재 안 함(조회·매핑 시험만)</span> : null}</span>
        <span>호스트: <b>{host ?? "미지정"}</b></span>
        <span>키: <b>{keyConfigured ? "서버 환경변수에 설정됨" : "없음"}</b></span>
        <span>허용 장비: <b>{allowed.length ? allowed.join(", ") : mode === "mock" ? "(모의 기본: L4-05408, L4-05590)" : "없음"}</b></span>
        <span className="font-medium text-gray-800">조회 전용 — 로봇에 명령을 보내지 않습니다</span>
      </div>
      {mode === "unconfigured" && <p className="text-xs text-amber-800">서버 .env 에 CENOBOTS_HOST · CENOBOTS_ACCESS_KEY · CENOBOTS_SECRET_KEY · CENOBOTS_ALLOWED_DEVICE_OPEN_IDS 를 넣고 CENOBOTS_MODE=live 로 재시작하면 켜집니다. 키 없이 시험하려면 CENOBOTS_MODE=mock. 문제가 생기면 CENOBOTS_MODE=unconfigured 로 바로 끌 수 있습니다.</p>}

      <div className="rounded border p-2 text-xs">
        <div className="font-medium mb-1">등록된 CENOBOTS 로봇</div>
        {robots.length === 0 ? (
          <div className="text-gray-500">없음</div>
        ) : (
          <table className="data">
            <thead><tr><th>관리번호</th><th>이름</th><th>번호판</th><th>deviceOpenId</th><th>배치</th><th>상태</th></tr></thead>
            <tbody>
              {robots.map((r) => (
                <tr key={r.id}>
                  <td className="font-mono">{r.id}</td>
                  <td>{r.name}</td>
                  <td className="font-mono">{r.plate || "-"}</td>
                  <td className="font-mono">{r.openId ? `${r.openId}${r.boundMode === "mock" ? " (모의)" : ""}` : <span className="text-amber-700">미연결 — 키 수령 후 자동 연결</span>}</td>
                  <td>{r.placement}</td>
                  <td>{r.active ? "사용" : <span className="text-gray-500">사용 중지</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={btn.primary}
          disabled={pending || !on}
          onClick={() =>
            run(async () => {
              const r = await cenobotsTestConnectionAction();
              if (r.ok && "devices" in r && r.devices) {
                setDevices(r.devices);
                setSelected([]);
              }
              return r;
            })
          }
        >
          연결 확인 + 로봇 조회
        </button>
        <button type="button" className={btn.small} disabled={pending || !on} onClick={() => run(() => cenobotsSyncNowAction("catalog"))}>지금 동기화: 장비·예약·소모품</button>
        <button type="button" className={btn.small} disabled={pending || !on} onClick={() => run(() => cenobotsSyncNowAction("status"))}>지금 동기화: 상태</button>
        <button type="button" className={btn.small} disabled={pending || !on} onClick={() => run(() => cenobotsSyncNowAction("reports"))}>지금 동기화: 작업 이력·장애</button>
        <button type="button" className={btn.small} disabled={pending || !on} onClick={() => run(() => cenobotsSyncNowAction("events"))}>웹훅 이벤트 처리</button>
      </div>

      {devices && (
        <div className="rounded border p-2 text-xs space-y-2">
          <div className="font-medium">허용 장비 {devices.length}대{devices[0]?.mock ? " (모의 픽스처)" : ""}</div>
          <table className="data">
            <thead><tr><th></th><th>번호판</th><th>deviceOpenId</th><th>Wide Bot</th></tr></thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.deviceOpenId}>
                  <td><input type="checkbox" checked={selected.includes(d.deviceOpenId)} disabled={dryRun} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, d.deviceOpenId] : s.filter((x) => x !== d.deviceOpenId)))} /></td>
                  <td className="font-mono">{d.licensePlate}</td>
                  <td className="font-mono">{d.deviceOpenId}</td>
                  <td>{d.registered ?? "미등록"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {dryRun ? (
            <p className="text-amber-800">운영 서버의 모의 모드에서는 등록·연결하지 않습니다. 키를 받아 live 로 바꾸면 번호판으로 미리 등록한 로봇에 자동 연결됩니다.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <select className="border rounded px-2 py-1" value={floorId} onChange={(e) => setFloorId(e.target.value)}>
                {floors.map((f) => (
                  <option key={f.id} value={f.id}>{f.siteName} · {f.name}</option>
                ))}
              </select>
              <button type="button" className={btn.primary} disabled={pending || !selected.length || !floor} onClick={() => floor && run(() => cenobotsImportRobotsAction(floor.siteId, floor.id, selected))}>
                선택 {selected.length}대 등록·연결
              </button>
              <span className="text-gray-500">번호판이 같은 로봇이 이미 있으면 새로 만들지 않고 연결만 합니다(배치·사용 여부 유지).</span>
            </div>
          )}
        </div>
      )}

      <div className="rounded border p-2 text-xs space-y-1">
        <div className="font-medium">웹훅(선택)</div>
        <div>등록할 URL: <code className="bg-gray-100 px-1">{webhookUrl}</code>{!webhookPublic && <span className="text-amber-700"> · 공개 HTTPS 주소가 아님</span>}</div>
        <div>시크릿(CENOBOTS_WEBHOOK_SECRET): <b>{webhookConfigured ? "설정됨" : "없음"}</b> · 최근 수신 {lastWebhookAt ? new Date(lastWebhookAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "없음"} · 24시간 {webhooksLast24h}건</div>
        <p className="text-gray-500">구독 생성·검증은 업체 콘솔(회사 관리자 권한)에서 합니다. 이 시스템은 구독을 만들지 않습니다. 이벤트: robot.task.status_changed · robot.error.changed · robot.maintenance.changed · robot.need_help_door_call(위치 이벤트는 저장하지 않음).</p>
        <button type="button" className={btn.small} disabled={pending || !webhookConfigured || !on} onClick={() => run(() => cenobotsWebhookSelfTestAction())}>자가 점검(공개 URL 로 challenge 보내기)</button>
      </div>
      <ResultLine result={result} />
    </div>
  );
}
