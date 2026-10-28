import { defineConfig } from "drizzle-kit";

/** drizzle-kit 설정. 마이그레이션 SQL 은 ./drizzle 에 생성되어 git 으로 이력을 관리한다. */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  casing: "snake_case",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/robot_control" },
});
