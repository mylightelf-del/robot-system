import type { CommandType, Role, User } from "@/lib/domain/types";
import { ForbiddenError, NotFoundError } from "@/lib/util/errors";
import { allSiteIds, getRobot, loadSettings, type DbLike } from "@/lib/db/repo";
import type { Robot } from "@/lib/domain/types";
import { getDb } from "@/lib/db/client";

/**
 * 인가 규칙 — 모든 목록·상세·지도·명령·보고서 접근은 서버의 이 함수들을 통과해야 한다.
 * UI 에서 숨기는 것만으로 권한 구현을 완료 처리하지 않는다.
 * 순수 규칙(동기)과 DB 조회가 필요한 함수(비동기)를 구분한다.
 */

export function assertActive(user: User): void {
  if (!user.active) throw new ForbiddenError("비활성화된 사용자입니다. 접근이 차단되었습니다.");
}

export function isCustomer(user: Pick<User, "role">): boolean {
  return user.role === "CUSTOMER_BASIC" || user.role === "CUSTOMER_CONTROL";
}

export function isStaff(user: Pick<User, "role">): boolean {
  return user.role === "HQ_ADMIN" || user.role === "SITE_MANAGER";
}

/** 사용자가 조회할 수 있는 사업장 ID. 본사 관리자는 권한이 비어 있으면 전체. */
export function accessibleSiteIdsOf(user: User, everySiteId: string[]): string[] {
  if (!user.active) return [];
  if (user.role === "HQ_ADMIN" && user.sitePermissions.length === 0) return everySiteId;
  return user.sitePermissions.map((p) => p.siteId).filter((id) => everySiteId.includes(id));
}

export async function accessibleSiteIds(user: User, db: DbLike = getDb()): Promise<string[]> {
  return accessibleSiteIdsOf(user, await allSiteIds(db));
}

export async function canAccessSite(user: User, siteId: string, db: DbLike = getDb()): Promise<boolean> {
  return (await accessibleSiteIds(user, db)).includes(siteId);
}

export async function assertSiteAccess(user: User, siteId: string, db: DbLike = getDb()): Promise<void> {
  assertActive(user);
  if (!(await canAccessSite(user, siteId, db))) {
    // 존재 여부를 노출하지 않기 위해 동일 메시지를 사용한다.
    throw new ForbiddenError("해당 사업장에 대한 접근 권한이 없습니다.");
  }
}

/** 로봇 ID 로 접근할 때 로봇의 현재 사업장 범위를 검증한다(URL 조작 차단). */
export async function assertRobotAccess(user: User, robotId: string, db: DbLike = getDb()): Promise<Robot> {
  assertActive(user);
  const robot = await getRobot(robotId, db);
  if (!robot || !(await canAccessSite(user, robot.siteId, db))) {
    throw new NotFoundError("로봇을 찾을 수 없거나 접근 권한이 없습니다.");
  }
  return robot;
}

/** 명령 권한: 역할 + 사업장 + (고객 제어는) 명령별 부여. 순수 규칙. */
export function canCommandOf(user: User, accessible: string[], siteId: string, command: CommandType): boolean {
  if (!user.active) return false;
  if (!accessible.includes(siteId)) return false;
  switch (user.role) {
    case "HQ_ADMIN":
    case "SITE_MANAGER":
      return true;
    case "CUSTOMER_CONTROL": {
      const perm = user.sitePermissions.find((p) => p.siteId === siteId);
      return !!perm && perm.allowedCommands.includes(command);
    }
    case "CUSTOMER_BASIC":
    default:
      return false;
  }
}

export async function canCommand(user: User, siteId: string, command: CommandType, db: DbLike = getDb()): Promise<boolean> {
  return canCommandOf(user, await accessibleSiteIds(user, db), siteId, command);
}

export async function assertCommandAllowed(user: User, siteId: string, command: CommandType, db: DbLike = getDb()): Promise<void> {
  assertActive(user);
  if (!(await canCommand(user, siteId, command, db))) {
    throw new ForbiddenError("이 명령을 실행할 권한이 없습니다.");
  }
}

export function canHandleIncidents(user: User): boolean {
  return user.active && isStaff(user);
}

export function canEditReports(user: User): boolean {
  return user.active && isStaff(user);
}

export function canConfirmReportsOf(user: User, siteManagerCanConfirm: boolean): boolean {
  if (!user.active) return false;
  if (user.role === "HQ_ADMIN") return true;
  if (user.role === "SITE_MANAGER") return siteManagerCanConfirm;
  return false;
}

export async function canConfirmReports(user: User, db: DbLike = getDb()): Promise<boolean> {
  return canConfirmReportsOf(user, (await loadSettings(db)).siteManagerCanConfirmReports);
}

export function canAdmin(user: Pick<User, "role" | "active">): boolean {
  return user.active && user.role === "HQ_ADMIN";
}

export function assertAdmin(user: User): void {
  if (!canAdmin(user)) throw new ForbiddenError("관리 설정은 본사 관리자만 변경할 수 있습니다.");
}

export const ROLES: Role[] = ["HQ_ADMIN", "SITE_MANAGER", "CUSTOMER_BASIC", "CUSTOMER_CONTROL"];
