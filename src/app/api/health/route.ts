import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { workerStatus } from "@/lib/ops/heartbeat";

/**
 * 상태 확인(감시·헬스체크용). 인증 없이 접근 가능하며 내부 정보는 노출하지 않는다.
 * - db: DB 연결. 실패하면 503.
 * - worker: up | stale | unknown — 워커 하트비트 나이(기본 180초 초과면 stale). 워커가 죽으면 폴링·콜백 처리가 멈추므로 외부 감시는 이 값도 본다.
 */
export async function GET() {
  try {
    await getDb().execute(sql`select 1`);
    const w = await workerStatus();
    return Response.json({ ok: true, db: "up", worker: w.state, workerAgeSeconds: w.ageSeconds, time: new Date().toISOString() });
  } catch {
    return Response.json({ ok: false, db: "down" }, { status: 503 });
  }
}
