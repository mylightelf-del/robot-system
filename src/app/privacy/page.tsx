import type { Metadata } from "next";

export const metadata: Metadata = { title: "개인정보처리방침 — 와이드봇 관제" };

const UPDATED = "2026-11-08";

/**
 * 개인정보처리방침(공개 페이지). Google Play 등록에 필수이며 앱 로그인 화면·내 계정에서 링크한다.
 * 로그인 없이 볼 수 있다(proxy.ts PUBLIC_PREFIXES). 내용을 바꾸면 UPDATED 날짜를 갱신한다.
 * 이 시스템은 업무용(B2B) 관제 시스템이며, 계정은 운영사 관리자가 초대로 만든다. 일반 대중의 가입은 없다.
 */
export default function PrivacyPage() {
  return (
    <article className="max-w-2xl mx-auto text-sm leading-relaxed text-gray-800 space-y-5">
      <header>
        <h1 className="text-xl font-bold text-navy">개인정보처리방침</h1>
        <p className="text-xs text-gray-500 mt-1">와이드봇 관제(청소로봇 통합관제) 웹·안드로이드 앱 · 시행일 {UPDATED}</p>
      </header>

      <section>
        <h2 className="font-semibold text-navy">1. 이 서비스는 무엇인가</h2>
        <p>와이드봇 관제는 건물 청소로봇의 상태·작업 실적·장애를 운영사(본사·현장 담당자)와 고객사 담당자가 확인하고 관리하는 업무용 시스템입니다. 계정은 운영사 관리자가 초대 링크로 만들어 주며, 누구나 가입하는 서비스가 아닙니다.</p>
      </section>

      <section>
        <h2 className="font-semibold text-navy">2. 수집하는 정보와 목적</h2>
        <table className="data text-xs">
          <thead>
            <tr>
              <th>항목</th>
              <th>목적</th>
              <th>언제</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>이름, 업무용 이메일, 역할, 담당 사업장</td>
              <td>계정 식별, 사업장별 접근 권한 적용, 알림 수신자 지정</td>
              <td>관리자가 계정을 만들 때</td>
            </tr>
            <tr>
              <td>비밀번호(단방향 해시로만 저장)</td>
              <td>로그인</td>
              <td>초대 링크로 비밀번호를 설정할 때</td>
            </tr>
            <tr>
              <td>로그인 기기 정보(앱: 제조사·모델명 / 웹: 브라우저·운영체제 요약), 로그인 시각</td>
              <td>내 계정의 &lsquo;로그인된 기기&rsquo; 표시, 기기별 로그아웃, 부정 사용 확인</td>
              <td>로그인할 때</td>
            </tr>
            <tr>
              <td>앱 푸시 알림 토큰(Firebase 클라우드 메시징 등록 토큰)</td>
              <td>장애·예정 작업 미실행·보고서 발행 알림을 앱으로 보내기</td>
              <td>앱에서 알림을 켤 때(끄면 즉시 삭제)</td>
            </tr>
            <tr>
              <td>카카오톡 연결 정보(카카오 회원번호, 암호화된 토큰)</td>
              <td>본인의 카카오톡으로 알림 보내기</td>
              <td>내 계정에서 직접 카카오톡을 연결할 때(해제하면 삭제)</td>
            </tr>
            <tr>
              <td>사용 기록(명령 전송, 장애 조치, 설정 변경, 로그인 성공·실패 시각과 사용자)</td>
              <td>로봇 원격 명령의 책임 소재 확인, 보안 감사</td>
              <td>해당 동작을 할 때</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-2">앱은 위치 정보, 연락처, 사진첩, 통화 기록, 광고 식별자를 수집하지 않습니다. 장애 조치 사진은 사용자가 직접 올리는 경우에만 저장됩니다. 지도에 표시되는 위치는 사용자가 아니라 청소로봇의 위치입니다.</p>
      </section>

      <section>
        <h2 className="font-semibold text-navy">3. 보관 기간</h2>
        <ul className="list-disc pl-5 space-y-1">
          <li>계정 정보: 계정이 비활성화(퇴사·계약 종료)된 뒤에도 과거 조치·명령 기록의 작성자 표시를 위해 이름만 유지하고, 로그인은 즉시 차단됩니다. 관리자에게 요청하면 삭제합니다.</li>
          <li>로그인 세션: 웹 최대 30일, 앱 최대 180일. 로그아웃·기기 끊기·비활성화 시 즉시 삭제.</li>
          <li>푸시 토큰: 알림을 끄거나 로그아웃하면 즉시 삭제. 기기에서 앱을 지우면 다음 발송 실패 시 비활성 처리.</li>
          <li>사용 기록(감사 기록): 서비스 운영 기간 동안 보관.</li>
        </ul>
      </section>

      <section>
        <h2 className="font-semibold text-navy">4. 제3자 제공·처리 위탁</h2>
        <ul className="list-disc pl-5 space-y-1">
          <li>개인정보를 판매하거나 광고 목적으로 제공하지 않습니다.</li>
          <li>알림 전달을 위해 다음 서비스를 이용합니다: Google Firebase 클라우드 메시징(앱 푸시 — 기기 토큰과 알림 제목·요약만 전달), Amazon SES(이메일), 카카오(카카오톡 &lsquo;나에게 보내기&rsquo;).</li>
          <li>서버는 Amazon Web Services(시드니 리전)에 있습니다.</li>
          <li>청소로봇 제조사 클라우드(PUDU 등)와는 로봇 상태·실적·명령만 주고받으며 사용자 개인정보는 전달하지 않습니다.</li>
        </ul>
      </section>

      <section>
        <h2 className="font-semibold text-navy">5. 안전조치</h2>
        <ul className="list-disc pl-5 space-y-1">
          <li>모든 통신은 HTTPS 로 암호화됩니다. 비밀번호는 복원할 수 없는 해시로, 로그인 토큰은 해시로만 저장합니다.</li>
          <li>앱의 로그인 토큰은 안드로이드 보안 저장소(Keystore)에 보관됩니다.</li>
          <li>사업장별 접근 범위를 서버에서 검사하며, 고객사 계정에는 내부 메모·원시 오류 문구가 보이지 않습니다.</li>
        </ul>
      </section>

      <section>
        <h2 className="font-semibold text-navy">6. 이용자의 권리</h2>
        <p>본인 정보의 열람·정정·삭제, 알림 수신 중단, 계정 삭제는 내 계정 화면에서 직접 하거나(알림 구독·기기·카카오톡 연결), 소속 운영사의 본사 관리자에게 요청할 수 있습니다. 앱 삭제만으로는 계정이 삭제되지 않으며, 계정 삭제는 관리자에게 요청하면 처리됩니다.</p>
      </section>

      <section>
        <h2 className="font-semibold text-navy">7. 문의</h2>
        <p>개인정보 관련 문의: 운영사 관리자 이메일 <a className="text-navy underline" href="mailto:mylightelf@gmail.com">mylightelf@gmail.com</a></p>
      </section>

      <footer className="text-xs text-gray-500">이 방침이 바뀌면 이 페이지에 시행일과 함께 게시합니다.</footer>
    </article>
  );
}
