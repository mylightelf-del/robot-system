import { redirect } from "next/navigation";
import { getOptionalUser } from "@/lib/auth/session";
import { LoginForm } from "@/components/AuthForms";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; set?: string }> }) {
  const { next, set } = await searchParams;
  const user = await getOptionalUser();
  if (user) redirect(next && next.startsWith("/") ? next : "/");
  const sample = (process.env.VENDOR_MODE ?? "sample") === "sample" && process.env.APP_ENV !== "production";
  return (
    <div className="max-w-sm mx-auto mt-8 sm:mt-16">
      <h1 className="text-xl font-bold text-navy mb-1">로그인</h1>
      <p className="text-sm text-gray-600 mb-4">초대 링크로 비밀번호를 설정한 계정으로 로그인하세요.</p>
      {set === "1" && <div className="mb-3 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">비밀번호를 설정했습니다. 로그인하세요.</div>}
      <LoginForm next={next ?? "/"} />
      {sample && (
        <div className="mt-6 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <div className="font-semibold">샘플 계정 (개발 환경 전용)</div>
          <div className="mt-1">비밀번호는 .env 의 SAMPLE_USER_PASSWORD (기본 <code>sample1234!</code>)</div>
          <ul className="mt-1 space-y-0.5">
            <li>hq-admin@example.invalid — 본사 관리자</li>
            <li>site-a@example.invalid — 현장 담당자(사업장 1·2)</li>
            <li>site-b@example.invalid — 현장 담당자(사업장 3·4·5)</li>
            <li>customer1@example.invalid — 고객 기본(사업장 1)</li>
            <li>customer2@example.invalid — 고객 제어(사업장 2)</li>
            <li>former@example.invalid — 비활성(로그인 차단)</li>
          </ul>
        </div>
      )}
    </div>
  );
}
