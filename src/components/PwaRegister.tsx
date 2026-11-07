"use client";

import { useEffect } from "react";

/** 홈 화면 추가(PWA)를 위한 서비스 워커 등록. 실패해도 화면 동작에는 영향이 없다. */
export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);
  return null;
}
