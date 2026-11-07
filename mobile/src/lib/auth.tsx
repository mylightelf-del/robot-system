import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as SecureStore from "expo-secure-store";
import * as Device from "expo-device";
import { api, setAuthToken, setUnauthorizedHandler, type LoginResponse, type MeResponse, type PublicUser } from "./api";
import { DEFAULT_API_BASE, setApiBase } from "./config";
import { registerPushDevice, unregisterPushDevice } from "./push";

/**
 * 로그인 상태. 토큰은 안드로이드 Keystore 기반 암호 저장소(expo-secure-store)에만 둔다.
 * 앱 시작 시 저장된 토큰으로 /me 를 불러 유효성을 확인하고, 401 이면 토큰을 지운다(기기 끊김·비활성화·만료).
 */
const TOKEN_KEY = "widebot.token";
const BASE_KEY = "widebot.apiBase";

interface AuthState {
  loading: boolean;
  user: PublicUser | null;
  me: MeResponse | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
  apiBaseUrl: string;
  changeApiBase: (url: string) => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function deviceLabel(): string {
  const parts = [Device.manufacturer, Device.modelName].filter(Boolean);
  return parts.length ? parts.join(" ") : "Android 기기";
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [apiBaseUrl, setApiBaseUrl] = useState(DEFAULT_API_BASE);
  const tokenRef = useRef<string | null>(null);

  const clear = useCallback(async () => {
    tokenRef.current = null;
    setAuthToken(null);
    setMe(null);
    await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
  }, []);

  const refreshMe = useCallback(async () => {
    const m = await api<MeResponse>("GET", "/me");
    setMe(m);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      void clear();
    });
    (async () => {
      try {
        const base = await SecureStore.getItemAsync(BASE_KEY).catch(() => null);
        if (base) {
          setApiBase(base);
          setApiBaseUrl(base);
        }
        const t = await SecureStore.getItemAsync(TOKEN_KEY).catch(() => null);
        if (t) {
          tokenRef.current = t;
          setAuthToken(t);
          await refreshMe();
          // 토큰이 바뀌었을 수 있으니 시작할 때마다 푸시 기기를 다시 등록한다(실패해도 화면은 뜬다)
          registerPushDevice().catch(() => {});
        }
      } catch {
        // /me 실패(네트워크 등): 토큰은 유지하고 화면에서 다시 시도
      } finally {
        setLoading(false);
      }
    })();
  }, [clear, refreshMe]);

  const login = useCallback(
    async (email: string, password: string) => {
      const r = await api<LoginResponse>("POST", "/auth/login", { email, password, deviceName: deviceLabel() }, { auth: false });
      tokenRef.current = r.token;
      setAuthToken(r.token);
      await SecureStore.setItemAsync(TOKEN_KEY, r.token);
      await refreshMe();
      registerPushDevice().catch(() => {});
    },
    [refreshMe],
  );

  const logout = useCallback(async () => {
    try {
      await unregisterPushDevice().catch(() => {});
      await api("POST", "/auth/logout");
    } catch {
      // 서버에 못 닿아도 로컬 토큰은 지운다. 서버 세션은 만료되거나 내 계정(웹)에서 끊을 수 있다.
    }
    await clear();
  }, [clear]);

  const changeApiBase = useCallback(
    async (url: string) => {
      const v = url.trim().replace(/\/+$/, "");
      if (!/^https:\/\/[^\s]+$/.test(v) && !/^http:\/\/(10\.|192\.168\.|127\.|localhost)/.test(v)) throw new Error("https:// 주소만 쓸 수 있습니다(개발용 사설망 http 제외).");
      await clear();
      setApiBase(v);
      setApiBaseUrl(v);
      if (v === DEFAULT_API_BASE) await SecureStore.deleteItemAsync(BASE_KEY).catch(() => {});
      else await SecureStore.setItemAsync(BASE_KEY, v);
    },
    [clear],
  );

  const value = useMemo<AuthState>(() => ({ loading, user: me?.user ?? null, me, login, logout, refreshMe, apiBaseUrl, changeApiBase }), [loading, me, login, logout, refreshMe, apiBaseUrl, changeApiBase]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("AuthProvider 밖에서 useAuth 를 호출했습니다.");
  return v;
}
