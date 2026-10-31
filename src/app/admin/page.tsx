import Link from "next/link";
import { kakaoCandidates, notifyStatus } from "@/lib/services/notify";
import { getCurrentUser } from "@/lib/auth/session";
import { getAdminData } from "@/lib/services/admin";
import { AppError } from "@/lib/util/errors";
import { Card, PageTitle } from "@/components/ui";
import { AccessDenied } from "@/components/AccessDenied";
import { NewUserForm, RecipientsPanel, RemoteControlPanel, SettingsPanel, UserRow } from "@/components/AdminPanels";
import { formatDateTime } from "@/lib/util/time";

export default async function AdminPage() {
  const user = await getCurrentUser();
  let d;
  try {
    d = await getAdminData(user);
  } catch (e) {
    return <AccessDenied reason={e instanceof AppError ? e.message : "접근할 수 없습니다."} />;
  }
  const notify = notifyStatus();
  const kakaoUsers = await kakaoCandidates();
  const sites = d.sites.map((s) => ({ id: s.id, name: s.name }));

  return (
    <>
      <PageTitle title="관리 설정" subtitle="운영 설정·사용자·권한·알림 수신·감사 기록 (본사 관리자 전용). 사업장·지도·로봇 배치·제조사 연결은 고급 설정." />

      <div className="space-y-4">
        <Card title="운영 설정">
          <SettingsPanel siteManagerCanConfirm={d.settings.siteManagerCanConfirmReports} allowSampleReset={d.allowSampleReset} />
          <p className="text-xs text-gray-500 mt-2">명령 만료 {d.settings.commandExpiryMinutes}분 · 접수 후 실행 확인 대기 {d.settings.commandAcceptedTimeoutSeconds}초 (운영 설정값, 하드코딩 아님)</p>
        </Card>

        <Card title="원격 제어 (사업장별)">
          <RemoteControlPanel sites={d.sites.map((s) => ({ id: s.id, name: s.name, enabled: s.remoteControlEnabled, liveRobots: d.robots.filter((r) => r.siteId === s.id && r.vendorMeta?.source === "api").length }))} />
          <p className="text-xs text-gray-500 mt-2">꺼진 사업장은 본사 관리자를 포함해 누구도 로봇에 원격 명령(시작·일시정지·재개·중지·복귀)을 보낼 수 없습니다. 켜도 사용자별 제어 권한은 그대로 적용됩니다. 켜고 끈 기록은 감사 기록에 남습니다.</p>
        </Card>

        <Card title="사용자 · 사업장 권한 · 제어 권한">
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>사용자</th>
                  <th>역할</th>
                  <th>사업장 권한</th>
                  <th>제어 명령(고객 제어)</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {d.users.map((u) => (
                  <UserRow key={u.id} u={u} sites={sites} selfId={user.id} auth={d.userAuth.find((a) => a.id === u.id) ?? { hasPassword: false, inviteLink: null, lastLoginAt: null }} />
                ))}
              </tbody>
            </table>
          </div>
          <details className="mt-3 border rounded p-3">
            <summary className="cursor-pointer text-sm font-medium">사용자 추가</summary>
            <div className="mt-2"><NewUserForm sites={sites} /></div>
          </details>
          <p className="text-xs text-gray-500 mt-2">비활성화하면 세션이 즉시 종료되고 모든 조회·명령이 서버에서 차단됩니다. 사용자는 초대 링크로 본인이 비밀번호를 설정합니다(이메일 자동 발송은 5단계).</p>
        </Card>

        <Card title="고급 설정">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Link href="/admin/advanced" className="inline-flex items-center rounded border border-amber-400 bg-amber-50 px-3 py-1.5 text-amber-900 font-medium">고급 설정 열기 →</Link>
            <span className="text-xs text-gray-600">사업장·층·구역·로봇 배치, 지도 가져오기, 제조사 연결(PUDU). 잘못 바꾸면 위치 표시·보고서가 달라지므로 따로 두었습니다.</span>
          </div>
        </Card>

        <Card title="알림 수신 설정 (사업장별)">
          <div className="grid md:grid-cols-2 gap-4">
            {d.notificationSettings.map((n) => (
              <div key={n.siteId} className="border rounded p-3">
                <div className="font-medium text-sm mb-1">{d.sites.find((s) => s.id === n.siteId)?.name}</div>
                <RecipientsPanel siteId={n.siteId} recipients={n.recipients} dedupeMinutes={n.dedupeMinutes} escalateAfterMinutes={n.escalateAfterMinutes} kakaoUsers={kakaoUsers} />
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-500 mt-2">
            이메일: <b>{notify.modes.EMAIL === "live" ? `실제 발송(AWS SES, 보내는 주소 ${notify.emailFrom})` : "모의 발송(서버 설정 전)"}</b> · 카카오톡: <b>{notify.modes.KAKAO === "live" ? "실제 발송(나에게 보내기 — 수신자 본인이 내 계정에서 연결)" : "모의 발송(서버 설정 전)"}</b>.
            장애 발생(등급 HIGH 이상)·복구·미조치 확대 통보를 보냅니다. 전화번호로 보내는 알림톡은 발송대행사 선정 뒤 붙입니다.
          </p>
        </Card>

        <Card title="감사 기록 (최근 50건)">
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>시각</th>
                  <th>사용자</th>
                  <th>사업장 / 로봇</th>
                  <th>행위</th>
                  <th>파라미터</th>
                  <th>결과</th>
                  <th>추적 ID</th>
                </tr>
              </thead>
              <tbody>
                {d.audit.map((a) => (
                  <tr key={a.id}>
                    <td className="whitespace-nowrap">{formatDateTime(a.at)}</td>
                    <td>{a.userName}</td>
                    <td className="text-xs">{a.siteId ?? "-"} / {a.robotId ?? "-"}</td>
                    <td className="font-mono text-xs">{a.action}</td>
                    <td className="font-mono text-[11px] max-w-[260px] truncate" title={JSON.stringify(a.params)}>{JSON.stringify(a.params)}</td>
                    <td><span className={a.result === "OK" ? "text-emerald-700" : a.result === "DENIED" ? "text-red-700" : "text-amber-700"}>{a.result}</span>{a.detail ? <div className="text-xs text-gray-500">{a.detail}</div> : null}</td>
                    <td className="font-mono text-xs">{a.vendorTraceId ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}
