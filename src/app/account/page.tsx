import { getCurrentAuth } from "@/lib/auth/session";
import { ChangePasswordForm } from "@/components/AuthForms";
import { Card, KV, PageTitle } from "@/components/ui";
import { ROLE_LABEL } from "@/lib/domain/status";
import { MyNotifyPanel } from "@/components/NotifyPanels";
import { MySubscriptions } from "@/components/MySubscriptions";
import { MyDevices } from "@/components/MyDevices";
import { MyPhoneForm } from "@/components/MyPhoneForm";
import { solapiConfig } from "@/lib/notify/solapi";
import { myKakaoStatus, myPushStatus, mySubscriptions, notifyStatus } from "@/lib/services/notify";
import { listMySessions } from "@/lib/services/auth";
import { listSites } from "@/lib/services/robots";

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ kakao?: string }> }) {
  const { user, session } = await getCurrentAuth();
  const { kakao: kakaoResult } = await searchParams;
  const ns = notifyStatus();
  const kakao = await myKakaoStatus(user);
  const push = await myPushStatus(user);
  const sessions = await listMySessions(user, session.id);
  const subs = await mySubscriptions(user);
  const sites = (await listSites(user)).map((s) => ({ id: s.id, name: s.name }));
  return (
    <>
      <PageTitle title="내 계정" />
      <div className="grid md:grid-cols-2 gap-4">
        <Card title="계정 정보">
          <KV items={[{ k: "이름", v: user.name }, { k: "이메일", v: user.email }, { k: "역할", v: ROLE_LABEL[user.role] }, { k: "사업장 권한", v: user.sitePermissions.length ? user.sitePermissions.map((p) => p.siteId).join(", ") : user.role === "HQ_ADMIN" ? "전체" : "없음" }]} />
        </Card>
        <Card title="휴대폰 번호 (카카오 알림톡)">
          <MyPhoneForm phone={user.phone ?? null} alimtalkReady={!!solapiConfig()} />
        </Card>
        <Card title="비밀번호 변경">
          <ChangePasswordForm />
        </Card>
        <Card title="알림 받기">
          <MyNotifyPanel email={user.email} emailMode={ns.modes.EMAIL} emailFrom={ns.emailFrom} kakao={kakao} kakaoResult={kakaoResult} />
        </Card>
        <Card title="내 알림 구독 (사업장·종류)">
          <MySubscriptions subs={subs.map((s) => ({ id: s.id, siteId: s.siteId, siteName: s.siteName, channel: s.channel, hoursFrom: s.hoursFrom, hoursTo: s.hoursTo, kinds: s.kinds }))} sites={sites} kakaoLinked={kakao.linked} pushReady={push.active > 0} />
        </Card>
        <Card title="로그인된 기기 (웹·앱)">
          <MyDevices sessions={sessions.map((s) => ({ id: s.id, kind: s.kind, deviceName: s.deviceName, lastSeenAt: s.lastSeenAt, createdAt: s.createdAt, current: s.current, pushDevices: s.pushDevices }))} push={{ configured: push.configured, devices: push.devices.map((d) => ({ id: d.id, platform: d.platform, deviceName: d.deviceName, appVersion: d.appVersion, lastSeenAt: d.lastSeenAt, disabledAt: d.disabledAt, lastError: d.lastError })) }} />
        </Card>
      </div>
    </>
  );
}
