"use client";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="max-w-xl mx-auto mt-10 bg-red-50 border border-red-200 rounded p-4 text-sm text-red-900">
      <div className="font-semibold">화면을 표시하는 중 오류가 발생했습니다.</div>
      <div className="text-xs mt-1 text-red-700">내부 오류 원문은 고객 화면에 노출하지 않습니다. (digest: {error.digest ?? "-"})</div>
      <button type="button" onClick={reset} className="mt-3 rounded bg-navy text-white px-3 py-1.5">
        다시 시도
      </button>
    </div>
  );
}
