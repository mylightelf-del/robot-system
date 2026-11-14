"use client";

import { useState } from "react";
import { setMyPhoneAction } from "@/app/actions";
import { btn, ResultLine, useAction } from "./ActionButton";

/** 내 휴대폰 번호(카카오 알림톡 수신용). */
export function MyPhoneForm({ phone, alimtalkReady }: { phone: string | null; alimtalkReady: boolean }) {
  const { pending, result, run } = useAction();
  const [value, setValue] = useState(phone ? phone.replace(/^(\d{3})(\d{3,4})(\d{4})$/, "$1-$2-$3") : "");
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <input className="border rounded px-2 py-1 w-44" inputMode="tel" placeholder="010-1234-5678" value={value} onChange={(e) => setValue(e.target.value)} />
        <button type="button" className={btn.small} disabled={pending} onClick={() => run(() => setMyPhoneAction(value))}>저장</button>
      </div>
      <p className="text-xs text-gray-500">카카오 알림톡(회사 카카오톡 채널)으로 배송 도착 등을 받을 때 씁니다. {alimtalkReady ? "알림톡 발송이 설정되어 있습니다." : "알림톡은 아직 준비 중입니다(솔라피·템플릿 검수 후 사용)."} 번호는 알림 발송에만 쓰고 화면에 공개하지 않습니다.</p>
      <ResultLine result={result} />
    </div>
  );
}
