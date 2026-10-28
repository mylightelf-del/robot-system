/**
 * 역할별 화면 스크린샷(문서용). 로그인 후 각 화면을 캡처한다.
 * 사전 조건: 샘플 적재, 웹 실행, Playwright 설치. 사용: BASE_URL=http://localhost:3000 node scripts/screenshots.js
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const out = path.join(__dirname, "..", "docs", "screenshots");
fs.mkdirSync(out, { recursive: true });
const base = process.env.BASE_URL || "http://localhost:3000";
const PW = process.env.SAMPLE_USER_PASSWORD || "sample1234!";

(async () => {
  const browser = await chromium.launch();
  const sessions = new Map();
  const ctxFor = async (email, width) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    if (email) {
      await page.goto(`${base}/login`, { waitUntil: "networkidle" });
      await page.fill("input[name=email]", email);
      await page.fill("input[name=password]", PW);
      await page.click("button[type=submit]");
      await page.waitForURL((u) => !u.pathname.startsWith("/login"));
    }
    return { ctx, page };
  };
  const shot = async (name, pathname, email, width = 1280) => {
    const { ctx, page } = await ctxFor(email, width);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(base + pathname, { waitUntil: "networkidle" });
    await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
    console.log(name, errors.length ? "ERRORS: " + errors.join(" | ") : "ok");
    await ctx.close();
  };
  await shot("00-login", "/login", null);
  await shot("01-dashboard-hq", "/", "hq-admin@example.invalid");
  await shot("02-site-hq", "/sites/site-01", "hq-admin@example.invalid");
  await shot("03-robot-hq", "/robots/PW-R-005", "hq-admin@example.invalid");
  await shot("04-tasks-hq", "/tasks", "hq-admin@example.invalid");
  await shot("05-incidents-hq", "/incidents", "hq-admin@example.invalid");
  await shot("06-reports-hq", "/reports", "hq-admin@example.invalid");
  await shot("08-admin-hq", "/admin", "hq-admin@example.invalid");
  await shot("10-robot-customer-basic", "/robots/PW-R-001", "customer1@example.invalid");
  await shot("11-robot-other-site-customer-basic", "/robots/PW-R-006", "customer1@example.invalid");
  await shot("16-mobile-dashboard", "/", "hq-admin@example.invalid", 390);
  void sessions;
  await browser.close();
})();
