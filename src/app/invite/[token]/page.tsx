import { getInviteInfo } from "@/lib/services/auth";
import { InviteForm } from "@/components/AuthForms";
import { Notice } from "@/components/ui";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const info = await getInviteInfo(token);
  return (
    <div className="max-w-sm mx-auto mt-8 sm:mt-16">
      <h1 className="text-xl font-bold text-navy mb-1">비밀번호 설정</h1>
      {!info ? (
        <Notice tone="bad">초대 링크가 만료되었거나 유효하지 않습니다. 본사 관리자에게 재발급을 요청하세요.</Notice>
      ) : (
        <>
          <p className="text-sm text-gray-600 mb-4">
            <b>{info.name}</b> ({info.email}) 계정의 비밀번호를 설정합니다. 링크는 1회만 사용할 수 있습니다.
          </p>
          <InviteForm token={token} />
        </>
      )}
    </div>
  );
}
