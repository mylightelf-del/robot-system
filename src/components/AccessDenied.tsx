import { Notice } from "./ui";

export function AccessDenied({ reason }: { reason: string }) {
  return (
    <div className="max-w-xl mx-auto mt-10">
      <Notice tone="bad">
        <strong>접근 차단</strong> — {reason}
      </Notice>
      <p className="text-xs text-gray-500 mt-2">서버에서 사업장 범위·역할·활성 여부를 검증한 결과입니다. 역할 전환기로 다른 샘플 사용자를 선택해 비교해 보세요.</p>
    </div>
  );
}
