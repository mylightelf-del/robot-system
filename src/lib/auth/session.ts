import { cookies } from "next/headers";
import type { User } from "@/lib/domain/types";
import { getStore } from "@/lib/store/store";

/**
 * 샘플 세션 (1단계 전용).
 * 쿠키 `sample_user_id` 로 샘플 사용자를 고른다. 실제 인증(로그인·비밀번호·세션 만료)은 2단계에서 구현한다.
 * ⚠ 역할 전환기는 실제 인증/인가를 대신하지 않는다. 서버 인가 규칙(authz.ts)은 이 사용자 객체를 기준으로 동작한다.
 */
export const SESSION_COOKIE = "sample_user_id";
export const DEFAULT_USER_ID = "u-hq";

export async function getCurrentUser(): Promise<User> {
  const store = getStore();
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value ?? DEFAULT_USER_ID;
  return store.users.find((u) => u.id === id) ?? store.users.find((u) => u.id === DEFAULT_USER_ID)!;
}
