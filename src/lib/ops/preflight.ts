import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { DbLike } from "@/lib/db/repo";
import { schema } from "@/lib/db/client";
import { PUDU_CLUSTERS, parseShopIds } from "@/lib/vendors/pudu/client";

/**
 * 배포 전·기동 전 점검. 환경변수 규칙과 DB 상태를 검사해 문제를 목록으로 돌려준다(비밀값은 출력하지 않는다).
 * - error: 이 상태로 운영을 시작하면 안 되는 것(기동 중단)
 * - warn: 동작은 하지만 확인이 필요한 것
 */
export type Finding = { level: "error" | "warn" | "ok"; code: string; message: string };

export function checkEnv(env: NodeJS.ProcessEnv): Finding[] {
  const out: Finding[] = [];
  const prod = env.APP_ENV === "production";
  const push = (level: Finding["level"], code: string, message: string) => out.push({ level, code, message });

  if (!env.DATABASE_URL) push("error", "DATABASE_URL", "DATABASE_URL 이 없습니다.");
  if (!env.APP_ENV) push("warn", "APP_ENV", "APP_ENV 가 없습니다(development 로 동작). 운영 서버는 production 으로 두세요.");
  else if (!["development", "staging", "production"].includes(env.APP_ENV)) push("warn", "APP_ENV", `APP_ENV 값이 낯섭니다: ${env.APP_ENV}`);

  const base = env.APP_BASE_URL ?? "";
  if (!base) push(prod ? "error" : "warn", "APP_BASE_URL", "APP_BASE_URL 이 없습니다(초대 링크·콜백 URL 생성에 필요).");
  else if (prod && !/^https:\/\//.test(base)) push("error", "APP_BASE_URL", "운영에서는 APP_BASE_URL 이 https:// 로 시작해야 합니다(쿠키 secure·콜백 HTTPS).");
  else if (prod && /localhost|127\.0\.0\.1/.test(base)) push("error", "APP_BASE_URL", "운영 APP_BASE_URL 이 localhost 입니다.");

  if (base && env.DOMAIN) {
    try {
      const host = new URL(base).host;
      if (host !== env.DOMAIN) push("warn", "DOMAIN", `APP_BASE_URL 의 호스트(${host})와 DOMAIN(${env.DOMAIN})이 다릅니다. 콜백·초대 링크와 인증서 도메인이 어긋납니다.`);
    } catch {
      push("error", "APP_BASE_URL", `APP_BASE_URL 형식이 올바르지 않습니다: ${base}`);
    }
  }
  if (prod && !env.ACME_EMAIL) push("warn", "ACME_EMAIL", "ACME_EMAIL 이 없습니다(인증서 발급기관 계정·만료 알림용). Caddy 가 ZeroSSL 대체 발급을 못 할 수 있습니다.");
  if (prod && env.ALLOW_SAMPLE_RESET === "true") push("error", "ALLOW_SAMPLE_RESET", "운영에서 샘플 초기화가 켜져 있습니다(ALLOW_SAMPLE_RESET=false).");
  if (prod && env.SAMPLE_USER_PASSWORD) push("warn", "SAMPLE_USER_PASSWORD", "운영 .env 에 샘플 사용자 비밀번호가 있습니다. 샘플 적재를 하지 않는다면 지우세요.");
  if (prod && (env.VENDOR_MODE ?? "sample") === "sample") push("warn", "VENDOR_MODE", "운영인데 VENDOR_MODE=sample 입니다(모든 로봇이 시뮬레이션). 실제 연동이면 live 로.");

  const puduLive = (env.PUDU_MODE ?? env.VENDOR_MODE ?? "sample") === "live";
  const key = env.PUDU_API_APP_KEY;
  const secret = env.PUDU_API_APP_SECRET;
  if (puduLive) {
    if (!key || !secret) push("error", "PUDU_KEY", "PUDU live 인데 PUDU_API_APP_KEY/SECRET 이 없습니다.");
    if (!env.PUDU_API_BASE_URL && !(env.PUDU_API_CLUSTER && PUDU_CLUSTERS[env.PUDU_API_CLUSTER])) push("error", "PUDU_CLUSTER", "PUDU_API_CLUSTER 가 없거나 잘못됐습니다(cn|sea|de|us, 한국 계정은 sea).");
    if (parseShopIds(env.PUDU_SHOP_IDS).length === 0) push("error", "PUDU_SHOP_IDS", "PUDU_SHOP_IDS(허용 매장)가 비어 있어 live 로 켜지지 않습니다.");
    if (!env.PUDU_CALLBACK_CODE) push("warn", "PUDU_CALLBACK_CODE", "PUDU_CALLBACK_CODE 가 없습니다. 콜백 등록 전까지는 폴링만 동작합니다(정상).");
    else if (env.PUDU_CALLBACK_CODE.length < 16) push("warn", "PUDU_CALLBACK_CODE", "PUDU_CALLBACK_CODE 가 너무 짧습니다(발급값 그대로인지 확인).");
    if (env.PUDU_API_BASE_URL && prod) push("warn", "PUDU_API_BASE_URL", "운영에서 PUDU_API_BASE_URL(모의 서버용)이 설정돼 있습니다. 실서버는 클러스터로 지정하세요.");
  } else if (key || secret) {
    push("warn", "PUDU_KEY", "PUDU 키가 있지만 live 모드가 아닙니다(샘플 모드).");
  }
  if (env.NODE_USE_ENV_PROXY) push("warn", "PROXY", "NODE_USE_ENV_PROXY 가 설정돼 있습니다(개발 환경 전용). 운영 서버에서는 지우세요.");
  for (const k of ["PUDU_POLL_STATUS_SECONDS", "PUDU_POLL_REPORTS_MINUTES", "PUDU_POLL_CATALOG_MINUTES"]) {
    if (env[k] !== undefined && !(Number(env[k]) > 0)) push("error", k, `${k} 는 양수여야 합니다.`);
  }
  if (env.PUDU_POLL_STATUS_SECONDS && Number(env.PUDU_POLL_STATUS_SECONDS) < 10) push("warn", "PUDU_POLL_STATUS_SECONDS", "상태 폴링이 10초 미만입니다(로봇 수 × 2회 호출/주기 — 제조사 제한에 걸릴 수 있음).");
  if (out.length === 0) push("ok", "ENV", "환경변수 점검 통과");
  return out;
}

/** 마이그레이션 폴더의 항목 수(journal) — DB 에 적용된 수와 비교한다. */
export function migrationCountInRepo(root = process.cwd()): number {
  const journal = JSON.parse(readFileSync(path.join(root, "drizzle", "meta", "_journal.json"), "utf8")) as { entries: unknown[] };
  return journal.entries.length;
}

export async function checkDb(db: DbLike, opts: { expectedMigrations?: number; production?: boolean } = {}): Promise<Finding[]> {
  const out: Finding[] = [];
  try {
    await db.execute(sql`select 1`);
    out.push({ level: "ok", code: "DB", "message": "DB 연결 성공" });
  } catch (e) {
    return [{ level: "error", code: "DB", message: `DB 연결 실패: ${(e as Error).message}` }];
  }
  try {
    const rows = (await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)) as unknown as { rows?: { n: number }[] };
    const applied = Number(rows.rows?.[0]?.n ?? (rows as unknown as { n: number }[])[0]?.n ?? 0);
    if (opts.expectedMigrations !== undefined && applied < opts.expectedMigrations) out.push({ level: "error", code: "MIGRATIONS", message: `적용된 마이그레이션 ${applied}개 < 저장소 ${opts.expectedMigrations}개 — npm run db:migrate 를 먼저 실행하세요.` });
    else out.push({ level: "ok", code: "MIGRATIONS", message: `마이그레이션 ${applied}개 적용됨` });
  } catch {
    out.push({ level: "error", code: "MIGRATIONS", message: "마이그레이션 이력 테이블이 없습니다. npm run db:migrate 를 먼저 실행하세요." });
    return out;
  }
  const admins = await db.select({ id: schema.users.id }).from(schema.users).where(sql`${schema.users.role} = 'HQ_ADMIN' and ${schema.users.active} = true`);
  if (admins.length === 0) out.push({ level: "warn", code: "ADMIN", "message": "활성 본사 관리자가 없습니다. scripts/bootstrap-admin.ts 로 첫 관리자를 만드세요." });
  const samples = await db.select({ id: schema.sites.id }).from(schema.sites).where(sql`${schema.sites.isSample} = true`);
  if (samples.length && opts.production) out.push({ level: "warn", code: "SAMPLE_DATA", message: `운영 DB 에 샘플 사업장 ${samples.length}곳이 있습니다(가상 데이터가 고객 화면에 섞임).` });
  const hb = await db.select().from(schema.vendorSyncState).where(sql`${schema.vendorSyncState.id} = 'WORKER:heartbeat'`);
  if (hb.length === 0) out.push({ level: "warn", code: "WORKER", message: "워커 하트비트가 아직 없습니다(워커 미기동 또는 첫 기동 전)." });
  return out;
}

export function summarize(findings: Finding[]): { errors: number; warns: number } {
  return { errors: findings.filter((f) => f.level === "error").length, warns: findings.filter((f) => f.level === "warn").length };
}
