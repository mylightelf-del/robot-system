import type { CommonStatus } from "@/lib/domain/types";
import type { BibCurrentTask, BibStatus } from "./api";

/**
 * 상태 → 공통 상태. 가이드의 activityState: IDLE 대기, WORKING 작업 중, PAUSED 일시정지, BUSY 사용 중, UNKNOWN.
 * BUSY 는 현재 작업이 있으면 청소 중, 없으면 '사용 중(수동 조작·이동 등)'이라 대기로 두고 원시값에 남긴다(실측: 작업 없는 BUSY 있음).
 * 충전 상태는 API 에 없다.
 */
export function mapBibStatus(s: BibStatus, cur: BibCurrentTask | null): { common: CommonStatus; raw: string; missionId: string | null } {
  const task = cur?.task ?? null;
  let common: CommonStatus;
  if (s.online === false) common = "OFFLINE";
  else if (s.activityState === "PAUSED" || task?.state === "PAUSED") common = "PAUSED";
  else if (s.activityState === "WORKING" || (s.activityState === "BUSY" && task)) common = "CLEANING";
  else if (s.activityState === "IDLE" || s.activityState === "BUSY") common = "IDLE";
  else common = s.online === null ? "UNKNOWN" : "IDLE";
  const raw = `online=${s.online ?? "?"} activity=${s.activityState} moving=${s.movingStatus} freshness=${s.freshness}${task ? ` task=${task.taskId.slice(0, 18)}…(${task.state})` : ""}`;
  return { common, raw, missionId: task?.taskId ?? null };
}
