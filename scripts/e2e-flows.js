const { chromium } = require("playwright");
const base = "http://localhost:3000";
const out = require("path").join(__dirname, "..", "docs", "screenshots");

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies([{ name: "sample_user_id", value: "u-hq", url: base }]);
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  const log = (...a) => console.log(...a);

  // 0) 샘플 데이터 초기화
  await page.goto(`${base}/admin`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "샘플 데이터 초기화" }).click();
  await page.waitForSelector("text=/초기화했습니다/");
  log("0 reset ok");

  // 1) 명령: 대기 로봇에 작업 실행 → 접수 → 실행 확인(청소 중)
  await page.goto(`${base}/robots/PW-R-003`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "작업 실행" }).click();
  await page.waitForSelector("text=/ACCEPTED/");
  log("1a command accepted:", (await page.locator("text=/ACCEPTED/").first().textContent()).slice(0, 80));
  await page.waitForTimeout(4000);
  await page.reload({ waitUntil: "networkidle" });
  const status = await page.locator("h1 ~ * , header").first();
  const cleaning = await page.locator("text=청소 중").count();
  log("1b after 4s robot shows 청소 중:", cleaning > 0);
  await page.screenshot({ path: `${out}/flow-01-command.png`, fullPage: false });

  // 1c) 응답 유실 시나리오
  await page.goto(`${base}/robots/PW-R-001`, { waitUntil: "networkidle" });
  await page.selectOption("select:near(:text('시뮬레이션 시나리오'))", "LOST_RESPONSE");
  await page.getByRole("button", { name: "일시정지" }).click();
  await page.waitForSelector("text=/UNKNOWN/");
  log("1c lost response -> UNKNOWN:", (await page.locator("text=/UNKNOWN/").first().textContent()).slice(0, 90));

  // 1d) 영역 명령 차단(지도 버전 불일치 로봇)
  await page.goto(`${base}/robots/PW-R-012`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /영역 청소/ }).click();
  log("1d area blocked msg:", await page.locator("text=/지도 버전이 현재 지도와 달라/").count() > 0);

  // 1e) 영역 명령 정상 + 범위 밖 테스트 (PW-R-020 BG1 은 미지원 → L4 중 IDLE 인 로봇 없음 → PW-R-019 가 청소 중이므로 중단 후 지정)
  await page.goto(`${base}/robots/PW-R-019`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "중단" }).click();
  await page.waitForSelector("text=/ACCEPTED/");
  await page.waitForTimeout(10000); // 중단 명령이 완료(6초)될 때까지 대기 — 처리 중에는 충돌 방지로 거부됨
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: /영역 청소/ }).click();
  await page.locator("svg").nth(1).locator("polygon").first().click({ force: true });
  await page.getByRole("button", { name: "범위 밖 다각형 테스트" }).click();
  await page.waitForTimeout(2500);
  await page.waitForSelector("text=/범위를 벗어났/");
  log("1e out-of-range blocked:", true);
  await page.getByRole("button", { name: "구버전 지도 테스트" }).click();
  await page.waitForSelector("text=/지도 버전/");
  log("1e old map version blocked:", true);
  log("1e selection:", await page.locator("text=/선택 구역/").first().textContent());
  await page.getByRole("button", { name: "영역 청소 전송" }).click();
  await page.waitForTimeout(2500);
  log("1e send result:", (await page.locator(".text-red-700, .text-emerald-700").allTextContents()).slice(0, 3));
  await page.waitForSelector("text=/ACCEPTED/");
  log("1e valid area accepted:", true);
  await page.screenshot({ path: `${out}/flow-02-area.png`, fullPage: true });

  // 2) 장애: 확인 → 조치 → 복구
  await page.goto(`${base}/incidents`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "확인", exact: true }).first().click();
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: "networkidle" });
  const first = page.locator("li").filter({ hasText: "BRUSH_MOTOR" }).first();
  log("2a acked:", (await first.textContent()).includes("확인"));
  await first.locator("input[placeholder='조치 내용']").fill("브러시 교체 완료");
  await first.getByRole("button", { name: "복구" }).click();
  await page.waitForTimeout(1500);
  await page.goto(`${base}/incidents?all=1`, { waitUntil: "networkidle" });
  const resolved = page.locator("li").filter({ hasText: "BRUSH_MOTOR" }).first();
  log("2b resolved + resolve notification:", (await resolved.textContent()).includes("복구") && (await resolved.textContent()).includes("장애 복구"));

  // 2c) 장애 시뮬레이션 중복 이벤트
  await page.goto(`${base}/incidents`, { waitUntil: "networkidle" });
  await page.fill("input[placeholder*='이벤트 ID']", "evt-dup-1");
  await page.getByRole("button", { name: "장애 발생 시뮬레이션" }).click();
  await page.waitForSelector("text=/시뮬레이션했습니다/");
  await page.fill("input[placeholder*='이벤트 ID']", "evt-dup-1");
  await page.getByRole("button", { name: "장애 발생 시뮬레이션" }).click();
  await page.waitForSelector("text=/중복 이벤트/");
  log("2c duplicate event ignored:", true);

  // 3) 보고서: 초안 생성 → 의견 → 검토 요청 → 확정 → 공개
  await page.goto(`${base}/reports`, { waitUntil: "networkidle" });
  await page.locator("div.bg-slate-50 select").first().selectOption({ label: "가상 사업장 4 (병원)" });
  await page.getByRole("button", { name: "초안 생성(자동 집계)" }).click();
  await page.waitForSelector("text=/초안 v1 생성/");
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("a", { hasText: "가상 사업장 4 (병원)" }).first().click();
  await page.waitForLoadState("networkidle");
  await page.locator("textarea").first().fill("병원 외래 야간 청소 정상 수행(자동 시험).");
  await page.getByRole("button", { name: "의견 저장" }).click();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "검토 요청" }).click();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "확정", exact: true }).click();
  await page.waitForTimeout(1200);
  log("3a confirmed:", await page.locator("text=확정본입니다").count() > 0);
  await page.getByRole("button", { name: "고객 공개" }).click();
  await page.waitForTimeout(1200);
  log("3b published:", await page.locator("text=고객 공개").count() > 0);
  const url = page.url();
  await page.screenshot({ path: `${out}/flow-03-report.png`, fullPage: false });

  // 3c) 고객(사업장 4 권한 없음)은 접근 불가 / 사업장 4 고객 계정은 없으므로 u-site-b 로 조회 가능 확인
  const c2 = await browser.newContext();
  await c2.addCookies([{ name: "sample_user_id", value: "u-cust-1", url: base }]);
  const p2 = await c2.newPage();
  await p2.goto(url, { waitUntil: "networkidle" });
  log("3c other-site customer blocked:", await p2.locator("text=접근 차단").count() > 0);
  await c2.close();

  // 4) 고객 제어: 허용 명령만
  const c3 = await browser.newContext();
  await c3.addCookies([{ name: "sample_user_id", value: "u-cust-2", url: base }]);
  const p3 = await c3.newPage();
  await p3.goto(`${base}/robots/PW-R-007`, { waitUntil: "networkidle" });
  log("4a customer-control sees 복귀 button:", await p3.getByRole("button", { name: "복귀" }).count());
  await p3.getByRole("button", { name: "재개" }).click();
  await p3.waitForSelector("text=/ACCEPTED/");
  log("4b customer-control resume accepted:", true);
  await c3.close();

  // 5) 관리: 사용자 비활성화 후 차단
  await page.goto(`${base}/admin`, { waitUntil: "networkidle" });
  const row = page.locator("tr").filter({ hasText: "최고객" }).first();
  await row.getByRole("button", { name: "비활성화" }).click();
  await page.waitForTimeout(1200);
  const c4 = await browser.newContext();
  await c4.addCookies([{ name: "sample_user_id", value: "u-cust-1", url: base }]);
  const p4 = await c4.newPage();
  await p4.goto(`${base}/`, { waitUntil: "networkidle" });
  log("5 deactivated user blocked:", await p4.locator("text=접근 차단").count() > 0);
  await c4.close();

  await browser.close();
})().catch((e) => {
  console.error("FLOW ERROR", e);
  process.exit(1);
});
