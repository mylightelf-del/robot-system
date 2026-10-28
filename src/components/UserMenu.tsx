import Link from "next/link";
import { logoutAction } from "@/app/actions";

export function UserMenu({ name, role }: { name: string; role: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="whitespace-nowrap">
        <b>{name}</b> <span className="opacity-80">· {role}</span>
      </span>
      <Link href="/account" className="underline opacity-90 hover:opacity-100 whitespace-nowrap">
        비밀번호
      </Link>
      <form action={logoutAction}>
        <button type="submit" className="rounded border border-white/40 px-2 py-0.5 hover:bg-white/10 whitespace-nowrap">
          로그아웃
        </button>
      </form>
    </div>
  );
}
