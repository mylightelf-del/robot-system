"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** 관제 화면 자동 새로고침(초 단위). 실제 운영에서는 서버 푸시/폴링 주기를 운영 설정으로 둔다. */
export function AutoRefresh({ seconds = 5 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}
