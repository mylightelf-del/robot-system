/**
 * 오류 코드 칩. 마우스를 올리거나(키보드 초점) 누르면 코드 뜻과 점검 순서가 짧게 뜬다.
 * 서버 컴포넌트에서 그대로 쓸 수 있다(CSS 만 사용). steps 는 담당자에게만 넘긴다(고객 화면은 코드 자체를 보여주지 않는다).
 */
export function CodeChip({ code, summary, steps = [], vendor = false, className = "" }: { code: string; summary: string; steps?: string[]; vendor?: boolean; className?: string }) {
  return (
    <span className={`group relative inline-block font-mono text-xs cursor-help border-b border-dotted border-gray-400 ${className}`} tabIndex={0} aria-label={`${code}: ${summary}`}>
      {code}
      <span role="tooltip" className="pointer-events-none invisible opacity-0 group-hover:visible group-hover:opacity-100 group-focus:visible group-focus:opacity-100 transition-opacity absolute left-0 top-full z-30 mt-1 w-64 max-w-[80vw] rounded-lg bg-slate-800 text-white text-[11px] font-sans font-normal leading-snug p-2 shadow-lg whitespace-normal text-left">
        <span className="block font-semibold">{summary}</span>
        {steps.length > 0 && (
          <ol className="mt-1 list-decimal pl-4 space-y-0.5 text-slate-200">
            {steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        )}
        {vendor && !steps.some((s) => s.includes("대리점")) && <span className="block mt-1 text-slate-400">반복되면 대리점(제조사)에 문의</span>}
      </span>
    </span>
  );
}
