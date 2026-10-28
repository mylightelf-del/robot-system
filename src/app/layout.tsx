import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";
import { getCurrentUser } from "@/lib/auth/session";
import { getStore } from "@/lib/store/store";
import { AppNav } from "@/components/AppNav";
import { RoleSwitcher } from "@/components/RoleSwitcher";
import { ROLE_LABEL } from "@/lib/domain/status";

export const metadata: Metadata = {
  title: "청소로봇 통합관제 (시제품)",
  description: "포스코와이드 청소로봇 통합관제 1단계 시제품 — 샘플 데이터",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

// 모든 화면은 요청마다 동적으로 렌더링한다(메모리 저장소 + 역할 쿠키).
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  const store = getStore();
  const users = store.users.map((u) => ({ id: u.id, name: u.name, role: ROLE_LABEL[u.role], active: u.active }));
  const isCustomer = user.role === "CUSTOMER_BASIC" || user.role === "CUSTOMER_CONTROL";

  return (
    <html lang="ko" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <div className="no-print bg-sample text-amber-900 text-xs sm:text-sm px-4 py-1.5 border-b border-amber-200 text-center">
          <strong>샘플 데이터 · 시뮬레이션</strong> — 사업장명·모델별 대수·배치는 모두 가상입니다. 실제 로봇 명령은 전송되지 않습니다. 역할 전환기는 실제 인증을 대신하지 않습니다.
        </div>
        <header className="no-print bg-navy text-white">
          <div className="max-w-7xl mx-auto px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
            <Link href="/" className="font-bold text-base sm:text-lg whitespace-nowrap">
              청소로봇 통합관제 <span className="text-xs font-normal opacity-80">1단계 시제품</span>
            </Link>
            <div className="ml-auto flex items-center gap-2 text-xs sm:text-sm">
              <span className="opacity-80 hidden sm:inline">현재 사용자</span>
              <RoleSwitcher users={users} currentId={user.id} />
              {!user.active && <span className="bg-red-600 text-white px-2 py-0.5 rounded text-xs">비활성</span>}
            </div>
          </div>
          <AppNav role={user.role} isCustomer={isCustomer} />
        </header>
        <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-4 sm:py-6">{children}</main>
        <footer className="no-print text-xs text-gray-500 px-4 py-4 text-center border-t">
          청소로봇 통합관제 1단계 시제품 · 샘플 데이터 · 서버 재시작 시 초기화됩니다 · 시간 표시: Asia/Seoul
        </footer>
      </body>
    </html>
  );
}
