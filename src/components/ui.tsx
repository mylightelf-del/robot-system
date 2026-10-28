import type { ReactNode } from "react";

export function PageTitle({ title, subtitle, right }: { title: string; subtitle?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2 mb-4">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-navy">{title}</h1>
        {subtitle ? <p className="text-sm text-gray-600 mt-0.5">{subtitle}</p> : null}
      </div>
      {right ? <div className="flex flex-wrap gap-2 items-center">{right}</div> : null}
    </div>
  );
}

export function Card({ title, children, className = "", right }: { title?: ReactNode; children: ReactNode; className?: string; right?: ReactNode }) {
  return (
    <section className={`bg-white rounded-lg border border-gray-200 shadow-sm ${className}`}>
      {title ? (
        <div className="px-4 py-2.5 border-b border-gray-100 flex items-center justify-between gap-2">
          <h2 className="font-semibold text-navy text-sm sm:text-base">{title}</h2>
          {right}
        </div>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Badge({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium border border-transparent ${className}`}>{children}</span>;
}

export function SimTag({ children = "시뮬레이션" }: { children?: ReactNode }) {
  return <Badge className="bg-amber-50 text-amber-800 border-amber-200">{children}</Badge>;
}

export function Stat({ label, value, hint, tone = "default" }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "default" | "warn" | "bad" | "good" }) {
  const toneCls = { default: "text-navy", warn: "text-amber-700", bad: "text-red-700", good: "text-emerald-700" }[tone];
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-xl sm:text-2xl font-bold ${toneCls}`}>{value}</div>
      {hint ? <div className="text-xs text-gray-500 mt-0.5">{hint}</div> : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-sm text-gray-500 py-6 text-center">{children}</div>;
}

export function KV({ items }: { items: { k: string; v: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      {items.map((it) => (
        <div key={it.k} className="contents">
          <dt className="text-gray-500 whitespace-nowrap">{it.k}</dt>
          <dd className="text-gray-900 break-words">{it.v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" | "bad" }) {
  const cls = { info: "bg-blue-50 border-blue-200 text-blue-900", warn: "bg-amber-50 border-amber-200 text-amber-900", bad: "bg-red-50 border-red-200 text-red-900" }[tone];
  return <div className={`rounded border px-3 py-2 text-sm ${cls}`}>{children}</div>;
}
