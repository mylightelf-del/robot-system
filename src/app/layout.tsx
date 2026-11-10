import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";
import { getOptionalUser } from "@/lib/auth/session";
import { AppNav } from "@/components/AppNav";
import { UserMenu } from "@/components/UserMenu";
import { ROLE_LABEL } from "@/lib/domain/status";
import { vendorModes } from "@/lib/vendors";
import { PwaRegister } from "@/components/PwaRegister";
import { FontLoader } from "@/components/FontLoader";

export const metadata: Metadata = {
  title: "Wide Bot",
  description: "Wide Bot — 포스코와이드 청소로봇 통합관제",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Wide Bot" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#1e3a5f" };

// 모든 화면은 요청마다 동적으로 렌더링한다(DB 조회 + 세션 쿠키).
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getOptionalUser();
  const isCustomer = !!user && (user.role === "CUSTOMER_BASIC" || user.role === "CUSTOMER_CONTROL");
  const modes = vendorModes();
  const sampleMode = Object.values(modes).every((m) => m !== "live");
  const liveVendors = (Object.keys(modes) as (keyof typeof modes)[]).filter((v) => modes[v] === "live");
  const mockVendors = (Object.keys(modes) as (keyof typeof modes)[]).filter((v) => modes[v] === "mock");
  const envLabel = process.env.APP_ENV && process.env.APP_ENV !== "production" ? process.env.APP_ENV : null;

  return (
    <html lang="ko" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <PwaRegister />
        <FontLoader />
        {sampleMode && (
          <div className="no-print bg-sample text-amber-900 text-xs sm:text-sm px-4 py-1.5 border-b border-amber-200 text-center">
            <strong>샘플 데이터 · 시뮬레이션 모드</strong> — 사업장명·모델별 대수·배치는 모두 가상입니다. 실제 로봇 명령은 전송되지 않습니다.
            {envLabel ? <span className="ml-2 rounded bg-amber-200 px-1.5 text-[11px]">{envLabel}</span> : null}
          </div>
        )}
        {!sampleMode && (
          <div className="no-print bg-blue-50 text-blue-900 text-xs sm:text-sm px-4 py-1.5 border-b border-blue-200 text-center">
            <strong>실제 연동 중: {liveVendors.join(", ")}</strong>
            {mockVendors.length ? <> · 모의 연동(mock): {mockVendors.join(", ")}</> : null}
            {" "}— {liveVendors.length + mockVendors.length < 3 ? "나머지 제조사는 미설정입니다. " : ""}PUDU 원격 제어는 사업장 스위치가 켜진 곳만, CenoBots·BIB 는 조회 전용입니다.
            {envLabel ? <span className="ml-2 rounded bg-blue-200 px-1.5 text-[11px]">{envLabel}</span> : null}
          </div>
        )}
        <header className="no-print sticky top-0 z-30 bg-gradient-to-r from-navy via-navy to-navy-light text-white shadow-[0_6px_20px_-12px_rgba(15,31,58,.6)]">
          <div className="max-w-7xl mx-auto px-4 py-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            <Link href="/" className="inline-flex items-center gap-2 font-bold text-base sm:text-lg whitespace-nowrap tracking-tight">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/icons/icon-192.png" alt="" className="h-7 w-7 rounded-lg ring-1 ring-white/20" />
              <span>Wide Bot</span>
              <span className="hidden sm:inline text-[11px] font-normal text-white/60 tracking-normal">by 포스코와이드</span>
            </Link>
            <div className="ml-auto flex items-center gap-2 text-xs sm:text-sm">
              {user ? <UserMenu name={user.name} role={ROLE_LABEL[user.role]} /> : <span className="opacity-80">로그인 필요</span>}
            </div>
          </div>
          {user ? <AppNav role={user.role} isCustomer={isCustomer} /> : null}
        </header>
        <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-5 sm:py-7">{children}</main>
        <footer className="no-print text-xs text-slate-400 px-4 py-5 text-center">
          <span className="font-semibold text-slate-500">Wide Bot</span> · 청소로봇 통합관제 · 만든 곳: <span className="text-slate-500">포스코와이드</span> · 시간 표시: 사업장 시간대(Asia/Seoul)
        </footer>
      </body>
    </html>
  );
}
