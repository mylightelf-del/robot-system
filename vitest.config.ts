import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * 테스트는 실제 PostgreSQL(DATABASE_URL_TEST)에 대해 실행한다.
 * 파일마다 DB 를 초기화하므로 파일 병렬 실행을 끈다.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    globalSetup: ["tests/globalSetup.ts"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
