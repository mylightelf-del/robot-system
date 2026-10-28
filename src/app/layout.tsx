import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";
import { getOptionalUser } from "@/lib/auth/session";
import { AppNav } from "@/components/AppNav";
import { UserMenu } from "@/components/UserMenu";
import { ROLE_LABEL } from "@/lib/domain/status";
import { vendorModes } from "@/lib/vendors";

export const metadata: Metadata = {
  title: "청소로봇 통합관제",
  description: "포스코와이드 청소로봇 통합관제 — 2단계(기반)",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

// 모든 화면은 요청마다 동적으로 렌더링한다(DB 조회 + 세션 쿠키).
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getOptionalUser();
  const isCustomer = !!user && (user.role === "CUSTOMER_BASIC" || user.role === "CUSTOMER_CONTROL");
  const modes = vendorModes();
  const sampleMode = Object.values(modes).every((m) => m !== "live");
  const liveVendors = (Object.keys(modes) as (keyof typeof modes)[]).filter((v) => modes[v] === "live");
  const envLabel = process.env.APP_ENV && process.env.APP_ENV !== "production" ? process.env.APP_ENV : null;

  return (
    <html lang="ko" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        {sampleMode && (
          <div className="no-print bg-sample text-amber-900 text-xs sm:text-sm px-4 py-1.5 border-b border-amber-200 text-center">
            <strong>샘플 데이터 · 시뮬레이션 모드</strong> — 사업장명·모델별 대수·배치는 모두 가상입니다. 실제 로봇 명령은 전송되지 않습니다.
            {envLabel ? <span className="ml-2 rounded bg-amber-200 px-1.5 text-[11px]">{envLabel}</span> : null}
          </div>
        )}
        {!sampleMode && (
          <div className="no-print bg-blue-50 text-blue-900 text-xs sm:text-sm px-4 py-1.5 border-b border-blue-200 text-center">
            <strong>실제 연동 중: {liveVendors.join(", ")}</strong> — 나머지 제조사 로봇은 샘플/미설정입니다. 명령은 실제 로봇에 전송됩니다.
            {envLabel ? <span className="ml-2 rounded bg-blue-200 px-1.5 text-[11px]">{envLabel}</span> : null}
          </div>
        )}
        <header className="no-print bg-navy text-white">
          <div className="max-w-7xl mx-auto px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
            <Link href="/" className="font-bold text-base sm:text-lg whitespace-nowrap">
              청소로봇 통합관제 <span className="text-xs font-normal opacity-80">2단계</span>
            </Link>
            <div className="ml-auto flex items-center gap-2 text-xs sm:text-sm">
              {user ? <UserMenu name={user.name} role={ROLE_LABEL[user.role]} /> : <span className="opacity-80">로그인 필요</span>}
            </div>
          </div>
          {user ? <AppNav role={user.role} isCustomer={isCustomer} /> : null}
        </header>
        <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-4 sm:py-6">{children}</main>
        <footer className="no-print text-xs text-gray-500 px-4 py-4 text-center border-t">청소로봇 통합관제 · 시간 표시: 사업장 시간대(Asia/Seoul) · 저장: PostgreSQL</footer>
      </body>
    </html>
  );
}
