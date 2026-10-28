import { readFileSync, existsSync } from "node:fs";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
// 테스트는 항상 테스트 DB 를 사용한다.
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? "postgresql://postgres:postgres@127.0.0.1:5432/robot_control_test";
process.env.VENDOR_MODE = "sample";
process.env.ALLOW_SAMPLE_RESET = "true";
