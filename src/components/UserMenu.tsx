import Link from "next/link";
import { logoutAction } from "@/app/actions";

export function UserMenu({ name, role }: { name: string; role: string }) {
  return (
    <div className="flex items-center gap-1.5 sm:gap-2">
      <Link href="/account" className="group inline-flex items-center gap-2 rounded-full bg-white/10 hover:bg-white/15 pl-1 pr-2.5 py-0.5 whitespace-nowrap transition" title="내 계정">
        <span className="h-6 w-6 rounded-full bg-white/90 text-navy text-xs font-bold flex items-center justify-center" aria-hidden>
          {name.trim().slice(0, 1)}
        </span>
        <span className="hidden sm:inline">
          <b>{name}</b> <span className="opacity-75">· {role}</span>
        </span>
      </Link>
      <form action={logoutAction}>
        <button type="submit" className="rounded-full border border-white/30 px-2.5 py-0.5 hover:bg-white/10 whitespace-nowrap transition">
          로그아웃
        </button>
      </form>
    </div>
  );
}
