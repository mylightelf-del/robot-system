"use client";

import { useState, type ReactNode } from "react";

/** 고급 설정 잠금: '이해했습니다'를 체크해야 아래 설정을 바꿀 수 있다(실수로 지도·배치를 바꾸지 않도록). */
export function AdvancedGate({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <label className="flex items-start gap-2 text-sm mb-3 p-3 rounded border border-amber-300 bg-amber-50 text-amber-900">
        <input type="checkbox" className="mt-1" checked={open} onChange={(e) => setOpen(e.target.checked)} />
        <span>
          이 화면은 사업장·층·지도·로봇 배치와 제조사 연결을 바꿉니다. 바꾸면 사업장 관제의 위치 표시, 청소 구역, 보고서의 지도·소속이 달라질 수 있습니다.
          <b> 로봇 자체의 지도·층은 이 시스템이 바꾸지 않습니다</b>(PUDU 앱에서만 바뀜). 내용을 이해했고 바꿀 일이 있을 때만 체크하세요.
        </span>
      </label>
      <div inert={!open} aria-disabled={!open} className={open ? "" : "opacity-50 select-none"}>
        {children}
      </div>
    </div>
  );
}
