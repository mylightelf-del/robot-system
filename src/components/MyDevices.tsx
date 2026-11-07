"use client";

import { revokeMySessionAction } from "@/app/actions";
import { btn, ResultLine, useAction } from "./ActionButton";

export type SessionItem = { id: string; kind: "web" | "app"; deviceName: string; lastSeenAt: string; createdAt: string; current: boolean; pushDevices: number };
export type PushDeviceItem = { id: string; platform: string; deviceName: string; appVersion: string; lastSeenAt: string; disabledAt: string | null; lastError: string | null };

const fmt = (iso: string) => new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });

/**
 * 내 계정 → 로그인된 기기: 웹(쿠키)·앱(토큰) 세션 전부. '끊기'는 그 세션만 끝내며 앱 세션이면 푸시 기기도 함께 지워진다.
 * 토큰 원문은 서버에도 없다(해시만). 여기 보이는 ID 는 끊기용 식별자일 뿐이다.
 */
export function MyDevices({ sessions, push }: { sessions: SessionItem[]; push: { configured: boolean; devices: PushDeviceItem[] } }) {
  const { pending, result, run } = useAction();
  return (
    <div className="space-y-3 text-sm">
      <ul className="space-y-1.5">
        {sessions.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className={`rounded px-1 ${s.kind === "app" ? "bg-blue-50 text-blue-800" : "bg-gray-100"}`}>{s.kind === "app" ? "앱" : "웹"}</span>
            <span className="font-medium text-sm">{s.deviceName || "이름 없음"}</span>
            {s.current && <span className="rounded bg-green-50 px-1 text-green-800">이 기기</span>}
            <span className="text-gray-500">최근 사용 {fmt(s.lastSeenAt)} · 로그인 {fmt(s.createdAt)}{s.pushDevices > 0 ? ` · 푸시 ${s.pushDevices}대` : ""}</span>
            {!s.current && (
              <button type="button" className={btn.small} disabled={pending} onClick={() => { if (confirm(`'${s.deviceName || "이 기기"}' 의 로그인을 끊을까요? 그 기기는 다시 로그인해야 합니다.`)) run(() => revokeMySessionAction(s.id)); }}>
                끊기
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="border-t pt-2">
        <div className="font-medium">앱 푸시 알림</div>
        {!push.configured && <p className="text-xs text-amber-700">서버에 푸시(FCM) 설정이 아직 없어 푸시는 모의 발송으로 기록됩니다.</p>}
        {push.devices.length === 0 ? (
          <p className="text-xs text-gray-600">등록된 앱 기기가 없습니다. 앱에서 로그인하고 알림을 허용하면 여기에 보이고, 내 알림 구독에서 &lsquo;앱 푸시&rsquo;를 고를 수 있습니다.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {push.devices.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-1.5">
                <span className="rounded bg-gray-100 px-1">{d.platform === "ios" ? "iOS" : "Android"}</span>
                <span>{d.deviceName || "이름 없음"}{d.appVersion ? ` · 앱 ${d.appVersion}` : ""}</span>
                <span className="text-gray-500">최근 {fmt(d.lastSeenAt)}</span>
                {d.disabledAt && <span className="text-red-700">비활성(토큰 무효 — 앱에서 다시 로그인)</span>}
                {!d.disabledAt && d.lastError && <span className="text-amber-700">최근 오류: {d.lastError}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <ResultLine result={result} />
    </div>
  );
}
