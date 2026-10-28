import Link from "next/link";
import type { Site } from "@/lib/domain/types";

/** 사업장 필터(링크). 서버가 다시 범위를 검증하므로 URL 조작으로 다른 사업장을 볼 수 없다. */
export function SiteFilter({ sites, current, basePath, extra = "" }: { sites: Site[]; current: string; basePath: string; extra?: string }) {
  const cls = (active: boolean) => `px-2.5 py-1 rounded text-xs sm:text-sm border ${active ? "bg-navy text-white border-navy" : "bg-white border-gray-300 text-gray-700"}`;
  return (
    <div className="flex flex-wrap gap-1">
      <Link href={`${basePath}${extra ? `?${extra}` : ""}`} className={cls(current === "")}>
        전체
      </Link>
      {sites.map((s) => (
        <Link key={s.id} href={`${basePath}?site=${s.id}${extra ? `&${extra}` : ""}`} className={cls(current === s.id)}>
          {s.name.replace(/^가상 사업장 /, "")}
        </Link>
      ))}
    </div>
  );
}
