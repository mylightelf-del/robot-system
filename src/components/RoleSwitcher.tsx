"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { switchUserAction } from "@/app/actions";

export function RoleSwitcher({ users, currentId }: { users: { id: string; name: string; role: string; active: boolean }[]; currentId: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <select
      aria-label="샘플 사용자 전환"
      className="bg-white text-navy rounded px-2 py-1 text-xs sm:text-sm max-w-[220px]"
      value={currentId}
      disabled={pending}
      onChange={(e) => {
        const id = e.target.value;
        start(async () => {
          await switchUserAction(id);
          router.push("/");
          router.refresh();
        });
      }}
    >
      {users.map((u) => (
        <option key={u.id} value={u.id}>
          {u.name} · {u.role}
          {u.active ? "" : " · 비활성"}
        </option>
      ))}
    </select>
  );
}
