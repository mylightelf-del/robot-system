/**
 * 백그라운드 워커 프로세스.
 * - 샘플 모드: 시뮬레이션 틱(명령 상태 전이·하트비트)을 주기적으로 실행한다.
 * - 공통: 만료 세션 정리.
 * - 3단계 이후: 제조사 상태 주기 조회, Webhook 후속 처리, 예약 실행기, 알림 발송이 여기에 추가된다.
 * 실행: npm run worker  (DATABASE_URL 필요)
 */
import { closeDb } from "@/lib/db/client";
import { purgeExpiredSessions } from "@/lib/auth/session";
import { simulationTick } from "./simulation";

const tickSeconds = Number(process.env.SIMULATION_TICK_SECONDS ?? 2);
const vendorMode = process.env.VENDOR_MODE ?? "sample";
let stopping = false;

function log(msg: string) {
  console.log(`[worker ${new Date().toISOString()}] ${msg}`);
}

async function loop(name: string, intervalMs: number, fn: () => Promise<void>) {
  while (!stopping) {
    const started = Date.now();
    try {
      await fn();
    } catch (e) {
      console.error(`[worker] ${name} 오류:`, e);
    }
    const wait = Math.max(200, intervalMs - (Date.now() - started));
    await new Promise((r) => setTimeout(r, wait));
  }
}

async function main() {
  log(`시작 — VENDOR_MODE=${vendorMode}, tick=${tickSeconds}s`);
  const jobs: Promise<void>[] = [];
  if (vendorMode === "sample") {
    jobs.push(
      loop("simulation", tickSeconds * 1000, async () => {
        const r = await simulationTick();
        if (r.commands || r.runs) log(`시뮬레이션: 명령 ${r.commands} · 실적 ${r.runs} · 상태 ${r.statuses}`);
      }),
    );
  } else {
    log("live 모드: 제조사 주기 조회는 3단계에서 구현됩니다. 현재는 세션 정리만 수행합니다.");
  }
  jobs.push(
    loop("sessions", 60_000, async () => {
      const n = await purgeExpiredSessions();
      if (n) log(`만료 세션 ${n}건 정리`);
    }),
  );
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log("종료 중…");
    await new Promise((r) => setTimeout(r, 500));
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await Promise.all(jobs);
}

main().catch((e) => {
  console.error("[worker] 치명적 오류:", e);
  process.exit(1);
});
