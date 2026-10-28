import { PuduClient } from "./client";

/**
 * PUDU Cloud API 래퍼 — 공식 문서(docs/06-PUDU-API-검토.md)에서 확인한 경로·필드만 사용한다.
 * 응답 타입은 문서의 필드명을 그대로 쓰며, 문서에 없는 필드는 정의하지 않는다.
 */

// ---- 공통/기초 ----
/** 실기 응답(2026-10): 문서의 id/name 이 아니라 shop_id/shop_name(문자열) + company_id/company_name 이 온다. */
export interface PuduShop {
  shop_id: string;
  shop_name: string;
  company_id?: string;
  company_name?: string;
  [k: string]: unknown;
}
export interface PuduRobot {
  sn: string;
  mac: string;
  shop_id: string | number; // 실기: 목록 API 는 문자열("602550006"), 미배정 로봇은 "0"
  shop_name: string;
  product_code: string;
  nickname?: string;
  first_active_time?: number;
}

// ---- 상태 ----
export type PuduRunState = "OFFLINE" | "DISABLE" | "BUSY" | "IDLE";
export interface PuduStatusV2 {
  sn: string;
  mac: string;
  timestamp: number | string; // 초. 실기에서는 문자열("1793208176")로 온다
  battery: number;
  is_charging: number; // 1 | -1
  move_state?: string;
  charge_stage?: string;
  remain_time?: number;
  product_code?: string;
  run_state: PuduRunState;
  charge_type?: number;
}

export interface PuduCleanDetail {
  sn: string;
  mac: string;
  nickname?: string;
  battery: number;
  map?: { name: string; lv: number; floor: string };
  shop?: { id: number; name: string };
  position?: { x: number; y: number; z: number };
  last_task_start?: number; // ms
  last_task_end?: number; // ms
  online?: boolean; // 실기 응답에 있음(문서 미기재)
  cleanbot?: {
    rising?: number; // 청수 잔량
    sewage?: number; // 오수 잔량
    task?: number; // 상태 코드 (Error Codes - Cleaning Robot Status Codes)
    last_mode?: number;
    detail?: string;
    last_task?: string;
    clean?: {
      mode?: number;
      report_id?: string;
      msg?: string;
      result?: { time?: number; area?: number; status?: number; percentage?: number; remaining_time?: number; task_area?: number; cost_water?: number; cost_battery?: number; charge_count?: number };
      task?: { task_id?: string | number; version?: number; name?: string };
      map?: { name: string; lv: number; floor: string };
      config?: Record<string, unknown>;
    };
  };
}

// ---- 작업·예약·소모품 ----
export interface PuduCleanTask {
  task_id: string;
  version: number;
  name: string;
  desc?: string;
  config?: { mode?: number; [k: string]: unknown };
  floor_list?: unknown[];
  status?: number; // 1 normal, -1 deleted
  pre_clean_time?: number; // 초
  mode?: number; // 1 manual, 2 auto, 3 inspection, 4 mix
  product?: string;
}
export interface PuduCron {
  cron_id: string;
  hour: number;
  minute: number;
  weeks: number[]; // 1=월 … 7=일
  task_list: { task_id: string; task_version: number; name: string; clean_mode?: number; mode?: number; product?: string }[];
  create_time?: number;
  update_time?: number;
  cron_status: "open" | "close";
  keep_time?: number;
  repeat_clean_time?: number;
}
export interface PuduComponent {
  product: string;
  type: string;
  cost_time: number;
  name: string;
  life_time: number;
  create_time?: number;
  update_time?: number;
}

// ---- 보고서·로그 ----
export interface PuduCleanReportSummary {
  task_name: string;
  report_id: string;
  mode: number; // 1 scrubbing, 2 sweeping
  start_time: number; // 초
  end_time: number;
  clean_time: number; // 초
  clean_area: number; // ㎡
  create_time: string;
  mac: string;
  sn: string;
  status: number; // 0~6
  sub_mode?: number;
  task_area?: number;
}
export interface PuduCleanReportDetail extends PuduCleanReportSummary {
  task_id?: string;
  task_version?: string;
  battery?: number;
  elevator_count?: number;
  config?: string;
  floor_list?: string;
  floor_count?: number;
  break_count?: number;
  average_area?: number;
  percentage?: number;
  remaining_time?: number;
  cost_water?: number; // ml
  cost_battery?: number; // %
  charge_count?: number;
  power_consumption?: number;
  timed_report_id?: string;
}
export interface PuduErrorLog {
  id: string;
  sn: string;
  mac: string;
  product_code: string;
  upload_time: string;
  task_time: string;
  soft_version?: string;
  hard_version?: string;
  os_version?: string;
  error_level: "Fatal" | "Error" | "Warning" | "Event" | "FATAL" | "ERROR" | "WARNING" | "EVENT" | string; // 실기: 대문자
  error_type: string;
  error_detail: string;
  error_id: string;
}

export interface Paged<T> {
  total?: number;
  count?: number;
  offset?: number;
  limit?: number;
  list?: T[];
  item?: T[];
}

/** 명령 본문(CleanCommands). type: 1 충전, 3 청소, 4 보급, 5 원클릭 복귀, 6 복귀점, 9 지도 전환, 10 예약 on/off */
export interface PuduExecBody {
  sn: string;
  type: 1 | 3 | 4 | 5 | 6 | 9 | 10;
  clean: {
    status: 1 | 3 | 4; // 1 시작, 3 일시정지, 4 취소(먼저 일시정지)
    task_id?: string;
    version?: number;
    name?: string;
    cleanagent_scale?: number;
    point_id?: string;
    map_name?: string;
    cron_id?: string;
    clean_mode?: number;
  };
}

export class PuduApi {
  constructor(readonly client: PuduClient) {}

  async healthCheck(): Promise<boolean> {
    const res = await this.client.get("/data-open-platform-service/v1/api/healthCheck");
    return res.status === 200;
  }

  /** 매장 목록. 대리점 키는 다른 고객사 매장까지 수천 곳이 보이므로 화면에 그대로 내보내지 않는다. */
  async listShops(limit = 20, offset = 0): Promise<Paged<PuduShop>> {
    return PuduClient.unwrap(await this.client.get<Paged<PuduShop>>("/data-open-platform-service/v1/api/shop", { limit, offset }), "매장 목록");
  }

  /** 로봇 목록. 실기 확인: shop_id 로 걸러진다(문자열). */
  async listRobots(opts: { limit?: number; offset?: number; shop_id?: string | number; product_code?: string[] } = {}): Promise<Paged<PuduRobot>> {
    return PuduClient.unwrap(await this.client.get<Paged<PuduRobot>>("/data-open-platform-service/v1/api/robot", { limit: opts.limit ?? 50, offset: opts.offset ?? 0, shop_id: opts.shop_id, product_code: opts.product_code }), "로봇 목록");
  }

  async statusV2(sn: string): Promise<PuduStatusV2> {
    return PuduClient.unwrap(await this.client.get<PuduStatusV2>("/open-platform-service/v2/status/get_by_sn", { sn }), "상태 V2");
  }

  async cleanDetail(sn: string): Promise<PuduCleanDetail> {
    return PuduClient.unwrap(await this.client.get<PuduCleanDetail>("/cleanbot-service/v1/api/open/robot/detail", { sn }), "청소로봇 상세");
  }

  /**
   * 등록 작업 목록. 실기 확인: product 가 없으면 PARAM_ERROR. product 는 소모품/예약 응답의 product 값
   * (cc1, cc1Pro, mt1, mt1Pro(=MT1Vac), mt1Max — 대소문자 무관)을 쓴다. mapping.productParamFor 참고.
   */
  async listCleanTasks(opts: { sn: string; product: string; limit?: number; offset?: number }): Promise<Paged<PuduCleanTask>> {
    return PuduClient.unwrap(await this.client.get<Paged<PuduCleanTask>>("/cleanbot-service/v1/api/open/task/list", { sn: opts.sn, product: opts.product, limit: opts.limit ?? 100, offset: opts.offset ?? 0 }), "등록 작업 목록");
  }

  async listCron(sn: string, limit = 50, offset = 0): Promise<Paged<PuduCron>> {
    return PuduClient.unwrap(await this.client.get<Paged<PuduCron>>("/cleanbot-service/v1/api/open/cron/list", { sn, limit, offset }), "예약 목록");
  }

  async listComponents(sn: string, limit = 50, offset = 0): Promise<Paged<PuduComponent>> {
    return PuduClient.unwrap(await this.client.get<Paged<PuduComponent>>("/cleanbot-service/v1/api/open/component/list", { sn, limit, offset }), "소모품 목록");
  }

  async execTask(body: PuduExecBody): Promise<{ task_id?: string; traceId: string | null }> {
    const res = await this.client.post<{ task_id?: string }>("/cleanbot-service/v1/api/open/task/exec", body);
    const data = PuduClient.unwrap(res, "명령 전송");
    return { task_id: data?.task_id, traceId: res.traceId };
  }

  /**
   * 청소 보고서 목록. limit 는 문서상 1~20. timezone_offset 은 항상 명시한다.
   * 실기 확인: sn/mac 으로는 걸러지지 않고(키가 보는 전체 로봇의 보고서가 나옴) shop_id 로만 걸러진다 → 항상 shop_id 를 넘긴다.
   */
  async listCleanReports(opts: { start_time: number; end_time: number; shop_id: string | number; timezone_offset: number; limit?: number; offset?: number }): Promise<Paged<PuduCleanReportSummary>> {
    return PuduClient.unwrap(
      await this.client.get<Paged<PuduCleanReportSummary>>("/data-board/v1/log/clean_task/query_list", { ...opts, limit: Math.min(opts.limit ?? 20, 20), offset: opts.offset ?? 0 }),
      "청소 보고서 목록",
    );
  }

  async cleanReportDetail(opts: { sn: string; report_id: string; start_time: number; end_time: number; timezone_offset: number; shop_id?: string | number }): Promise<PuduCleanReportDetail> {
    return PuduClient.unwrap(await this.client.get<PuduCleanReportDetail>("/data-board/v1/log/clean_task/query", opts), "청소 보고서 상세");
  }

  /** 장애 로그. 실기 확인: 보고서와 같이 shop_id 로만 걸러진다(전체는 수십만 건). error_level 은 대문자(WARNING…)로 온다. */
  async listErrors(opts: { start_time: number; end_time: number; shop_id: string | number; timezone_offset: number; error_levels?: string[]; limit?: number; offset?: number }): Promise<Paged<PuduErrorLog>> {
    return PuduClient.unwrap(await this.client.get<Paged<PuduErrorLog>>("/data-board/v1/log/error/query_list", { ...opts, limit: Math.min(opts.limit ?? 20, 20), offset: opts.offset ?? 0 }), "장애 로그");
  }
}
