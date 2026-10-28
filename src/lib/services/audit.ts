import type { AuditLog, User } from "@/lib/domain/types";
import { getDb, schema } from "@/lib/db/client";
import type { DbLike } from "@/lib/db/repo";
import { newId } from "@/lib/util/random";
import { nowIso } from "@/lib/util/time";

/** 감사 기록: 사용자, 사업장, 로봇, 행위, 파라미터, 시각, 결과, 제조사 추적 ID. DB 에 영속 저장. */
export async function audit(
  user: Pick<User, "id" | "name">,
  entry: Omit<AuditLog, "id" | "at" | "userId" | "userName"> & { at?: string },
  db: DbLike = getDb(),
): Promise<AuditLog> {
  const log: AuditLog = {
    id: newId("aud"),
    at: entry.at ?? nowIso(),
    userId: user.id,
    userName: user.name,
    siteId: entry.siteId,
    robotId: entry.robotId,
    action: entry.action,
    params: entry.params,
    result: entry.result,
    detail: entry.detail,
    vendorTraceId: entry.vendorTraceId,
  };
  await db.insert(schema.auditLogs).values(log);
  return log;
}
