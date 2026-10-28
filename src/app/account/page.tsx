import { getCurrentUser } from "@/lib/auth/session";
import { ChangePasswordForm } from "@/components/AuthForms";
import { Card, KV, PageTitle } from "@/components/ui";
import { ROLE_LABEL } from "@/lib/domain/status";

export default async function AccountPage() {
  const user = await getCurrentUser();
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
      </div>
    </>
  );
}
