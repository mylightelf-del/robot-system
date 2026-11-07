import Constants from "expo-constants";

/**
 * 서버 주소. 기본값은 app.json 의 extra.apiBaseUrl(운영 https://widebot.kro.kr).
 * 로그인 화면의 '서버 주소 바꾸기' 로 바꾼 값은 암호 저장소에 두고 여기서 덮어쓴다(시험 서버 접속용).
 */
export const DEFAULT_API_BASE: string = (Constants.expoConfig?.extra?.apiBaseUrl as string | undefined) ?? "https://widebot.kro.kr";

let current = DEFAULT_API_BASE;
export function apiBase(): string {
  return current;
}
export function setApiBase(url: string): void {
  current = url.replace(/\/+$/, "") || DEFAULT_API_BASE;
}

export const APP_VERSION: string = Constants.expoConfig?.version ?? "0.0.0";
/** 폰에서 보이는 시간대(사업장 시간대는 서버 응답의 site.timezone 을 우선 사용). */
export const DEFAULT_TZ = "Asia/Seoul";
