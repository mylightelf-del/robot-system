import type { PuduApi, PuduStatusV2 } from "@/lib/vendors/pudu/api";
import { PuduClient } from "@/lib/vendors/pudu/client";
import type { AgentNotify, DeliveryTrayDestination } from "./agent";

/**
 * 배송로봇 신형 경로(docs/23 §8): PUDU 오픈플랫폼(클라우드) API.
 * 청소로봇과 같은 키·같은 콜백 주소(/api/webhooks/pudu)를 쓴다. 에이전트가 필요 없다.
 *
 * 콜백 형식은 운영 수신 원문(2026-11-12, 회사 BellaBot)으로 확인: snake_case, 상태는 대문자(ON_THE_WAY),
 * 시간 값은 초(spend_time 88, estimated_time 885), timestamp 는 초.
 * 여기서는 오픈플랫폼 콜백을 에이전트 알림 모양(AgentNotify)으로 바꿔, 이후 처리(구간·도착 알림·막힘)를 한 곳에서 한다.
 */

/** MAC → 로봇 식별자(에이전트 로봇 ID 와 같은 꼴: 소문자·콜론 제거). */
export function macToRobotId(mac: string | undefined | null): string {
  return String(mac ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");
}

/** 배송로봇으로 넘길 오픈플랫폼 콜백 종류. 청소 콜백(notifyCleanStatus 등)은 넘기지 않는다. */
export const OP_DELIVERY_CALLBACKS = new Set([
  "notifyDeliveryTask",
  "robotDeliveryStatus",
  "notifyRobotMoveState",
  "notifyRobotPower",
  "notifyRobotPose",
  "notifyRobotStatus",
  "robotStatus",
  "notifyCustomCall",
]);

/** ON_THE_WAY → OnTheWay, STUCK → Stuck (에이전트 표기로). */
export function pascal(v: unknown): string {
  return String(v ?? "")
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
}

function sec(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1000) : undefined;
}

/** 발생 시각(ms). notify_timestamp(0 이면 없음) → timestamp. 10^12 미만은 초로 본다. */
export function opTimestampMs(d: Record<string, unknown>): number | undefined {
  for (const k of ["notify_timestamp", "timestamp"]) {
    const n = Number(d[k]);
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  }
  return undefined;
}

type OpCallback = { callback_type?: string; data?: Record<string, unknown> };

/** 오픈플랫폼 콜백 → 에이전트 알림 꼴. 배송과 무관하면 null. */
export function opToAgentNotify(cb: OpCallback, robotId: string, msgId: string): AgentNotify | null {
  const type = String(cb.callback_type ?? "");
  const d = cb.data ?? {};
  if (!OP_DELIVERY_CALLBACKS.has(type) || !robotId) return null;
  const base = { msgId, robotId, timestamp: opTimestampMs(d) };
  switch (type) {
    case "notifyDeliveryTask":
    case "robotDeliveryStatus": {
      const trays = ((d.trays as { destinations?: Record<string, unknown>[] }[] | undefined) ?? []).map((t) => ({
        destinations: (t?.destinations ?? []).map(
          (x): DeliveryTrayDestination => ({
            destination: String(x.destination ?? ""),
            id: x.id ? String(x.id) : undefined,
            type: x.type ? String(x.type).toLowerCase() : undefined,
            status: pascal(x.status),
            completeType: x.complete_type ? String(x.complete_type) : undefined,
            estimatedTime: sec(x.estimated_time),
            spendTime: sec(x.spend_time),
          }),
        ),
      }));
      return { ...base, msgType: "notifyDeliveryTask", data: { trays, deliveryMode: String(d.delivery_mode ?? ""), taskId: d.task_id ?? "", taskStatus: d.task_status ?? "", source: "openplatform" } };
    }
    case "notifyRobotMoveState": {
      const st = pascal(d.move_state ?? d.state);
      return { ...base, msgType: "notifyRobotMoveState", data: { state: st, errors: d.errors ?? [] } };
    }
    case "notifyRobotPower":
      return { ...base, msgType: "notifyRobotPower", data: { power: d.power ?? d.battery, chargeStage: d.charge_stage ?? d.chargeStage } };
    case "notifyRobotPose":
      return { ...base, msgType: "notifyRobotPose", data: { x: d.x, y: d.y, yaw: d.yaw, nearestPoint: d.nearest_point } };
    case "notifyRobotStatus": {
      const run = String(d.run_state ?? "");
      return { ...base, msgType: "notifyRobotStatus", data: { robotState: run === "BUSY" ? "BUSY" : run === "IDLE" ? "FREE" : run || undefined, online: run !== "OFFLINE", robotPower: typeof d.battery === "number" ? d.battery : undefined, charging: d.is_charging === 1 } };
    }
    case "robotStatus":
      return { ...base, msgType: "notifyRobotStatus", data: { online: d.run_status === "online" } };
    case "notifyCustomCall":
      return { ...base, msgType: "notifyCustomCall", data: { state: d.state, point: d.point, mapName: d.map_name, taskId: d.task_id } };
    default:
      return null;
  }
}

/** 상태 V2 → 배송로봇 마지막 상태(화면이 읽는 robotState/moveState/robotPower). */
export function opStateFromStatus(s: PuduStatusV2): Record<string, unknown> {
  const run = String(s.run_state ?? "");
  return {
    robotState: run === "BUSY" ? "BUSY" : run === "IDLE" ? "FREE" : run,
    online: run !== "OFFLINE",
    robotPower: s.battery,
    charging: s.is_charging === 1,
    chargeStage: s.charge_stage,
    ...(s.move_state ? { moveState: pascal(s.move_state) } : {}),
  };
}

/** 지도 요소 중 배송 목적지로 쓰는 종류(테이블·지점·충전·출발지 등). 구역·금지선·경로는 뺀다. */
const NOT_DEST = new Set(["area", "forbidden", "track", "virtual_wall", "zone", "elevator"]);

export async function opDestinations(api: PuduApi, sn: string): Promise<{ mapName: string; destinations: { name: string; type: string }[] } | null> {
  const maps = await api.listMaps(sn);
  const used = (maps.list ?? []).find((m) => m.is_used === 1) ?? maps.list?.[0];
  if (!used || maps.shop_id == null) return null;
  const detail = await api.mapDetail(maps.shop_id, used.name);
  const seen = new Set<string>();
  const destinations = (detail.element_list ?? [])
    .filter((e) => e.name && !NOT_DEST.has(e.type))
    .filter((e) => (seen.has(e.name) ? false : (seen.add(e.name), true)))
    .map((e) => ({ name: e.name, type: e.type }));
  return { mapName: used.name, destinations };
}

/**
 * 오픈플랫폼 배송 지시(공식 문서 pudu-robotics/skills 의 delivery_task). payload.type 값 목록은 공개 문서에 없어
 * 환경값 PUDU_OP_DELIVERY_TYPE(기본 "new", 에이전트와 같은 값)으로 둔다 — 실기 첫 전송 때 확인(TODO).
 */
export interface OpDeliveryTray {
  destination: string;
  id: string;
  /** 받는 사람 번호 — 로봇(PUDU)이 도착 문자를 보낸다 */
  phoneNum?: string;
  phoneCode?: string;
}
export async function opSendDelivery(client: PuduClient, input: { sn: string; shopId: string; mapName?: string; trays: OpDeliveryTray[][]; sort: string; executeTask: boolean }): Promise<{ taskId?: string; traceId: string | null }> {
  const body = {
    sn: input.sn,
    shopId: input.shopId,
    payload: {
      type: process.env.PUDU_OP_DELIVERY_TYPE || "new",
      deliverySort: input.sort,
      executeTask: input.executeTask,
      trays: input.trays.map((t) => ({ destinations: t.map((d) => ({ destination: d.destination, id: d.id, ...(d.phoneNum ? { phoneNum: d.phoneNum, phoneCode: d.phoneCode } : {}), ...(input.mapName ? { mapInfo: { mapName: input.mapName } } : {}) })) })),
    },
  };
  const res = await client.post<{ code?: number | string; message?: string; taskId?: string }>("/open-platform-service/v1/delivery_task", body);
  const data = PuduClient.unwrap(res, "배송 지시");
  if (data && data.code != null && String(data.code) !== "0" && String(data.code) !== "200") throw new Error(`로봇이 거절했습니다: ${data.message ?? data.code}`);
  return { taskId: data?.taskId, traceId: res.traceId };
}
