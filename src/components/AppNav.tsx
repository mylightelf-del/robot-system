"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Role } from "@/lib/domain/types";

const ITEMS: { href: string; label: string; staffOnly?: boolean; adminOnly?: boolean }[] = [
  { href: "/", label: "종합 대시보드" },
  { href: "/sites", label: "사업장 관제" },
  { href: "/robots", label: "로봇" },
  { href: "/tasks", label: "작업·일정" },
  { href: "/incidents", label: "장애·조치" },
  { href: "/reports", label: "실적·보고서" },
  { href: "/admin", label: "관리 설정", adminOnly: true },
];

export function AppNav({ role, isCustomer }: { role: Role; isCustomer: boolean }) {
  const pathname = usePathname();
  return (
    <nav className="bg-navy-light/60 border-t border-white/10">
      <div className="max-w-7xl mx-auto px-2 flex overflow-x-auto text-sm">
        {ITEMS.filter((i) => !(i.adminOnly && role !== "HQ_ADMIN")).map((i) => {
          const active = i.href === "/" ? pathname === "/" : pathname.startsWith(i.href);
          return (
            <Link
              key={i.href}
              href={i.href}
              className={`px-3 py-2 whitespace-nowrap border-b-2 ${active ? "border-white text-white font-semibold" : "border-transparent text-white/80 hover:text-white"}`}
            >
              {i.label}
              {isCustomer && i.href === "/tasks" ? <span className="ml-1 text-[10px] opacity-70">조회</span> : null}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
