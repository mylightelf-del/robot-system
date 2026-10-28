import http from "node:http";
import { verifySignature, contentMd5 } from "@/lib/vendors/pudu/signing";

/**
 * PUDU 개방 플랫폼 모의 서버(테스트 전용).
 * - 공식 문서의 서명 규칙으로 Authorization 을 검증한다(틀리면 401 + 문서의 오류 문구).
 * - 응답 본문은 문서의 예제·필드 구조를 따른다. 실제 서버의 동작을 대신하지 않는다(실기 검증은 별도).
 */
export const MOCK_KEY = "test-app-key";
export const MOCK_SECRET = "test-app-secret";
export const MOCK_SN = "8110A3802050003";

export interface MockState {
  taskCode: number; // cleanbot.task
  runState: "OFFLINE" | "DISABLE" | "BUSY" | "IDLE";
  battery: number;
  execCalls: { path: string; body: unknown }[];
  requests: { method: string; path: string }[];
  reports: Record<string, unknown>[];
  errors: Record<string, unknown>[];
  failNext?: { status: number; message: string } | null;
}

export function defaultState(): MockState {
  return {
    taskCode: 0,
    runState: "IDLE",
    battery: 77,
    execCalls: [],
    requests: [],
    reports: [
      { task_name: "1층 야간", report_id: "894770283318874112", mode: 2, start_time: 1761580800, end_time: 1761584400, clean_time: 3540, clean_area: 820.5, create_time: "2026-10-27 23:00:00", mac: "B4:ED:D5:75:6E:EB", sn: MOCK_SN, status: 4, sub_mode: 0, task_area: 900 },
      { task_name: "1층 야간", report_id: "894770283318874113", mode: 2, start_time: 1761494400, end_time: 1761496200, clean_time: 1700, clean_area: 300, create_time: "2026-10-26 23:00:00", mac: "B4:ED:D5:75:6E:EB", sn: MOCK_SN, status: 6, sub_mode: 0, task_area: 900 },
      { task_name: "진행중", report_id: "894770283318874114", mode: 2, start_time: 1761600000, end_time: 0, clean_time: 100, clean_area: 10, create_time: "2026-10-28 09:00:00", mac: "B4:ED:D5:75:6E:EB", sn: MOCK_SN, status: 1, sub_mode: 0, task_area: 900 },
    ],
    errors: [{ id: "e1", sn: MOCK_SN, mac: "B4:ED:D5:75:6E:EB", product_code: "CC1", upload_time: "2026-10-27 23:10:00", task_time: "2026-10-27 23:05:00", soft_version: "2.19.0", hard_version: "1", os_version: "1", error_level: "Error", error_type: "CleanSewageFull", error_detail: "sewage tank full", error_id: "err-0001" }],
    failNext: null,
  };
}

export function startMockPudu(state: MockState = defaultState()): Promise<{ url: string; close: () => Promise<void>; state: MockState }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const bodyStr = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname.replace(/^\/pudu-entry/, "");
      state.requests.push({ method: req.method ?? "", path });
      const send = (status: number, obj: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const auth = String(req.headers["authorization"] ?? "");
      const date = String(req.headers["x-date"] ?? "");
      const md5 = String(req.headers["content-md5"] ?? "");
      if (!auth.includes(`id="${MOCK_KEY}"`)) return send(401, { message: "HMAC apikey is invalid for API." });
      if (!date) return send(401, { message: "HMAC signature cannot be verified, a valid x-date header is required for HMAC Authentication." });
      if (req.method === "POST" && md5 !== contentMd5(bodyStr)) return send(401, { message: "HMAC signature does not match." });
      if (!verifySignature({ apiAppSecret: MOCK_SECRET, method: req.method ?? "GET", pathWithQuery: `${url.pathname}${url.search}`, date, md5, authorization: auth })) return send(401, { message: "HMAC signature does not match." });
      if (state.failNext) {
        const f = state.failNext;
        state.failNext = null;
        return send(f.status, { message: f.message, trace_id: `${MOCK_KEY}_fail` });
      }
      const trace = `${MOCK_KEY}_${Math.random().toString(36).slice(2, 10)}`;
      const ok = (data: unknown, message = "SUCCESS") => send(200, { trace_id: trace, message, data });
      switch (path) {
        case "/data-open-platform-service/v1/api/healthCheck":
          return ok({});
        case "/data-open-platform-service/v1/api/shop":
          return ok({ count: 1, list: [{ id: 324100000, name: "Shop-2023-10-08" }] });
        case "/data-open-platform-service/v1/api/robot":
          return ok({ count: 2, list: [{ mac: "B4:ED:D5:75:6E:EB", shop_id: 324100000, shop_name: "Shop-2023-10-08", sn: MOCK_SN, product_code: "CC1", nickname: "robot2" }, { mac: "20:50:E7:3E:61:78", shop_id: 324100000, shop_name: "Shop-2023-10-08", sn: "OP2023090702", product_code: "PuduBot", nickname: "robot1" }] });
        case "/open-platform-service/v2/status/get_by_sn":
          return ok({ sn: url.searchParams.get("sn"), mac: "B4:ED:D5:75:6E:EB", timestamp: Math.floor(Date.now() / 1000), battery: state.battery, is_charging: state.taskCode === 202 ? 1 : -1, run_state: state.runState, product_code: "CC1" });
        case "/cleanbot-service/v1/api/open/robot/detail":
          return ok({ sn: url.searchParams.get("sn"), mac: "B4:ED:D5:75:6E:EB", nickname: "robot2", battery: state.battery, map: { name: "1#1#lobby", lv: 1, floor: "1F" }, shop: { id: 324100000, name: "Shop" }, position: { x: 12.3, y: -4.5, z: 0 }, cleanbot: { rising: 60, sewage: 20, task: state.taskCode, detail: "", clean: state.taskCode >= 300 && state.taskCode <= 315 ? { mode: 2, report_id: "rpt-live-1", result: { status: 1, percentage: 42, area: 120, time: 600 }, task: { task_id: "897176785820073984", version: 1694070080109, name: "1층 야간" } } : undefined } });
        case "/cleanbot-service/v1/api/open/task/list":
          return ok({ count: 1, item: [{ task_id: "897176785820073984", version: 1694070080109, name: "1층 야간", config: { mode: 2 }, status: 1, pre_clean_time: 3600, mode: 2, product: "cleanbot" }] });
        case "/cleanbot-service/v1/api/open/cron/list":
          return ok({ count: 1, list: [{ cron_id: "111111111111", hour: 22, minute: 0, weeks: [1, 2, 3, 4, 5], task_list: [{ task_id: "897176785820073984", task_version: 1694070080109, name: "1층 야간", clean_mode: 2, mode: 2, product: "cleanbot" }], cron_status: "open", keep_time: 30 }] });
        case "/cleanbot-service/v1/api/open/component/list":
          return ok({ count: 1, list: [{ product: "cc1Pro", type: "WashBrush", cost_time: 13915, name: "Scrubbing brush", life_time: 1080000, create_time: 1788262064, update_time: 1788262064 }] });
        case "/cleanbot-service/v1/api/open/task/exec": {
          const body = JSON.parse(bodyStr || "{}");
          state.execCalls.push({ path, body });
          if (body.type === 3 && body.clean?.status === 1) state.taskCode = 302;
          if (body.type === 3 && body.clean?.status === 3) state.taskCode = 301;
          if (body.type === 3 && body.clean?.status === 4) state.taskCode = 303;
          if (body.type === 5) state.taskCode = 400;
          return ok({ task_id: "T123" });
        }
        case "/data-board/v1/log/clean_task/query_list": {
          const offset = Number(url.searchParams.get("offset") ?? 0);
          const limit = Number(url.searchParams.get("limit") ?? 10);
          return ok({ total: state.reports.length, offset, limit, list: state.reports.slice(offset, offset + limit) }, "ok");
        }
        case "/data-board/v1/log/clean_task/query": {
          const r = state.reports.find((x) => x.report_id === url.searchParams.get("report_id"));
          return r ? ok({ ...r, task_id: "897176785820073984", task_version: "1694070080109", cost_water: 2500, cost_battery: 30, break_count: 0, timed_report_id: r.report_id === "894770283318874112" ? "timed-1" : undefined }, "ok") : send(200, { message: "NOT_FOUND" });
        }
        case "/data-board/v1/log/error/query_list":
          return ok({ total: state.errors.length, offset: 0, limit: 20, list: state.errors }, "ok");
        default:
          return send(404, { message: "no route" });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}/pudu-entry`, close: () => new Promise((r) => server.close(() => r())), state });
    });
  });
}
