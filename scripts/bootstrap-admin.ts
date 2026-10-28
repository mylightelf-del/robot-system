/**
 * 첫 본사 관리자 계정 생성(운영 초기 설정용). 초대 링크를 출력한다.
 * 사용: npm run db:bootstrap-admin -- "이름" admin@company.example
 *       (Docker) docker compose run --rm worker npx tsx scripts/bootstrap-admin.ts "이름" admin@company.example
 */
import { eq } from "drizzle-orm";
import { closeDb, getDb, schema } from "../src/lib/db/client";
import { randomToken } from "../src/lib/auth/password";
import { inviteUrl } from "../src/lib/services/admin";
import { addMinutes, nowIso } from "../src/lib/util/time";
import { newId } from "../src/lib/util/random";

async function main() {
  const [name, emailRaw] = process.argv.slice(2);
  if (!name || !emailRaw) throw new Error('사용법: bootstrap-admin "이름" 이메일');
  const email = emailRaw.trim().toLowerCase();
  const db = getDb();
  const now = nowIso();
  const token = randomToken(24);
  const existing = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
  if (existing) {
    await db.update(schema.users).set({ inviteToken: token, inviteExpiresAt: addMinutes(now, 72 * 60), active: true }).where(eq(schema.users.id, existing.id));
    console.log(`기존 계정(${email})에 초대 링크를 재발급했습니다.`);
  } else {
    await db.insert(schema.users).values({ id: newId("u"), name, email, role: "HQ_ADMIN", active: true, passwordHash: null, inviteToken: token, inviteExpiresAt: addMinutes(now, 72 * 60), createdAt: now });
    console.log(`본사 관리자 계정을 만들었습니다: ${name} <${email}>`);
  }
  await db.insert(schema.auditLogs).values({ id: newId("aud"), at: now, userId: "system", userName: "bootstrap-admin", siteId: null, robotId: null, action: "USER:BOOTSTRAP_ADMIN", params: { email }, result: "OK", detail: null, vendorTraceId: null });
  console.log(`초대 링크(72시간 유효, 1회용): ${inviteUrl(token)}`);
  await closeDb();
}

main().catch((e) => {
  console.error("실패:", e.message ?? e);
  process.exit(1);
});
