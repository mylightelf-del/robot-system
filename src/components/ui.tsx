import type { ReactNode } from "react";

/** 화면 제목: 큰 제목 + 설명 + 오른쪽 도구. */
export function PageTitle({ title, subtitle, right }: { title: string; subtitle?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
      <div className="min-w-0">
        <h1 className="text-2xl sm:text-[1.7rem] font-bold tracking-tight text-navy leading-tight">{title}</h1>
        {subtitle ? <p className="text-sm text-slate-500 mt-1">{subtitle}</p> : null}
      </div>
      {right ? <div className="flex flex-wrap gap-2 items-center">{right}</div> : null}
    </div>
  );
}

/** 카드: 흰 바탕, 가는 테두리, 부드러운 그림자, 둥근 모서리. 제목 줄은 선택. */
export function Card({ title, children, className = "", right }: { title?: ReactNode; children: ReactNode; className?: string; right?: ReactNode }) {
  return (
    <section className={`rise bg-surface rounded-2xl border border-gray-200/80 shadow-[var(--shadow-card)] ${className}`}>
      {title ? (
        <div className="px-4 sm:px-5 py-3 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold text-navy text-[0.95rem] tracking-tight">{title}</h2>
          {right}
        </div>
      ) : null}
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

/** 알약형 배지. 색은 className 으로. */
export function Badge({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 border border-transparent whitespace-nowrap ${className}`}>{children}</span>;
}

export function SimTag({ children = "시뮬레이션" }: { children?: ReactNode }) {
  return <Badge className="bg-amber-50 text-amber-800 border-amber-200">{children}</Badge>;
}

/** 핵심 숫자 카드. 왼쪽 색 띠로 상태를 알린다. */
export function Stat({ label, value, hint, tone = "default" }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "default" | "warn" | "bad" | "good" }) {
  const toneCls = { default: "text-navy", warn: "text-amber-600", bad: "text-red-600", good: "text-emerald-600" }[tone];
  const bar = { default: "bg-accent/70", warn: "bg-amber-400", bad: "bg-red-400", good: "bg-emerald-400" }[tone];
  return (
    <div className="rise relative overflow-hidden bg-surface rounded-2xl border border-gray-200/80 shadow-[var(--shadow-card)] px-4 py-3.5">
      <span className={`absolute left-0 top-3 bottom-3 w-1 rounded-r ${bar}`} aria-hidden />
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-0.5 text-2xl sm:text-[1.7rem] font-bold tracking-tight tabular-nums ${toneCls}`}>{value}</div>
      {hint ? <div className="text-xs text-slate-500 mt-1 leading-snug">{hint}</div> : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="text-sm text-slate-500 py-8 text-center">
      <div className="mx-auto mb-2 h-9 w-9 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center" aria-hidden>
        —
      </div>
      {children}
    </div>
  );
}

export function KV({ items }: { items: { k: string; v: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {items.map((it) => (
        <div key={it.k} className="contents">
          <dt className="text-slate-500 whitespace-nowrap">{it.k}</dt>
          <dd className="text-slate-900 break-words">{it.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 안내 상자: 왼쪽 색 띠 + 옅은 바탕. */
export function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" | "bad" }) {
  const cls = { info: "bg-sky-50 border-sky-200 text-sky-950 border-l-sky-400", warn: "bg-amber-50 border-amber-200 text-amber-950 border-l-amber-400", bad: "bg-red-50 border-red-200 text-red-950 border-l-red-400" }[tone];
  return <div className={`rounded-xl border border-l-4 px-3.5 py-2.5 text-sm leading-relaxed ${cls}`}>{children}</div>;
}
