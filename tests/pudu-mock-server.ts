import http from "node:http";
import { verifySignature, contentMd5 } from "@/lib/vendors/pudu/signing";

/**
 * PUDU 개방 플랫폼 모의 서버(테스트 전용).
 * - 공식 문서의 서명 규칙으로 Authorization 을 검증한다(틀리면 401 + 문서의 오류 문구).
 * - 응답 본문은 문서의 예제·필드 구조에 실기(2026-10)에서 확인한 차이를 반영했다: 매장 목록은 shop_id/shop_name(문자열),
 *   로봇 목록은 shop_id 로 걸러짐, 통계 API 는 sn 을 무시하고 shop_id 로만 걸러짐, task/list 는 product 필수(PARAM_ERROR),
 *   error_level 대문자, statusV2.timestamp 문자열, 상세에 online(boolean).
 */
export const MOCK_KEY = "test-app-key";
export const MOCK_SECRET = "test-app-secret";
export const MOCK_SN = "8110A3802050003";
export const MOCK_SHOP = "324100000"; // 허용 매장
export const OTHER_SHOP = "999900000"; // 다른 고객사 매장(허용 밖)
export const OTHER_SN = "811053715050099";

export interface MockState {
  taskCode: number; // cleanbot.task
  runState: "OFFLINE" | "DISABLE" | "BUSY" | "IDLE";
  battery: number;
  execCalls: { path: string; body: unknown }[];
  requests: { method: string; path: string }[];
  reports: Record<string, unknown>[];
  errors: Record<string, unknown>[];
  failNext?: { status: number; message: string; path?: string } | null; // path 를 주면 그 경로의 다음 호출만 실패
  cancelledAt?: number; // 취소(303) 시각 — 실기처럼 잠시 뒤 0(대기)으로 풀린다
  mapName?: string; // 상세 응답의 map.name (기본 1#1#lobby)
  imageBase?: string; // 모의 서버의 자기 주소(지도 이미지 URL 생성용)
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
      // 다른 고객사 로봇의 보고서(허용 밖 매장) — shop_id 필터로 걸러져야 한다
      { task_name: "타사 로비", report_id: "894770283318870001", mode: 2, start_time: 1761580800, end_time: 1761584400, clean_time: 3000, clean_area: 500, create_time: "2026-10-27 23:00:00", mac: "AA:AA", sn: OTHER_SN, status: 4, sub_mode: 0, task_area: 600, shop_id: OTHER_SHOP },
    ],
    errors: [
      { id: "e1", sn: MOCK_SN, mac: "B4:ED:D5:75:6E:EB", product_code: "CC1", upload_time: "2026-10-27 23:10:00", task_time: "2026-10-27 23:05:00", soft_version: "2.19.0", hard_version: "1", os_version: "1", error_level: "ERROR", error_type: "CleanSewageFull", error_detail: "sewage tank full", error_id: "err-0001" },
      // 같은 로봇·같은 코드가 25분 뒤 다시 발생 → 새 장애가 아니라 묶음(occurrences 2)
      { id: "e3", sn: MOCK_SN, mac: "B4:ED:D5:75:6E:EB", product_code: "CC1", upload_time: "2026-10-27 23:35:00", task_time: "2026-10-27 23:30:00", soft_version: "2.19.0", hard_version: "1", os_version: "1", error_level: "ERROR", error_type: "CleanSewageFull", error_detail: "sewage tank full again", error_id: "err-0002" },
      { id: "e2", sn: OTHER_SN, mac: "AA:AA", product_code: "CC1", upload_time: "2026-10-27 23:10:00", task_time: "2026-10-27 23:05:00", soft_version: "2.19.0", hard_version: "1", os_version: "1", error_level: "WARNING", error_type: "LostLocalization", error_detail: "OdomSlip", error_id: "err-other", shop_id: OTHER_SHOP },
    ],
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
      // 지도 이미지(서명 없이 공개 URL, 실기의 S3 와 같은 역할). 1×1 PNG.
      if (url.pathname === "/maps/lobby.png") {
        const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
        res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length });
        return res.end(png);
      }
      const auth = String(req.headers["authorization"] ?? "");
      const date = String(req.headers["x-date"] ?? "");
      const md5 = String(req.headers["content-md5"] ?? "");
      if (!auth.includes(`id="${MOCK_KEY}"`)) return send(401, { message: "HMAC apikey is invalid for API." });
      if (!date) return send(401, { message: "HMAC signature cannot be verified, a valid x-date header is required for HMAC Authentication." });
      if (req.method === "POST" && md5 !== contentMd5(bodyStr)) return send(401, { message: "HMAC signature does not match." });
      if (!verifySignature({ apiAppSecret: MOCK_SECRET, method: req.method ?? "GET", pathWithQuery: `${url.pathname}${url.search}`, date, md5, authorization: auth })) return send(401, { message: "HMAC signature does not match." });
      if (state.failNext && (!state.failNext.path || state.failNext.path === path)) {
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
          return send(200, { trace_id: trace, message: "success", data: { count: 3, list: [{ company_id: "100000203", company_name: "대리점", shop_id: MOCK_SHOP, shop_name: "2604_포스코와이드(테스트)" }, { company_id: "100000203", company_name: "대리점", shop_id: OTHER_SHOP, shop_name: "타사 매장" }, { company_id: "100000203", company_name: "대리점", shop_id: "111", shop_name: "또 다른 타사" }] } });
        case "/data-open-platform-service/v1/api/robot": {
          const all = [
            { mac: "B4:ED:D5:75:6E:EB", shop_id: MOCK_SHOP, shop_name: "2604_포스코와이드(테스트)", sn: MOCK_SN, product_code: "CC1", nickname: "robot2", first_active_time: 1757654644 },
            { mac: "20:50:E7:3E:61:78", shop_id: MOCK_SHOP, shop_name: "2604_포스코와이드(테스트)", sn: "OP2023090702", product_code: "PuduBot", nickname: "robot1", first_active_time: 1757654644 },
            { mac: "AA:AA", shop_id: OTHER_SHOP, shop_name: "타사 매장", sn: OTHER_SN, product_code: "CC1", nickname: "타사 클리버", first_active_time: 1757654644 },
          ];
          const shop = url.searchParams.get("shop_id");
          const list = shop ? all.filter((r) => r.shop_id === shop) : all;
          return send(200, { trace_id: trace, message: "success", data: { count: list.length, list } });
        }
        case "/open-platform-service/v2/status/get_by_sn":
          return ok({ sn: url.searchParams.get("sn"), mac: "B4:ED:D5:75:6E:EB", timestamp: String(Math.floor(Date.now() / 1000)), battery: state.battery, is_charging: state.taskCode === 202 ? 1 : -1, run_state: state.runState, product_code: "CC1", charge_stage: "", charge_type: 2, move_state: "", remain_time: 0 });
        case "/cleanbot-service/v1/api/open/robot/detail":
          if (state.taskCode === 303 && state.cancelledAt && Date.now() - state.cancelledAt > 1500) state.taskCode = 0; // 실기: 취소 처리 후 대기로
          return ok({ sn: url.searchParams.get("sn"), mac: "B4:ED:D5:75:6E:EB", nickname: "robot2", online: state.runState !== "OFFLINE", battery: state.battery, map: { name: state.mapName ?? "1#1#lobby", lv: 1, floor: "" }, shop: { id: Number(MOCK_SHOP), name: "Shop" }, position: { x: 12.3, y: -4.5, z: 0 }, last_task_start: 1761580800000, last_task_end: 1761584400000, cleanbot: { rising: 60, sewage: 20, task: state.taskCode, detail: "", last_mode: 2, last_task: "897176785820073984", clean: state.taskCode >= 300 && state.taskCode <= 315 ? { mode: 2, report_id: "rpt-live-1", result: { status: 1, percentage: 42, area: 120, time: 600 }, task: { task_id: "897176785820073984", version: 1694070080109, name: "1층 야간" } } : null } });
        case "/map-service/v1/open/list":
          return ok({ shop_id: Number(MOCK_SHOP), list: [{ name: "1#1#lobby", floor: "1", is_used: 1 }, { name: "-1#0#basement", floor: "-1", is_used: 2 }] });
        case "/map-service/v1/open/map": {
          const mn = url.searchParams.get("map_name");
          // 이미지 URL 이 죽어 있는 지도(이미지 보관 실패 → 원격 URL 유지 시험)
          if (mn === "-1#0#basement") return ok({ map_name: mn, map_code: "b", url: "http://127.0.0.1:9/maps/none.png", width: 400, height: 300, resolution: 0.05, origin: [0, 0, 0], element_list: [], zone_list: [] });
          if (mn !== "1#1#lobby") return send(200, { message: "MAP_NOT_FOUND", trace_id: trace });
          // 실기 구조: 이미지 URL·px 크기·해상도(m/px)·원점(좌하단 월드 좌표 m)·요소(area 는 [x1,y1,x2,y2,…] m)
          return ok({ map_name: "1#1#lobby", map_code: "abc", url: `${state.imageBase ?? "http://127.0.0.1:9"}/maps/lobby.png`, width: 1000, height: 800, resolution: 0.05, origin: [-10, -20, 0], element_list: [
            { id: "a1", name: "로비 중앙", type: "area", mode: "", vector_list: [0, 0, 10, 0, 10, 5, 0, 5] },
            { id: "a2", name: "", type: "area", mode: "", vector_list: [20, 0, 30, 0, 30, 10] },
            { id: "s1", name: "워크스테이션1", type: "chargeWorkStation", mode: "", vector_list: [-0.4, 0, 0] },
            { id: "f1", name: "", type: "forbidden", mode: "", vector_list: [1, 1, 2, 1, 2, 2] },
          ], zone_list: [] });
        }
        case "/cleanbot-service/v1/api/open/task/list": {
          const product = url.searchParams.get("product");
          if (!product) return send(200, { trace_id: trace, message: "PARAM_ERROR" });
          state.requests.push({ method: "GET", path: `${path}?product=${product}` });
          if (!/^(cc1|cleanbot)$/i.test(product)) return ok({ count: 0, item: [] });
          return ok({ count: 1, item: [{ task_id: "897176785820073984", version: 1694070080109, name: "1층 야간", config: { mode: 2 }, status: 1, pre_clean_time: 3600, mode: 2, product: "cleanbot" }] });
        }
        case "/cleanbot-service/v1/api/open/cron/list":
          // 두 번째 예약의 작업은 task/list 에 없다(실기: task/list 가 비어 있는 로봇) → 예약 항목으로 등록 작업이 만들어져야 한다
          return ok({ count: 2, list: [{ cron_id: "111111111111", hour: 22, minute: 0, weeks: [1, 2, 3, 4, 5], task_list: [{ task_id: "897176785820073984", task_version: 1694070080109, name: "1층 야간", clean_mode: 2, mode: 2, product: "cleanbot" }], cron_status: "open", keep_time: 30 }, { cron_id: "222222222222", hour: 8, minute: 10, weeks: [1, 2, 3, 4, 5, 6, 7], task_list: [{ task_id: "1276527192427741184", task_version: 1790831844170, name: "우천시 회전문", clean_mode: 1, mode: 2, product: "cleanbot" }], cron_status: "close", keep_time: 0 }] });
        case "/cleanbot-service/v1/api/open/component/list":
          return ok({ count: 1, list: [{ product: "cleanbot", type: "WashBrush", cost_time: 13915, name: "스크러빙 브러시", life_time: 1080000, create_time: 1788262064, update_time: 1788262064 }] });
        case "/cleanbot-service/v1/api/open/task/exec": {
          const body = JSON.parse(bodyStr || "{}");
          state.execCalls.push({ path, body });
          // 실기: 모든 명령에 clean.task_id 가 필요. 취소 직후(303) 복귀는 거부.
          if (!body.clean?.task_id) return send(500, { message: "CLEANBOT_TASK_IS_EMPTY", trace_id: `${MOCK_KEY}_e` });
          if (body.type === 5 && state.taskCode === 303) return send(500, { message: "CLEANBOT_CLEANING_CANCELED", trace_id: `${MOCK_KEY}_e` });
          if (body.type === 3 && body.clean?.status === 1) state.taskCode = 302;
          if (body.type === 3 && body.clean?.status === 3) state.taskCode = 301;
          if (body.type === 3 && body.clean?.status === 4) { state.taskCode = 303; state.cancelledAt = Date.now(); }
          if (body.type === 5) state.taskCode = 102;
          return ok({ task_id: String(body.clean.task_id) });
        }
        case "/data-board/v1/log/clean_task/query_list": {
          // 실기: sn 은 무시되고 shop_id 로만 걸러진다. shop_id 없는 보고서는 허용 매장 것으로 본다.
          const offset = Number(url.searchParams.get("offset") ?? 0);
          const limit = Number(url.searchParams.get("limit") ?? 10);
          const shop = url.searchParams.get("shop_id");
          const rows = shop ? state.reports.filter((r) => String(r.shop_id ?? MOCK_SHOP) === shop) : state.reports;
          return ok({ total: rows.length, offset, limit, list: rows.slice(offset, offset + limit) }, "SUCCESS");
        }
        case "/data-board/v1/log/clean_task/query": {
          const r = state.reports.find((x) => x.report_id === url.searchParams.get("report_id"));
          return r ? ok({ ...r, task_id: "897176785820073984", task_version: "1694070080109", cost_water: 2500, cost_battery: 30, break_count: 0, timed_report_id: r.report_id === "894770283318874112" ? "timed-1" : undefined }, "ok") : send(200, { message: "NOT_FOUND" });
        }
        case "/data-board/v1/log/error/query_list": {
          const shop = url.searchParams.get("shop_id");
          const rows = shop ? state.errors.filter((r) => String(r.shop_id ?? MOCK_SHOP) === shop) : state.errors;
          return ok({ total: rows.length, offset: 0, limit: 20, list: rows }, "SUCCESS");
        }
        default:
          return send(404, { message: "no route" });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      state.imageBase = `http://127.0.0.1:${addr.port}`;
      resolve({ url: `http://127.0.0.1:${addr.port}/pudu-entry`, close: () => new Promise((r) => server.close(() => r())), state });
    });
  });
}
