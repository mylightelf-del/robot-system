/**
 * 브라우저 자동 조작 검증(2단계). 로그인 → 명령(워커 시뮬레이션) → 장애 → 보고서 → 권한 → 초대 흐름.
 * 사전 조건: DB 에 샘플 적재(npm run db:seed), 웹(npm run dev)과 워커(npm run worker) 실행 중, Playwright 설치.
 * 사용: BASE_URL=http://localhost:3000 node scripts/e2e-flows.js
 */
const { chromium } = require("playwright");
const path = require("path");
const base = process.env.BASE_URL || "http://localhost:3000";
const out = path.join(__dirname, "..", "docs", "screenshots");
const PW = process.env.SAMPLE_USER_PASSWORD || "sample1234!";

async function loginAs(browser, email, password = PW) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto(`${base}/login`, { waitUntil: "networkidle" });
  await page.fill("input[name=email]", email);
  await page.fill("input[name=password]", password);
  await page.click("button[type=submit]");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
  await page.waitForLoadState("networkidle");
  return { ctx, page };
}

(async () => {
  const browser = await chromium.launch();
  const log = (...a) => console.log(...a);

  // 0) 미로그인 접근은 로그인으로 보내진다
  {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(`${base}/robots/PW-R-001`, { waitUntil: "networkidle" });
    log("0a unauthenticated redirected to login:", p.url().includes("/login"));
    await ctx.close();
  }

  // 1) 본사 로그인 + 샘플 초기화
  const { ctx, page } = await loginAs(browser, "hq-admin@example.invalid");
  log("1a login hq:", page.url() === `${base}/` || page.url().startsWith(`${base}/?`));
  await page.goto(`${base}/admin`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "샘플 데이터 초기화" }).click();
  await page.waitForSelector("text=/초기화했습니다/");
  log("1b sample reset ok");
  // 초기화로 세션이 사라졌으므로 다시 로그인
  await ctx.close();
  const s = await loginAs(browser, "hq-admin@example.invalid");
  const hq = s.page;

  // 2) 명령: 대기 로봇에 작업 실행 → 워커가 실행 확인(청소 중) 으로 전이
  await hq.goto(`${base}/robots/PW-R-003`, { waitUntil: "networkidle" });
  await hq.getByRole("button", { name: "작업 실행" }).click();
  await hq.waitForSelector("text=/ACCEPTED/");
  log("2a command accepted");
  await hq.waitForTimeout(7000);
  await hq.reload({ waitUntil: "networkidle" });
  log("2b worker advanced to 청소 중:", (await hq.locator("text=청소 중").count()) > 0);
  await hq.selectOption("select:near(:text('시뮬레이션 시나리오'))", "LOST_RESPONSE");
  await hq.getByRole("button", { name: "일시정지" }).click();
  await hq.waitForSelector("text=/UNKNOWN/");
  log("2c lost response -> UNKNOWN");
  await hq.screenshot({ path: `${out}/s2-01-robot-command.png`, fullPage: false });

  // 3) 장애 확인 → 복구
  await hq.goto(`${base}/incidents`, { waitUntil: "networkidle" });
  await hq.getByRole("button", { name: "확인", exact: true }).first().click();
  await hq.waitForTimeout(1500);
  await hq.reload({ waitUntil: "networkidle" });
  const first = hq.locator("li").filter({ hasText: "BRUSH_MOTOR" }).first();
  log("3a acked:", (await first.textContent()).includes("확인"));
  await first.locator("input[placeholder='조치 내용']").fill("브러시 교체 완료");
  await first.getByRole("button", { name: "복구" }).click();
  await hq.waitForTimeout(1500);
  await hq.goto(`${base}/incidents?all=1`, { waitUntil: "networkidle" });
  const resolved = hq.locator("li").filter({ hasText: "BRUSH_MOTOR" }).first();
  log("3b resolved + notification:", (await resolved.textContent()).includes("장애 복구"));

  // 4) 보고서: 초안 → 의견 → 검토 → 확정 → 공개
  await hq.goto(`${base}/reports`, { waitUntil: "networkidle" });
  await hq.locator("div.bg-slate-50 select").first().selectOption({ label: "가상 사업장 4 (병원)" });
  await hq.getByRole("button", { name: "초안 생성(자동 집계)" }).click();
  await hq.waitForSelector("text=/초안 v1 생성/");
  await hq.reload({ waitUntil: "networkidle" });
  await hq.locator("a", { hasText: "가상 사업장 4 (병원)" }).first().click();
  await hq.waitForLoadState("networkidle");
  await hq.locator("textarea").first().fill("병원 외래 야간 청소 정상 수행(자동 시험).");
  await hq.getByRole("button", { name: "의견 저장" }).click();
  await hq.waitForTimeout(1200);
  await hq.getByRole("button", { name: "검토 요청" }).click();
  await hq.waitForTimeout(1200);
  await hq.getByRole("button", { name: "확정", exact: true }).click();
  await hq.waitForTimeout(1200);
  log("4a confirmed:", (await hq.locator("text=확정본입니다").count()) > 0);
  await hq.getByRole("button", { name: "고객 공개" }).click();
  await hq.waitForTimeout(1200);
  const reportUrl = hq.url();
  log("4b published:", (await hq.locator("text=고객 공개").count()) > 0);
  await hq.screenshot({ path: `${out}/s2-02-report.png`, fullPage: false });

  // 5) 사용자 등록 → 초대 링크 → 비밀번호 설정 → 로그인
  await hq.goto(`${base}/admin`, { waitUntil: "networkidle" });
  await hq.locator("summary", { hasText: "사용자 추가" }).click();
  await hq.fill("input[placeholder='이름']", "자동시험 사용자");
  await hq.fill("input[placeholder='이메일']", "e2e-user@example.invalid");
  await hq.locator("details select").first().selectOption("CUSTOMER_BASIC");
  await hq.locator("details label", { hasText: "가상 사업장 4" }).locator("input").check();
  await hq.getByRole("button", { name: /사용자 등록/ }).click();
  await hq.waitForSelector("text=/초대 링크\\(72시간/");
  const inviteText = await hq.locator("text=/\\/invite\\//").first().textContent();
  const inviteLink = inviteText.match(/https?:\/\/\S+\/invite\/\S+/)[0].replace(/^https?:\/\/[^/]+/, base);
  log("5a invite link issued");
  await hq.screenshot({ path: `${out}/s2-03-admin-invite.png`, fullPage: false });
  const c2 = await browser.newContext();
  const p2 = await c2.newPage();
  await p2.goto(inviteLink, { waitUntil: "networkidle" });
  await p2.fill("input[name=password]", "E2ePassword123");
  await p2.fill("input[name=password2]", "E2ePassword123");
  await p2.click("button[type=submit]");
  await p2.waitForURL(/\/login\?set=1/);
  log("5b password set via invite");
  await p2.goto(inviteLink, { waitUntil: "networkidle" });
  log("5c invite link single-use:", (await p2.locator("text=/만료되었거나/").count()) > 0);
  await c2.close();
  const nu = await loginAs(browser, "e2e-user@example.invalid", "E2ePassword123");
  await nu.page.goto(reportUrl, { waitUntil: "networkidle" });
  log("5d new customer(site 4) can open published report:", (await nu.page.locator("text=확정본").count()) > 0);
  await nu.page.goto(`${base}/robots/PW-R-001`, { waitUntil: "networkidle" });
  log("5e new customer blocked from other site robot:", (await nu.page.locator("text=접근 차단").count()) > 0);
  await nu.ctx.close();

  // 6) 고객 제어: 허용 명령만 / 고객 기본: 제어 불가
  const cc = await loginAs(browser, "customer2@example.invalid");
  await cc.page.goto(`${base}/robots/PW-R-007`, { waitUntil: "networkidle" });
  log("6a customer-control 복귀 button count (expect 0):", await cc.page.getByRole("button", { name: "복귀" }).count());
  await cc.page.getByRole("button", { name: "재개" }).click();
  await cc.page.waitForSelector("text=/ACCEPTED/");
  log("6b customer-control resume accepted");
  await cc.ctx.close();
  const cb = await loginAs(browser, "customer1@example.invalid");
  await cb.page.goto(`${base}/robots/PW-R-001`, { waitUntil: "networkidle" });
  log("6c customer-basic no control:", (await cb.page.locator("text=제어 권한이 없습니다").count()) > 0);
  await cb.page.goto(`${base}/admin`, { waitUntil: "networkidle" });
  log("6d customer-basic admin blocked:", (await cb.page.locator("text=접근 차단").count()) > 0);
  await cb.ctx.close();

  // 7) 비활성 계정 로그인 거부 / 비활성화 시 세션 즉시 종료
  const inactive = await browser.newContext();
  const ip = await inactive.newPage();
  await ip.goto(`${base}/login`, { waitUntil: "networkidle" });
  await ip.fill("input[name=email]", "former@example.invalid");
  await ip.fill("input[name=password]", PW);
  await ip.click("button[type=submit]");
  await ip.waitForSelector("text=/올바르지 않습니다/");
  log("7a inactive login rejected");
  await inactive.close();
  const sa = await loginAs(browser, "site-a@example.invalid");
  await hq.goto(`${base}/admin`, { waitUntil: "networkidle" });
  const row = hq.locator("tr").filter({ hasText: "이현장" }).first();
  await row.getByRole("button", { name: "비활성화" }).click();
  await hq.waitForTimeout(1200);
  await sa.page.goto(`${base}/`, { waitUntil: "networkidle" });
  log("7b deactivated user's session ended -> login:", sa.page.url().includes("/login"));
  await sa.ctx.close();

  // 8) 로그아웃
  await hq.goto(`${base}/`, { waitUntil: "networkidle" });
  await hq.getByRole("button", { name: "로그아웃" }).click();
  await hq.waitForURL(/\/login/);
  log("8 logout ok");

  await browser.close();
})().catch((e) => {
  console.error("FLOW ERROR", e);
  process.exit(1);
});
