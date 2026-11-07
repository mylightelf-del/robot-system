import { createHash } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { User } from "@/lib/domain/types";
import { assertActive, assertAdmin } from "@/lib/auth/authz";
import { randomToken } from "@/lib/auth/password";
import { getDb, schema } from "@/lib/db/client";
import { allSiteIds, type DbLike } from "@/lib/db/repo";
import { NotFoundError, ValidationError } from "@/lib/util/errors";
import { newId } from "@/lib/util/random";
import { nowIso } from "@/lib/util/time";
import { audit } from "./audit";

/**
 * 외부 연동용 읽기 전용 API 토큰(본사 관리자가 발급·폐기).
 * - 값은 발급 때 한 번만 보여 주고 서버에는 SHA-256 해시만 둔다.
 * - 사업장 범위(siteIds)가 비어 있으면 운영 중인 전체 사업장. 사용 중지된 사업장은 항상 제외.
 * - 호출은 Authorization: Bearer <토큰>. 분당 호출 수를 토큰별로 제한한다(메모리, 프로세스 단위).
 */
export const TOKEN_PREFIX = "wbt_";
export const RATE_LIMIT_PER_MINUTE = 120;

export interface ApiTokenMeta {
  id: string;
  name: string;
  siteIds: string[];
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  useCount: number;
  revokedAt: string | null;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function listApiTokens(user: User, db: DbLike = getDb()): Promise<ApiTokenMeta[]> {
  assertActive(user);
  assertAdmin(user);
  const rows = await db.select().from(schema.apiTokens).orderBy(desc(schema.apiTokens.createdAt));
  return rows.map(({ tokenHash: _h, ...r }) => r);
}

export async function createApiToken(user: User, input: { name: string; siteIds: string[] }): Promise<{ token: string; meta: ApiTokenMeta }> {
  const db = getDb();
  assertActive(user);
  assertAdmin(user);
  const name = input.name.trim();
  if (name.length < 2 || name.length > 60) throw new ValidationError("토큰 이름은 2~60자로 입력하세요(예: 고객사 시설관리 시스템).");
  const valid = new Set(await allSiteIds(db));
  const siteIds = Array.from(new Set(input.siteIds.filter((s) => valid.has(s))));
  const token = `${TOKEN_PREFIX}${randomToken(32)}`;
  const row = { id: newId("tok"), name, tokenHash: hash(token), siteIds, createdBy: user.id, createdAt: nowIso(), lastUsedAt: null, useCount: 0, revokedAt: null };
  await db.insert(schema.apiTokens).values(row);
  await audit(user, { siteId: null, robotId: null, action: "API_TOKEN:CREATE", params: { tokenId: row.id, name, siteIds }, result: "OK", detail: null, vendorTraceId: null }, db);
  const { tokenHash: _h, ...meta } = row;
  return { token, meta };
}

export async function revokeApiToken(user: User, tokenId: string, reason?: string): Promise<void> {
  const db = getDb();
  assertActive(user);
  assertAdmin(user);
  const t = await db.query.apiTokens.findFirst({ where: eq(schema.apiTokens.id, tokenId) });
  if (!t) throw new NotFoundError("토큰을 찾을 수 없습니다.");
  if (t.revokedAt) return;
  await db.update(schema.apiTokens).set({ revokedAt: nowIso() }).where(eq(schema.apiTokens.id, tokenId));
  await audit(user, { siteId: null, robotId: null, action: "API_TOKEN:REVOKE", params: { tokenId, name: t.name }, result: "OK", detail: reason?.trim() || null, vendorTraceId: null }, db);
}

const buckets = new Map<string, number[]>();
function rateLimited(tokenId: string, now = Date.now()): boolean {
  const arr = (buckets.get(tokenId) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= RATE_LIMIT_PER_MINUTE) {
    buckets.set(tokenId, arr);
    return true;
  }
  arr.push(now);
  buckets.set(tokenId, arr);
  return false;
}
/** 시험용. */
export function resetRateLimits(): void {
  buckets.clear();
}

export type TokenAuth = { ok: true; token: ApiTokenMeta; siteIds: string[] } | { ok: false; status: 401 | 429; error: string };

/** Bearer 토큰 검증 → 접근 가능한 사업장 ID(운영 중인 것만). 사용 횟수·시각을 갱신한다. */
export async function authenticateApiToken(req: Request, db: DbLike = getDb()): Promise<TokenAuth> {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (!m) return { ok: false, status: 401, error: "Authorization: Bearer <token> 헤더가 필요합니다." };
  const t = await db.query.apiTokens.findFirst({ where: and(eq(schema.apiTokens.tokenHash, hash(m[1])), isNull(schema.apiTokens.revokedAt)) });
  if (!t) return { ok: false, status: 401, error: "유효하지 않거나 폐기된 토큰입니다." };
  if (rateLimited(t.id)) return { ok: false, status: 429, error: `분당 ${RATE_LIMIT_PER_MINUTE}회를 넘었습니다.` };
  await db.update(schema.apiTokens).set({ lastUsedAt: nowIso(), useCount: t.useCount + 1 }).where(eq(schema.apiTokens.id, t.id));
  const active = await allSiteIds(db);
  const siteIds = t.siteIds.length ? active.filter((s) => t.siteIds.includes(s)) : active;
  const { tokenHash: _h, ...meta } = t;
  return { ok: true, token: meta, siteIds };
}
