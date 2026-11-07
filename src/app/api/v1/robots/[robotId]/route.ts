import { withAuth } from "@/lib/api/http";
import { getRobotDetail } from "@/lib/services/robots";

/** 로봇 상세(상태·최근 작업·장애·점검·명령 이력·지원 명령). 고객에게는 내부 메모·제조사 ID 가 빠진다. */
export const GET = withAuth<{ robotId: string }>(async ({ user, params }) => getRobotDetail(user, decodeURIComponent(params.robotId)));
