import type { CommandType, Robot, User } from "@/lib/domain/types";
import type { StoreData } from "@/lib/store/data";
import { ForbiddenError, NotFoundError } from "@/lib/util/errors";

/**
 * 인가 규칙 — 모든 목록·상세·지도·명령·보고서 접근은 서버의 이 함수들을 통과해야 한다.
 * UI 에서 숨기는 것만으로 권한 구현을 완료 처리하지 않는다.
 */

export function assertActive(user: User): void {
  if (!user.active) throw new ForbiddenError("비활성화된 사용자입니다. 접근이 차단되었습니다.");
}

export function isCustomer(user: User): boolean {
  return user.role === "CUSTOMER_BASIC" || user.role === "CUSTOMER_CONTROL";
}

export function isStaff(user: User): boolean {
  return user.role === "HQ_ADMIN" || user.role === "SITE_MANAGER";
}

/** 사용자가 조회할 수 있는 사업장 ID. 본사 관리자는 권한이 비어 있으면 전체. */
export function accessibleSiteIds(data: StoreData, user: User): string[] {
  if (!user.active) return [];
  if (user.role === "HQ_ADMIN" && user.sitePermissions.length === 0) return data.sites.map((s) => s.id);
  return user.sitePermissions.map((p) => p.siteId).filter((id) => data.sites.some((s) => s.id === id));
}

export function canAccessSite(data: StoreData, user: User, siteId: string): boolean {
  return accessibleSiteIds(data, user).includes(siteId);
}

export function assertSiteAccess(data: StoreData, user: User, siteId: string): void {
  assertActive(user);
  if (!canAccessSite(data, user, siteId)) {
    // 존재 여부를 노출하지 않기 위해 동일 메시지를 사용한다.
    throw new ForbiddenError("해당 사업장에 대한 접근 권한이 없습니다.");
  }
}

/** 로봇 ID 로 접근할 때 로봇의 현재 사업장 범위를 검증한다(URL 조작 차단). */
export function assertRobotAccess(data: StoreData, user: User, robotId: string): Robot {
  assertActive(user);
  const robot = data.robots.find((r) => r.id === robotId);
  if (!robot || !canAccessSite(data, user, robot.siteId)) {
    throw new NotFoundError("로봇을 찾을 수 없거나 접근 권한이 없습니다.");
  }
  return robot;
}

/** 명령 권한: 역할 + 사업장 + (고객 제어는) 명령별 부여. */
export function canCommand(data: StoreData, user: User, siteId: string, command: CommandType): boolean {
  if (!user.active) return false;
  if (!canAccessSite(data, user, siteId)) return false;
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

export function assertCommandAllowed(data: StoreData, user: User, siteId: string, command: CommandType): void {
  assertActive(user);
  if (!canCommand(data, user, siteId, command)) {
    throw new ForbiddenError("이 명령을 실행할 권한이 없습니다.");
  }
}

export function canHandleIncidents(user: User): boolean {
  return user.active && isStaff(user);
}

export function canEditReports(user: User): boolean {
  return user.active && isStaff(user);
}

export function canConfirmReports(data: StoreData, user: User): boolean {
  if (!user.active) return false;
  if (user.role === "HQ_ADMIN") return true;
  if (user.role === "SITE_MANAGER") return data.settings.siteManagerCanConfirmReports;
  return false;
}

export function canAdmin(user: User): boolean {
  return user.active && user.role === "HQ_ADMIN";
}

export function assertAdmin(user: User): void {
  if (!canAdmin(user)) throw new ForbiddenError("관리 설정은 본사 관리자만 변경할 수 있습니다.");
}
