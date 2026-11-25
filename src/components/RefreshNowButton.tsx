"use client";

import { useState, useTransition } from "react";
import { refreshRobotsNowAction } from "@/app/actions";
import { btn } from "./ActionButton";

type Step = { name: string; ok: boolean; detail: string };

/** 본사 관리자용 「지금 업데이트」: 로봇 상태·작업/예약·예정 회차를 제조사에서 즉시 다시 받는다. */
export function RefreshNowButton({ lastAt }: { lastAt: string | null }) {
  const [pending, start] = useTransition();
  const [res, setRes] = useState<{ ok: boolean; text: string; steps?: Step[] } | null>(null);
  const [open, setOpen] = useState(false);
  const fmt = (iso: string) => new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500" title="로봇 상태를 마지막으로 받은 시각">{lastAt ? `마지막 업데이트 ${fmt(lastAt)}` : "업데이트 기록 없음"}</span>
        <button
          type="button"
          className={btn.secondary}
          disabled={pending}
          onClick={() =>
            start(async () => {
              setRes(null);
              const r = await refreshRobotsNowAction();
              setRes({ ok: r.ok, text: r.ok ? (r.message ?? "업데이트 완료") : (r.error ?? "실패"), steps: r.steps });
              setOpen(!r.ok);
            })
          }
        >
          <span aria-hidden className={pending ? "animate-spin inline-block" : ""}>↻</span>
          {pending ? "업데이트 중…" : "지금 업데이트"}
        </button>
      </div>
      {res && (
        <div className={`text-xs ${res.ok ? "text-emerald-700" : "text-red-700"} text-right`}>
          {res.text}
          {res.steps?.length ? (
            <button type="button" className="ml-2 underline text-slate-500" onClick={() => setOpen(!open)}>
              {open ? "접기" : "자세히"}
            </button>
          ) : null}
          {open && res.steps && (
            <ul className="mt-1 text-left text-slate-600">
              {res.steps.map((s) => (
                <li key={s.name}>
                  <span className={s.ok ? "text-emerald-600" : "text-red-600"}>{s.ok ? "●" : "○"}</span> {s.name}: {s.detail}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
