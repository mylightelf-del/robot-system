import { getCurrentUser } from "@/lib/auth/session";
import { ChangePasswordForm } from "@/components/AuthForms";
import { Card, KV, PageTitle } from "@/components/ui";
import { ROLE_LABEL } from "@/lib/domain/status";
import { MyNotifyPanel } from "@/components/NotifyPanels";
import { myKakaoStatus, notifyStatus } from "@/lib/services/notify";

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ kakao?: string }> }) {
  const user = await getCurrentUser();
  const { kakao: kakaoResult } = await searchParams;
  const ns = notifyStatus();
  const kakao = await myKakaoStatus(user);
  return (
    <>
      <PageTitle title="내 계정" />
      <div className="grid md:grid-cols-2 gap-4">
        <Card title="계정 정보">
          <KV items={[{ k: "이름", v: user.name }, { k: "이메일", v: user.email }, { k: "역할", v: ROLE_LABEL[user.role] }, { k: "사업장 권한", v: user.sitePermissions.length ? user.sitePermissions.map((p) => p.siteId).join(", ") : user.role === "HQ_ADMIN" ? "전체" : "없음" }]} />
        </Card>
        <Card title="비밀번호 변경">
          <ChangePasswordForm />
        </Card>
        <Card title="알림 받기">
          <MyNotifyPanel email={user.email} emailMode={ns.modes.EMAIL} emailFrom={ns.emailFrom} kakao={kakao} kakaoResult={kakaoResult} />
        </Card>
      </div>
    </>
  );
}
