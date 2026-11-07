import { withAuth, readJson, str, HttpError, json } from "@/lib/api/http";
import type { CommandType } from "@/lib/domain/types";
import { describeCommandResult, issueCommand, listCommands } from "@/lib/services/commands";

const TYPES: CommandType[] = ["START_TASK", "PAUSE", "RESUME", "STOP", "GO_HOME", "AREA_CLEAN"];

/** 이 로봇의 명령 이력(고객은 본인 것만). */
export const GET = withAuth<{ robotId: string }>(async ({ user, params }) => ({ commands: await listCommands(user, { robotId: decodeURIComponent(params.robotId), limit: 50 }) }));

/**
 * 로봇 명령. 본문 { type, params?, idempotencyKey }.
 * - idempotencyKey 는 **필수**: 앱이 버튼을 누를 때 한 번 만들어(UUID) 재시도에도 같은 값을 보낸다 → 같은 명령이 두 번 가지 않는다(409).
 * - 입구·기기(앱, 기기 이름, 세션)는 서버가 세션에서 정해 명령 행과 감사 기록에 남긴다.
 * - 사업장 원격 제어 스위치·역할·명령별 권한·상태 신선도·충돌 방지는 웹과 같은 서비스 함수가 검사한다.
 * - 접수(ACCEPTED)는 HTTP 접수일 뿐이다. 앱은 명령 상태/로봇 상태를 다시 조회해 실행 확인을 보여 준다.
 */
export const POST = withAuth<{ robotId: string }>(async ({ req, user, session, params }) => {
  const b = await readJson(req);
  const type = str(b.type, "type", { required: true, max: 20 }) as CommandType;
  if (!TYPES.includes(type)) throw new HttpError(400, "지원하지 않는 명령 종류입니다.", "VALIDATION");
  const idempotencyKey = str(b.idempotencyKey, "idempotencyKey", { required: true, max: 100 });
  const cmdParams = b.params && typeof b.params === "object" && !Array.isArray(b.params) ? (b.params as Record<string, unknown>) : {};
  const cmd = await issueCommand(user, { robotId: decodeURIComponent(params.robotId), type, params: cmdParams, idempotencyKey: `app:${user.id}:${idempotencyKey}`, origin: { channel: "app", device: session.deviceName, sessionId: session.id } });
  return json({ command: { id: cmd.id, type: cmd.type, state: cmd.state, requestedAt: cmd.requestedAt, expiresAt: cmd.expiresAt, stateChangedAt: cmd.stateChangedAt }, message: describeCommandResult(user, cmd) }, 201);
});
