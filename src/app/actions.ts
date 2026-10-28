"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { CleanMode, CommandType, ReportComments, Role, Severity } from "@/lib/domain/types";
import { cookieOptions, createSession, getCurrentUser, getOptionalUser, SESSION_COOKIE } from "@/lib/auth/session";
import { AppError, errorMessage, ForbiddenError } from "@/lib/util/errors";
import { issueCommand, type IssueCommandInput } from "@/lib/services/commands";
import * as incidents from "@/lib/services/incidents";
import * as tasks from "@/lib/services/tasks";
import * as reports from "@/lib/services/reports";
import * as admin from "@/lib/services/admin";
import * as auth from "@/lib/services/auth";
import { addManualInspection, completeInspection } from "@/lib/services/robots";
import { resetDatabase, seedDatabase } from "@/lib/db/seed";
import { buildSampleStore } from "@/lib/sample/seed";
import { nowIso } from "@/lib/util/time";

/**
 * 서버 액션. 모든 액션은 서버에서 현재 사용자를 다시 읽고 서비스 계층의 인가 검증을 거친다.
 * (서버 액션은 직접 POST 로도 호출될 수 있으므로 UI 숨김에 의존하지 않는다.)
 */
export type ActionResult = { ok: true; message?: string; id?: string; link?: string } | { ok: false; error: string };

async function run(fn: () => Promise<{ message?: string; id?: string; link?: string } | void>): Promise<ActionResult> {
  try {
    const r = await fn();
    revalidatePath("/", "layout");
    return { ok: true, message: r?.message, id: r?.id, link: r?.link };
  } catch (e) {
    if (!(e instanceof AppError)) console.error("[action] 처리 오류:", e);
    return { ok: false, error: errorMessage(e) };
  }
}

// ---- 인증 ----
export async function loginAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/");
  const ua = (await headers()).get("user-agent") ?? "";
  const res = await auth.login(email, password, ua);
  if (!res.ok) return { ok: false, error: res.error };
  const jar = await cookies();
  jar.set(SESSION_COOKIE, res.sessionId, cookieOptions());
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}

export async function logoutAction(): Promise<void> {
  const jar = await cookies();
  const sid = jar.get(SESSION_COOKIE)?.value;
  const user = await getOptionalUser();
  await auth.logout(sid, user ? { id: user.id, name: user.name } : null);
  jar.set(SESSION_COOKIE, "", { ...cookieOptions(), maxAge: 0 });
  redirect("/login");
}

export async function acceptInviteAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const token = String(formData.get("token") ?? "");
  try {
    await auth.acceptInvite(token, String(formData.get("password") ?? ""), String(formData.get("password2") ?? ""));
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
  redirect("/login?set=1");
}

export async function changePasswordAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const user = await getCurrentUser();
  return run(async () => {
    await auth.changePassword({ id: user.id, name: user.name }, String(formData.get("current") ?? ""), String(formData.get("next") ?? ""), String(formData.get("next2") ?? ""));
    return { message: "비밀번호를 변경했습니다." };
  });
}

// ---- 샘플 데이터 ----
export async function resetSampleAction(): Promise<ActionResult> {
  return run(async () => {
    const user = await getCurrentUser();
    if (user.role !== "HQ_ADMIN") throw new ForbiddenError("본사 관리자만 초기화할 수 있습니다.");
    if (process.env.ALLOW_SAMPLE_RESET !== "true") throw new ForbiddenError("이 환경에서는 샘플 데이터 초기화가 비활성화되어 있습니다(ALLOW_SAMPLE_RESET).");
    await resetDatabase();
    await seedDatabase(buildSampleStore(nowIso()), process.env.SAMPLE_USER_PASSWORD ?? "sample1234!");
    // 세션 테이블도 비워졌으므로, 샘플에 같은 ID 가 있으면 현재 관리자의 세션을 다시 만든다.
    const ua = (await headers()).get("user-agent") ?? "";
    const sid = await createSession(user.id, ua);
    (await cookies()).set(SESSION_COOKIE, sid, cookieOptions());
    return { message: "샘플 데이터를 초기화했습니다. 다른 사용자는 다시 로그인해야 합니다." };
  });
}

export async function issueCommandAction(input: IssueCommandInput): Promise<ActionResult> {
  return run(async () => {
    const user = await getCurrentUser();
    const cmd = await issueCommand(user, input);
    return { message: `${cmd.state}: ${cmd.message ?? ""}`, id: cmd.id };
  });
}

// ---- 장애 ----
export async function ackIncidentAction(id: string): Promise<ActionResult> {
  return run(async () => incidents.acknowledgeIncident(await getCurrentUser(), id));
}
export async function assignIncidentAction(id: string, assigneeId: string): Promise<ActionResult> {
  return run(async () => incidents.assignIncident(await getCurrentUser(), id, assigneeId));
}
export async function addIncidentActionAction(id: string, note: string, internal: boolean): Promise<ActionResult> {
  return run(async () => incidents.addIncidentAction(await getCurrentUser(), id, note, internal));
}
export async function resolveIncidentAction(id: string, note: string): Promise<ActionResult> {
  return run(async () => incidents.resolveIncident(await getCurrentUser(), id, note));
}
export async function simulateIncidentAction(robotId: string, code: string, severity: Severity, vendorEventId: string | null): Promise<ActionResult> {
  return run(async () => {
    const inc = await incidents.simulateIncident(await getCurrentUser(), robotId, code, severity, vendorEventId);
    return { message: inc ? "장애 발생을 시뮬레이션했습니다(알림은 모의 발송)." : "중복 이벤트 ID — 무시했습니다." };
  });
}

// ---- 작업·일정 ----
export async function cancelPlannedAction(id: string, reason: string): Promise<ActionResult> {
  return run(async () => tasks.cancelPlannedRun(await getCurrentUser(), id, reason));
}
export async function toggleScheduleAction(id: string, enabled: boolean): Promise<ActionResult> {
  return run(async () => tasks.toggleSchedule(await getCurrentUser(), id, enabled));
}
export async function createTaskAction(input: { robotId: string; name: string; zoneIds: string[]; mode: CleanMode }): Promise<ActionResult> {
  return run(async () => void (await tasks.createTask(await getCurrentUser(), input)));
}
export async function createScheduleAction(input: { taskId: string; daysOfWeek: number[]; time: string }): Promise<ActionResult> {
  return run(async () => void (await tasks.createSchedule(await getCurrentUser(), input)));
}

// ---- 보고서 ----
export async function createDraftAction(siteId: string, month: string): Promise<ActionResult> {
  return run(async () => {
    const r = await reports.createDraft(await getCurrentUser(), siteId, month);
    return { id: r.id, message: `초안 v${r.version} 생성` };
  });
}
export async function recomputeDraftAction(id: string): Promise<ActionResult> {
  return run(async () => reports.recomputeDraft(await getCurrentUser(), id));
}
export async function updateCommentsAction(id: string, comments: Partial<ReportComments>): Promise<ActionResult> {
  return run(async () => reports.updateComments(await getCurrentUser(), id, comments));
}
export async function submitReviewAction(id: string): Promise<ActionResult> {
  return run(async () => reports.submitForReview(await getCurrentUser(), id));
}
export async function returnToDraftAction(id: string, reason: string): Promise<ActionResult> {
  return run(async () => reports.returnToDraft(await getCurrentUser(), id, reason));
}
export async function confirmReportAction(id: string): Promise<ActionResult> {
  return run(async () => reports.confirmReport(await getCurrentUser(), id));
}
export async function publishReportAction(id: string): Promise<ActionResult> {
  return run(async () => reports.publishReport(await getCurrentUser(), id));
}

// ---- 점검 ----
export async function completeInspectionAction(id: string, note: string): Promise<ActionResult> {
  return run(async () => void (await completeInspection(await getCurrentUser(), id, note)));
}
export async function addManualInspectionAction(robotId: string, item: string): Promise<ActionResult> {
  return run(async () => void (await addManualInspection(await getCurrentUser(), robotId, item)));
}

// ---- 관리 설정 ----
export async function setUserActiveAction(targetId: string, active: boolean): Promise<ActionResult> {
  return run(async () => admin.setUserActive(await getCurrentUser(), targetId, active));
}
export async function setUserPermissionsAction(targetId: string, siteIds: string[], allowedCommands: CommandType[]): Promise<ActionResult> {
  return run(async () => admin.setUserSitePermissions(await getCurrentUser(), targetId, siteIds, allowedCommands));
}
export async function createUserAction(input: { name: string; email: string; role: Role; siteIds: string[]; allowedCommands: CommandType[] }): Promise<ActionResult> {
  return run(async () => {
    const r = await admin.createUser(await getCurrentUser(), input);
    return { message: "사용자를 등록했습니다. 아래 초대 링크를 본인에게 전달하세요(72시간 유효).", link: r.inviteLink, id: r.user.id };
  });
}
export async function reissueInviteAction(targetId: string): Promise<ActionResult> {
  return run(async () => {
    const link = await admin.reissueInvite(await getCurrentUser(), targetId);
    return { message: "초대 링크를 재발급했습니다(기존 세션 종료).", link };
  });
}
export async function addRecipientAction(siteId: string, input: { channel: "EMAIL" | "KAKAO"; address: string; minSeverity: Severity; hoursFrom: string; hoursTo: string }): Promise<ActionResult> {
  return run(async () => admin.addRecipient(await getCurrentUser(), siteId, input));
}
export async function removeRecipientAction(siteId: string, recipientId: string): Promise<ActionResult> {
  return run(async () => admin.removeRecipient(await getCurrentUser(), siteId, recipientId));
}
export async function updateThresholdsAction(siteId: string, dedupeMinutes: number, escalateAfterMinutes: number): Promise<ActionResult> {
  return run(async () => admin.updateNotificationThresholds(await getCurrentUser(), siteId, dedupeMinutes, escalateAfterMinutes));
}
export async function relocateRobotAction(robotId: string, toSiteId: string, toFloorId: string): Promise<ActionResult> {
  return run(async () => admin.relocateRobot(await getCurrentUser(), robotId, toSiteId, toFloorId));
}
export async function setSiteManagerCanConfirmAction(value: boolean): Promise<ActionResult> {
  return run(async () => admin.setSiteManagerCanConfirm(await getCurrentUser(), value));
}

// ---- 제조사 연동(PUDU) ----
export async function puduTestConnectionAction(): Promise<ActionResult & { robots?: Awaited<ReturnType<typeof admin.puduTestConnection>>["robots"] }> {
  try {
    const user = await getCurrentUser();
    const r = await admin.puduTestConnection(user);
    revalidatePath("/admin");
    return r.ok ? { ok: true, message: r.message, robots: r.robots } : { ok: false, error: r.message };
  } catch (e) {
    if (!(e instanceof AppError)) console.error("[action] PUDU 연결 확인 오류:", e);
    return { ok: false, error: e instanceof AppError ? e.message : `연결 실패: ${(e as Error).message}` };
  }
}
export async function puduImportRobotsAction(siteId: string, floorId: string, sns: string[]): Promise<ActionResult> {
  return run(async () => {
    const n = await admin.puduImportRobots(await getCurrentUser(), siteId, floorId, sns);
    return { message: `PUDU 로봇 ${n}대를 등록했습니다. 첫 상태는 워커 폴링 후 표시됩니다.` };
  });
}
export async function puduSyncNowAction(job: "status" | "reports" | "catalog" | "events"): Promise<ActionResult> {
  return run(async () => {
    const user = await getCurrentUser();
    if (user.role !== "HQ_ADMIN") throw new ForbiddenError("본사 관리자만 실행할 수 있습니다.");
    const w = await import("@/worker/pudu");
    const api = (await import("@/lib/vendors/pudu/puduAdapter")).createPuduApi();
    const r = job === "status" ? await w.syncPuduStatus() : job === "reports" ? await w.syncPuduReports(api) : job === "catalog" ? await w.syncPuduCatalog(api) : await w.processPuduEvents();
    if (!r.ok) throw new AppError(`${r.job} 실패: ${r.detail}`, "UNSUPPORTED");
    return { message: `${r.job}: ${r.detail}` };
  });
}

// ---- 사업장·층·지도 (본사 관리자) ----
import * as sitesSvc from "@/lib/services/sites";
export async function createSiteAction(input: { name: string; address: string; timezone?: string }): Promise<ActionResult> {
  return run(async () => {
    const r = await sitesSvc.createSite(await getCurrentUser(), input);
    return { message: `사업장 '${input.name}' 을(를) 만들었습니다. 층을 추가하세요.`, id: r.id };
  });
}
export async function updateSiteAction(siteId: string, input: { name?: string; address?: string; timezone?: string }): Promise<ActionResult> {
  return run(async () => {
    await sitesSvc.updateSite(await getCurrentUser(), siteId, input);
    return { message: "사업장 정보를 저장했습니다." };
  });
}
export async function deleteSiteAction(siteId: string): Promise<ActionResult> {
  return run(async () => {
    await sitesSvc.deleteSite(await getCurrentUser(), siteId);
    return { message: "사업장을 삭제했습니다." };
  });
}
export async function createFloorAction(siteId: string, name: string): Promise<ActionResult> {
  return run(async () => {
    const r = await sitesSvc.createFloor(await getCurrentUser(), siteId, name);
    return { message: `층 '${name}' 을(를) 만들었습니다(빈 지도 v1).`, id: r.id };
  });
}
export async function renameFloorAction(floorId: string, name: string): Promise<ActionResult> {
  return run(async () => {
    await sitesSvc.renameFloor(await getCurrentUser(), floorId, name);
    return { message: "층 이름을 저장했습니다." };
  });
}
export async function deleteFloorAction(floorId: string): Promise<ActionResult> {
  return run(async () => {
    await sitesSvc.deleteFloor(await getCurrentUser(), floorId);
    return { message: "층을 삭제했습니다." };
  });
}
export async function listPuduMapsAction(siteId: string): Promise<ActionResult & { maps?: { name: string; floor: string; is_used?: number }[] }> {
  try {
    const r = await sitesSvc.listPuduMapsForSite(await getCurrentUser(), siteId);
    return { ok: true, message: `PUDU 매장 ${r.shopId} 의 지도 ${r.maps.length}개`, maps: r.maps };
  } catch (e) {
    if (!(e instanceof AppError)) console.error("[action] 처리 오류:", e);
    return { ok: false, error: errorMessage(e) };
  }
}
export async function importPuduMapAction(floorId: string, mapName: string): Promise<ActionResult> {
  return run(async () => {
    const r = await sitesSvc.importPuduMap(await getCurrentUser(), floorId, mapName);
    return { message: `지도 v${r.version} 으로 가져왔습니다(구역 ${r.zones}개). 로봇 위치는 다음 폴링부터 이 지도 위에 표시됩니다.`, id: r.mapVersionId };
  });
}
