import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { readFileSync, existsSync } from "node:fs";

/** 테스트 DB 에 마이그레이션을 적용한다(한 번). */
export default async function globalSetup() {
  if (existsSync(".env.local")) {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
  const url = process.env.DATABASE_URL_TEST ?? "postgresql://postgres:postgres@127.0.0.1:5432/robot_control_test";
  const pool = new Pool({ connectionString: url });
  await migrate(drizzle({ client: pool, casing: "snake_case" }), { migrationsFolder: "./drizzle" });
  await pool.end();
}
