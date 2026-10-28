const { chromium } = require("playwright");
const fs = require("fs");
const out = require("path").join(__dirname, "..", "docs", "screenshots");
fs.mkdirSync(out, { recursive: true });
const base = "http://localhost:3000";

(async () => {
  const browser = await chromium.launch();
  const shot = async (name, path, user, width = 1280) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    if (user) await ctx.addCookies([{ name: "sample_user_id", value: user, url: base }]);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(base + path, { waitUntil: "networkidle" });
    await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
    console.log(name, errors.length ? "ERRORS: " + errors.join(" | ") : "ok");
    await ctx.close();
  };
  await shot("01-dashboard-hq", "/", "u-hq");
  await shot("02-site-hq", "/sites/site-01", "u-hq");
  await shot("03-robot-hq", "/robots/PW-R-005", "u-hq");
  await shot("04-tasks-hq", "/tasks", "u-hq");
  await shot("05-incidents-hq", "/incidents", "u-hq");
  await shot("06-reports-hq", "/reports", "u-hq");
  await shot("07-report-detail-hq", "/reports/rpt-site-01-2026-09-v1", "u-hq");
  await shot("08-admin-hq", "/admin", "u-hq");
  await shot("09-dashboard-customer-basic", "/", "u-cust-1");
  await shot("10-robot-customer-basic", "/robots/PW-R-001", "u-cust-1");
  await shot("11-robot-other-site-customer-basic", "/robots/PW-R-006", "u-cust-1");
  await shot("12-reports-customer-basic", "/reports", "u-cust-1");
  await shot("13-robot-customer-control", "/robots/PW-R-007", "u-cust-2");
  await shot("14-inactive-user", "/", "u-inactive");
  await shot("15-admin-site-manager", "/admin", "u-site-a");
  await shot("16-mobile-dashboard", "/", "u-hq", 390);
  await shot("17-mobile-robot", "/robots/PW-R-005", "u-hq", 390);
  await browser.close();
})();
