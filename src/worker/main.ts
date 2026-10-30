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
import { processPuduEvents, puduLiveEnabled, PUDU_WINDOW_HOURS, syncPuduCatalog, syncPuduErrors, syncPuduPlannedRuns, syncPuduReports, syncPuduStatus } from "./pudu";
import { createPuduApi } from "@/lib/vendors/pudu/puduAdapter";
import { vendorModes } from "@/lib/vendors";
import { purgeOldVendorEvents, writeHeartbeat } from "@/lib/ops/heartbeat";
import { autoCreateScheduledDrafts } from "@/lib/services/reports";

const tickSeconds = Number(process.env.SIMULATION_TICK_SECONDS ?? 2);
const vendorMode = process.env.VENDOR_MODE || "sample";
// 샘플 모드인 제조사가 하나라도 있으면(또는 샘플 적재 로봇이 남아 있을 수 있으므로) 시뮬레이션 틱을 돈다. 실제 연동 로봇은 틱에서 제외된다.
const anySample = Object.values(vendorModes()).some((m) => m === "sample");
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
  log(`시작 — VENDOR_MODE=${vendorMode}, 제조사별 ${JSON.stringify(vendorModes())}, tick=${tickSeconds}s`);
  const jobs: Promise<void>[] = [];
  if (anySample) {
    jobs.push(
      loop("simulation", tickSeconds * 1000, async () => {
        const r = await simulationTick();
        if (r.commands || r.runs) log(`시뮬레이션: 명령 ${r.commands} · 실적 ${r.runs} · 상태 ${r.statuses}`);
      }),
    );
  }
  if (puduLiveEnabled()) {
    const api = createPuduApi();
    const statusSec = Number(process.env.PUDU_POLL_STATUS_SECONDS ?? 60);
    const reportsMin = Number(process.env.PUDU_POLL_REPORTS_MINUTES ?? 10);
    const catalogMin = Number(process.env.PUDU_POLL_CATALOG_MINUTES ?? 60);
    log(`PUDU live: 상태 ${statusSec}s · 보고서/장애 ${reportsMin}m · 작업/예약/소모품 ${catalogMin}m · 콜백 처리 5s`);
    const report = (r: { job: string; ok: boolean; detail: string }) => log(`PUDU ${r.job}: ${r.ok ? "OK" : "실패"} — ${r.detail}`);
    jobs.push(loop("pudu-status", statusSec * 1000, async () => report(await syncPuduStatus())));
    jobs.push(
      loop("pudu-reports", reportsMin * 60_000, async () => {
        report(await syncPuduReports(api, PUDU_WINDOW_HOURS));
        report(await syncPuduErrors(api, PUDU_WINDOW_HOURS));
        // 예약 → 계획 회차(오늘·내일) 생성과 지난 회차의 수행/미실행 판정. 보고서 동기화 뒤에 돈다.
        report(await syncPuduPlannedRuns());
      }),
    );
    jobs.push(loop("pudu-catalog", catalogMin * 60_000, async () => report(await syncPuduCatalog(api))));
    jobs.push(
      loop("pudu-events", 5000, async () => {
        const r = await processPuduEvents();
        if (r.counts?.events) report(r);
      }),
    );
  } else if (vendorMode !== "sample") {
    log("live 모드이지만 PUDU 키가 설정되지 않았습니다(PUDU_API_APP_KEY/SECRET/CLUSTER). CenoBots 는 3단계에서 구현됩니다.");
  }
  jobs.push(
    loop("sessions", 60_000, async () => {
      const n = await purgeExpiredSessions();
      if (n) log(`만료 세션 ${n}건 정리`);
    }),
  );
  // 보고서 초안은 담당자가 일정표의 버튼으로 만든다(사용자 결정 2026-10-30). REPORT_AUTO_DRAFT=true 일 때만 자동 작성.
  if (process.env.REPORT_AUTO_DRAFT === "true") {
    jobs.push(
      loop("report-schedule", 10 * 60_000, async () => {
        const r = await autoCreateScheduledDrafts();
        if (r.created.length) log(`보고서 초안 자동 작성 ${r.created.length}건: ${r.created.join(", ")}`);
      }),
    );
  }
  // 생존 신호(30초): /api/health 가 이 값의 나이로 워커 생사를 알린다
  jobs.push(loop("heartbeat", 30_000, async () => writeHeartbeat({ modes: vendorModes(), pid: process.pid })));
  // 보관 정책(하루 1회): 처리 끝난 콜백 원문 정리
  jobs.push(
    loop("retention", 24 * 3600_000, async () => {
      const n = await purgeOldVendorEvents();
      if (n) log(`보관 기간 지난 콜백 원문 ${n}건 삭제`);
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
