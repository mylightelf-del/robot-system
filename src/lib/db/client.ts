import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * DB 클라이언트 싱글턴. 연결 문자열은 환경변수 DATABASE_URL 에서만 읽는다.
 * 개발 서버의 모듈 재적재에도 풀이 중복 생성되지 않도록 globalThis 에 보관한다.
 */
const g = globalThis as unknown as { __robotPool?: Pool; __robotDb?: ReturnType<typeof makeDb> };

function makeDb(pool: Pool) {
  return drizzle({ client: pool, schema, casing: "snake_case" });
}

export function getDb() {
  if (!g.__robotDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL 환경변수가 없습니다. .env.example 을 참고해 .env.local 을 만드세요.");
    g.__robotPool = new Pool({ connectionString: url, max: Number(process.env.DATABASE_POOL_MAX ?? 10) });
    g.__robotDb = makeDb(g.__robotPool);
  }
  return g.__robotDb;
}

export type Db = ReturnType<typeof getDb>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function closeDb() {
  await g.__robotPool?.end();
  g.__robotPool = undefined;
  g.__robotDb = undefined;
}

export { schema };
