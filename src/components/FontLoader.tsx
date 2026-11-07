"use client";

import { useEffect } from "react";

/**
 * Pretendard 가변 글꼴(동적 서브셋, jsDelivr CDN)을 화면이 뜬 뒤에 붙인다.
 * <head> 의 stylesheet 로 넣으면 CDN 이 느리거나 막힌 망에서 첫 화면이 멈추므로, 비동기로 넣고 못 받으면 시스템 한글 글꼴을 그대로 쓴다.
 */
const HREF = "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css";

export function FontLoader() {
  useEffect(() => {
    if (document.querySelector(`link[href="${HREF}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = HREF;
    link.crossOrigin = "anonymous";
    document.head.appendChild(link);
  }, []);
  return null;
}
