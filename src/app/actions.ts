"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import type { CleanMode, CommandType, ReportComments, Role, Severity } from "@/lib/domain/types";
import { getCurrentUser, SESSION_COOKIE } from "@/lib/auth/session";
import { getStore, resetStore } from "@/lib/store/store";
import { errorMessage } from "@/lib/util/errors";
import { issueCommand, type IssueCommandInput } from "@/lib/services/commands";
import * as incidents from "@/lib/services/incidents";
import * as tasks from "@/lib/services/tasks";
import * as reports from "@/lib/services/reports";
import * as admin from "@/lib/services/admin";
import { addManualInspection, completeInspection } from "@/lib/services/robots";

/**
 * 서버 액션. 모든 액션은 서버에서 현재 사용자를 다시 읽고 서비스 계층의 인가 검증을 거친다.
 * (서버 액션은 직접 POST 로도 호출될 수 있으므로 UI 숨김에 의존하지 않는다.)
 */
export type ActionResult = { ok: true; message?: string; id?: string } | { ok: false; error: string };

async function run(fn: () => Promise<{ message?: string; id?: string } | void>): Promise<ActionResult> {
  try {
    const r = await fn();
    revalidatePath("/", "layout");
    return { ok: true, message: r?.message, id: r?.id };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

export async function switchUserAction(userId: string): Promise<ActionResult> {
  const store = getStore();
  if (!store.users.some((u) => u.id === userId)) return { ok: false, error: "알 수 없는 샘플 사용자" };
  const jar = await cookies();
  jar.set(SESSION_COOKIE, userId, { path: "/", httpOnly: true, sameSite: "lax" });
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function resetSampleAction(): Promise<ActionResult> {
  return run(async () => {
    const user = await getCurrentUser();
    if (user.role !== "HQ_ADMIN") throw new Error("본사 관리자만 초기화할 수 있습니다.");
    resetStore();
    return { message: "샘플 데이터를 초기화했습니다." };
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
  return run(async () => void incidents.acknowledgeIncident(await getCurrentUser(), id));
}
export async function assignIncidentAction(id: string, assigneeId: string): Promise<ActionResult> {
  return run(async () => void incidents.assignIncident(await getCurrentUser(), id, assigneeId));
}
export async function addIncidentActionAction(id: string, note: string, internal: boolean): Promise<ActionResult> {
  return run(async () => void incidents.addIncidentAction(await getCurrentUser(), id, note, internal));
}
export async function resolveIncidentAction(id: string, note: string): Promise<ActionResult> {
  return run(async () => void (await incidents.resolveIncident(await getCurrentUser(), id, note)));
}
export async function simulateIncidentAction(robotId: string, code: string, severity: Severity, vendorEventId: string | null): Promise<ActionResult> {
  return run(async () => {
    const inc = await incidents.simulateIncident(await getCurrentUser(), robotId, code, severity, vendorEventId);
    return { message: inc ? "장애 발생을 시뮬레이션했습니다(알림은 모의 발송)." : "중복 이벤트 ID — 무시했습니다." };
  });
}

// ---- 작업·일정 ----
export async function cancelPlannedAction(id: string, reason: string): Promise<ActionResult> {
  return run(async () => void tasks.cancelPlannedRun(await getCurrentUser(), id, reason));
}
export async function toggleScheduleAction(id: string, enabled: boolean): Promise<ActionResult> {
  return run(async () => void tasks.toggleSchedule(await getCurrentUser(), id, enabled));
}
export async function createTaskAction(input: { robotId: string; name: string; zoneIds: string[]; mode: CleanMode }): Promise<ActionResult> {
  return run(async () => void tasks.createTask(await getCurrentUser(), input));
}
export async function createScheduleAction(input: { taskId: string; daysOfWeek: number[]; time: string }): Promise<ActionResult> {
  return run(async () => void tasks.createSchedule(await getCurrentUser(), input));
}

// ---- 보고서 ----
export async function createDraftAction(siteId: string, month: string): Promise<ActionResult> {
  return run(async () => {
    const r = reports.createDraft(await getCurrentUser(), siteId, month);
    return { id: r.id, message: `초안 v${r.version} 생성` };
  });
}
export async function recomputeDraftAction(id: string): Promise<ActionResult> {
  return run(async () => void reports.recomputeDraft(await getCurrentUser(), id));
}
export async function updateCommentsAction(id: string, comments: Partial<ReportComments>): Promise<ActionResult> {
  return run(async () => void reports.updateComments(await getCurrentUser(), id, comments));
}
export async function submitReviewAction(id: string): Promise<ActionResult> {
  return run(async () => void reports.submitForReview(await getCurrentUser(), id));
}
export async function returnToDraftAction(id: string, reason: string): Promise<ActionResult> {
  return run(async () => void reports.returnToDraft(await getCurrentUser(), id, reason));
}
export async function confirmReportAction(id: string): Promise<ActionResult> {
  return run(async () => void reports.confirmReport(await getCurrentUser(), id));
}
export async function publishReportAction(id: string): Promise<ActionResult> {
  return run(async () => void reports.publishReport(await getCurrentUser(), id));
}

// ---- 점검 ----
export async function completeInspectionAction(id: string, note: string): Promise<ActionResult> {
  return run(async () => void completeInspection(await getCurrentUser(), id, note));
}
export async function addManualInspectionAction(robotId: string, item: string): Promise<ActionResult> {
  return run(async () => void addManualInspection(await getCurrentUser(), robotId, item));
}

// ---- 관리 설정 ----
export async function setUserActiveAction(targetId: string, active: boolean): Promise<ActionResult> {
  return run(async () => void admin.setUserActive(await getCurrentUser(), targetId, active));
}
export async function setUserPermissionsAction(targetId: string, siteIds: string[], allowedCommands: CommandType[]): Promise<ActionResult> {
  return run(async () => void admin.setUserSitePermissions(await getCurrentUser(), targetId, siteIds, allowedCommands));
}
export async function createUserAction(input: { name: string; email: string; role: Role; siteIds: string[]; allowedCommands: CommandType[] }): Promise<ActionResult> {
  return run(async () => void admin.createUser(await getCurrentUser(), input));
}
export async function addRecipientAction(siteId: string, input: { channel: "EMAIL" | "KAKAO"; address: string; minSeverity: Severity; hoursFrom: string; hoursTo: string }): Promise<ActionResult> {
  return run(async () => void admin.addRecipient(await getCurrentUser(), siteId, input));
}
export async function removeRecipientAction(siteId: string, recipientId: string): Promise<ActionResult> {
  return run(async () => void admin.removeRecipient(await getCurrentUser(), siteId, recipientId));
}
export async function updateThresholdsAction(siteId: string, dedupeMinutes: number, escalateAfterMinutes: number): Promise<ActionResult> {
  return run(async () => void admin.updateNotificationThresholds(await getCurrentUser(), siteId, dedupeMinutes, escalateAfterMinutes));
}
export async function relocateRobotAction(robotId: string, toSiteId: string, toFloorId: string): Promise<ActionResult> {
  return run(async () => void admin.relocateRobot(await getCurrentUser(), robotId, toSiteId, toFloorId));
}
export async function setSiteManagerCanConfirmAction(value: boolean): Promise<ActionResult> {
  return run(async () => void admin.setSiteManagerCanConfirm(await getCurrentUser(), value));
}
