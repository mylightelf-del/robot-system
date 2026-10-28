import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

/** 상태 확인(감시·헬스체크용). 인증 없이 접근 가능하며 내부 정보는 노출하지 않는다. */
export async function GET() {
  try {
    await getDb().execute(sql`select 1`);
    return Response.json({ ok: true, db: "up", time: new Date().toISOString() });
  } catch {
    return Response.json({ ok: false, db: "down" }, { status: 503 });
  }
}
