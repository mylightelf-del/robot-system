/**
 * Teams 앱 패키지(zip) 만들기 — Teams 관리 센터에 업로드할 파일(docs/24 §2).
 * 사용: npx tsx scripts/teams-app.ts <봇 앱 ID(GUID)> [출력 경로] [도메인]
 * 앱 ID 는 비밀값이 아니다(Azure Bot 의 Microsoft App ID). 비밀값은 넣지 않는다.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

const [appId, outArg, domainArg] = process.argv.slice(2);
if (!appId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appId)) {
  console.error("사용: npx tsx scripts/teams-app.ts <봇 앱 ID(GUID)> [출력 경로] [도메인]");
  process.exit(2);
}
const domain = domainArg ?? "widebot.kro.kr";
const out = path.resolve(outArg ?? "widebot-teams-app.zip");

const manifest = {
  $schema: "https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
  manifestVersion: "1.17",
  version: "1.0.0",
  id: appId,
  developer: { name: "Wide Bot", websiteUrl: `https://${domain}`, privacyUrl: `https://${domain}/privacy`, termsOfUseUrl: `https://${domain}/privacy` },
  name: { short: "Wide Bot", full: "Wide Bot 통합관제 알림" },
  description: {
    short: "로봇 배송 도착·장애 알림",
    full: "Wide Bot 통합관제의 배송로봇 도착·수령 재알림·취소·막힘, 청소로봇 장애 알림을 받는 사람 개인 채팅으로 바로 보냅니다. 알림 전용 앱입니다.",
  },
  icons: { color: "color.png", outline: "outline.png" },
  accentColor: "#2563EB",
  bots: [{ botId: appId, scopes: ["personal"], supportsFiles: false, isNotificationOnly: true }],
  validDomains: [domain],
};

async function main() {
  const dir = mkdtempSync(path.join(tmpdir(), "teams-app-"));
  try {
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    await sharp(path.resolve("public/icons/icon-512.png")).resize(192, 192).png().toFile(path.join(dir, "color.png"));
    // 외곽선 아이콘: 32x32, 흰색 + 투명 배경(Teams 규격)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect x="2" y="2" width="28" height="28" rx="7" fill="none" stroke="#fff" stroke-width="2.5"/><path d="M8 11 L11.5 22 L16 14 L20.5 22 L24 11" fill="none" stroke="#fff" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
    await sharp(Buffer.from(svg)).png().toFile(path.join(dir, "outline.png"));
    rmSync(out, { force: true });
    execFileSync("zip", ["-j", "-q", out, "manifest.json", "color.png", "outline.png"].map((f, i) => (i < 3 ? f : path.join(dir, f))), { cwd: dir });
    console.log(`만듦: ${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
main();
