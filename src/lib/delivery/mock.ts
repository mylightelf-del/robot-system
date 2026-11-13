import type { AgentTransport } from "./agent";

/**
 * 에이전트 mock(PUDU_AGENT_MODE=mock). 실제 에이전트 없이 로봇 목록·상태·목적지를 문서 형식 그대로 돌려준다.
 * 배송 임무 알림은 시험·화면 확인용으로 /api/webhooks/pudu-agent 에 직접 보내서 흉내 낸다.
 */
export const MOCK_DEVICE_ID = "MOCK-DEVICE";
export const MOCK_GROUP_ID = "MOCK-GROUP";
export const MOCK_ROBOT = { id: "MOCKFLASH01", name: "배송 1호(모의)", shop_name: "테스트_포스코빌딩(삼성)" };
export const MOCK_DESTINATIONS = [
  { name: "2601", type: "table" },
  { name: "2602", type: "table" },
  { name: "2603", type: "table" },
  { name: "회의실A", type: "table" },
  { name: "출발지", type: "dining_outlet" },
];

export const agentMockState = { requests: [] as { method: string; path: string }[], online: true };

export const agentMockTransport: AgentTransport = {
  async send(req) {
    agentMockState.requests.push({ method: req.method, path: req.path });
    const ok = (data: unknown) => ({ status: 200, json: { code: "0", msg: "", data } });
    switch (req.path) {
      case "/api/devices":
        return ok({ devices: [{ name: "모의 장치", deviceId: MOCK_DEVICE_ID, region: "ap-southeast-1" }] });
      case "/api/robot/groups":
        return ok([{ id: MOCK_GROUP_ID, name: "기본 그룹", shop_name: MOCK_ROBOT.shop_name }]);
      case "/api/robots":
        return ok({ robots: [MOCK_ROBOT] });
      case "/api/robot/state":
        return ok({ state: agentMockState.online ? [{ robotId: MOCK_ROBOT.id, robotState: "FREE", moveState: "Idle", chargeStage: "Charging", robotPower: 87, robotPose: { x: 1.2, y: 3.4, angle: 90 } }] : [] });
      case "/api/destinations":
        return ok({ total: MOCK_DESTINATIONS.length, pageSize: 200, pageIndex: 1, destinations: MOCK_DESTINATIONS });
      case "/api/add/device":
      case "/api/notify/url":
        return ok({ success: true });
      default:
        return { status: 404, json: { code: "10005", msg: "mock: unknown path" } };
    }
  },
};
