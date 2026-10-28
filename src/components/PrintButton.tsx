"use client";

import { btn } from "./ActionButton";

/** 브라우저 인쇄 → PDF 저장. 서버측 PDF 생성은 5단계에서 검토한다. */
export function PrintButton() {
  return (
    <button type="button" className={btn.secondary} onClick={() => window.print()}>
      PDF 출력(인쇄)
    </button>
  );
}
