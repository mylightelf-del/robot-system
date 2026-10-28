"use client";

import { useActionState } from "react";
import { acceptInviteAction, changePasswordAction, loginAction, type ActionResult } from "@/app/actions";
import { btn } from "./ActionButton";

const input = "w-full border rounded px-3 py-2 text-sm";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(loginAction, null);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="next" value={next} />
      <label className="block text-sm">
        이메일
        <input name="email" type="email" autoComplete="username" required className={input} />
      </label>
      <label className="block text-sm">
        비밀번호
        <input name="password" type="password" autoComplete="current-password" required className={input} />
      </label>
      {state && !state.ok && <div className="text-sm text-red-700">⚠ {state.error}</div>}
      <button type="submit" className={`${btn.primary} w-full`} disabled={pending}>
        {pending ? "확인 중…" : "로그인"}
      </button>
    </form>
  );
}

export function InviteForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(acceptInviteAction, null);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <label className="block text-sm">
        새 비밀번호 (10자 이상, 영문+숫자)
        <input name="password" type="password" autoComplete="new-password" required minLength={10} className={input} />
      </label>
      <label className="block text-sm">
        새 비밀번호 확인
        <input name="password2" type="password" autoComplete="new-password" required minLength={10} className={input} />
      </label>
      {state && !state.ok && <div className="text-sm text-red-700">⚠ {state.error}</div>}
      <button type="submit" className={`${btn.primary} w-full`} disabled={pending}>
        {pending ? "저장 중…" : "비밀번호 설정"}
      </button>
    </form>
  );
}

export function ChangePasswordForm() {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(changePasswordAction, null);
  return (
    <form action={action} className="space-y-3">
      <label className="block text-sm">
        현재 비밀번호
        <input name="current" type="password" autoComplete="current-password" required className={input} />
      </label>
      <label className="block text-sm">
        새 비밀번호 (10자 이상, 영문+숫자)
        <input name="next" type="password" autoComplete="new-password" required minLength={10} className={input} />
      </label>
      <label className="block text-sm">
        새 비밀번호 확인
        <input name="next2" type="password" autoComplete="new-password" required minLength={10} className={input} />
      </label>
      {state && (state.ok ? <div className="text-sm text-emerald-700">{state.message}</div> : <div className="text-sm text-red-700">⚠ {state.error}</div>)}
      <button type="submit" className={btn.primary} disabled={pending}>
        {pending ? "저장 중…" : "변경"}
      </button>
    </form>
  );
}
