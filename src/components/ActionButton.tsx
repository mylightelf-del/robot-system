"use client";

import { useState, useTransition, type ReactNode } from "react";
import type { ActionResult } from "@/app/actions";

export function useAction() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const run = (fn: () => Promise<ActionResult>) =>
    start(async () => {
      setResult(null);
      const r = await fn();
      setResult(r);
    });
  return { pending, result, run, clear: () => setResult(null) };
}

export function ResultLine({ result }: { result: ActionResult | null }) {
  if (!result) return null;
  return result.ok ? (
    <div className="text-xs text-emerald-700 mt-1">{result.message ?? "처리되었습니다."}</div>
  ) : (
    <div className="text-xs text-red-700 mt-1">⚠ {result.error}</div>
  );
}

export const btn = {
  primary: "inline-flex items-center justify-center rounded bg-navy text-white px-3 py-1.5 text-sm font-medium hover:bg-navy-light disabled:opacity-50 disabled:cursor-not-allowed",
  secondary: "inline-flex items-center justify-center rounded border border-gray-300 bg-white text-gray-800 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed",
  danger: "inline-flex items-center justify-center rounded border border-red-300 bg-red-50 text-red-800 px-3 py-1.5 text-sm hover:bg-red-100 disabled:opacity-50 disabled:cursor-not-allowed",
  small: "inline-flex items-center justify-center rounded border border-gray-300 bg-white text-gray-800 px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed",
};

/**
 * 서버 액션을 호출하는 버튼. 처리 중에는 비활성화되어 같은 버튼 중복 클릭을 막는다.
 */
export function ActionButton({
  action,
  children,
  variant = "secondary",
  confirmText,
  disabled,
  className = "",
  showResult = true,
}: {
  action: () => Promise<ActionResult>;
  children: ReactNode;
  variant?: keyof typeof btn;
  confirmText?: string;
  disabled?: boolean;
  className?: string;
  showResult?: boolean;
}) {
  const { pending, result, run } = useAction();
  return (
    <span className="inline-flex flex-col">
      <button
        type="button"
        className={`${btn[variant]} ${className}`}
        disabled={pending || disabled}
        onClick={() => {
          if (confirmText && !window.confirm(confirmText)) return;
          run(action);
        }}
      >
        {pending ? "처리 중…" : children}
      </button>
      {showResult ? <ResultLine result={result} /> : null}
    </span>
  );
}
