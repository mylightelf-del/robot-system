"use client";

import { testSelfNotifyAction, unlinkKakaoAction } from "@/app/actions";
import { ActionButton } from "./ActionButton";

const KAKAO_MSG: Record<string, { tone: string; text: string }> = {
  linked: { tone: "text-emerald-700", text: "카카오톡을 연결했습니다. '시험 발송' 으로 확인하세요." },
  denied: { tone: "text-amber-700", text: "카카오 동의를 취소했습니다." },
  state: { tone: "text-red-700", text: "연결 요청이 만료되었거나 올바르지 않습니다. 다시 시도하세요." },
  error: { tone: "text-red-700", text: "카카오 연결에 실패했습니다. 잠시 뒤 다시 시도하세요(관리자는 감사 기록에서 사유 확인)." },
  unconfigured: { tone: "text-amber-700", text: "서버에 카카오 연동이 아직 설정되지 않았습니다(관리자에게 문의)." },
};

/** 내 계정 → 알림 받기: 이메일·카카오톡 상태, 시험 발송, 카카오톡 연결/해제. */
export function MyNotifyPanel({
  email,
  emailMode,
  emailFrom,
  kakao,
  kakaoResult,
}: {
  email: string;
  emailMode: "live" | "mock";
  emailFrom: string | null;
  kakao: { configured: boolean; linked: boolean; linkedAt: string | null; lastSentAt: string | null; lastError: string | null };
  kakaoResult?: string;
}) {
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "-");
  const msg = kakaoResult ? KAKAO_MSG[kakaoResult] : undefined;
  return (
    <div className="space-y-4 text-sm">
      <div>
        <div className="font-medium">이메일</div>
        <div className="text-xs text-gray-600 mb-1">
          받는 주소 {email} · {emailMode === "live" ? `실제 발송(보내는 주소 ${emailFrom})` : "모의 발송(서버 이메일 설정 전)"}
        </div>
        <ActionButton variant="small" action={() => testSelfNotifyAction("EMAIL")}>내 이메일로 시험 발송</ActionButton>
      </div>
      <div>
        <div className="font-medium">카카오톡(나에게 보내기)</div>
        {!kakao.configured ? (
          <p className="text-xs text-amber-700">서버에 카카오 연동이 아직 설정되지 않았습니다.</p>
        ) : kakao.linked ? (
          <div className="text-xs text-gray-600 mb-1">
            연결됨 · {fmt(kakao.linkedAt)} 연결 · 최근 발송 {fmt(kakao.lastSentAt)}
            {kakao.lastError && <div className="text-red-700">최근 오류: {kakao.lastError} — 계속되면 다시 연결하세요.</div>}
          </div>
        ) : (
          <p className="text-xs text-gray-600 mb-1">카카오 로그인으로 연결하면 관리자가 수신자로 지정한 장애 알림이 내 카카오톡 &lsquo;나와의 채팅&rsquo;으로 옵니다.</p>
        )}
        {msg && <p className={`text-xs mb-1 ${msg.tone}`}>{msg.text}</p>}
        <div className="flex flex-wrap gap-2">
          {kakao.configured && (
            <a href="/api/kakao/connect" className="inline-flex items-center rounded px-2 py-1 text-xs font-medium" style={{ background: "#FEE500", color: "#191919" }}>
              {kakao.linked ? "카카오톡 다시 연결" : "카카오톡 연결"}
            </a>
          )}
          {kakao.linked && <ActionButton variant="small" action={() => testSelfNotifyAction("KAKAO")}>내 카카오톡으로 시험 발송</ActionButton>}
          {kakao.linked && <ActionButton variant="small" confirmText="카카오톡 연결을 해제할까요? 알림이 카카오톡으로 오지 않습니다." action={() => unlinkKakaoAction()}>연결 해제</ActionButton>}
        </div>
      </div>
    </div>
  );
}
