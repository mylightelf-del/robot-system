import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { errorText } from "./api";

/**
 * 화면용 조회 훅: 화면이 보일 때 불러오고, 보이는 동안 intervalMs(기본 30초)마다 갱신한다(웹의 AutoRefresh 와 같은 역할).
 * 당겨서 새로 고침·재시도용 reload 를 돌려준다. 백그라운드에서는 갱신하지 않는다.
 */
export function useFetch<T>(fn: () => Promise<T>, deps: unknown[], opts: { intervalMs?: number | null } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  // 의존값이 바뀌면(사업장·필터 등) 다시 불러온다. 배열 리터럴 규칙 때문에 문자열 키로 비교한다.
  const key = JSON.stringify(deps);

  const load = useCallback(async (mode: "refresh" | "silent" = "silent") => {
    if (mode === "refresh") setRefreshing(true);
    try {
      const d = await fnRef.current();
      setData(d);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // 처음 보일 때(마운트 포함)와 다시 돌아올 때 불러오고, 보이는 동안 주기 갱신한다.
  useFocusEffect(
    useCallback(() => {
      void load("silent");
      if (opts.intervalMs === null) return undefined;
      const t = setInterval(() => void load("silent"), opts.intervalMs ?? 30_000);
      return () => clearInterval(t);
    }, [load, opts.intervalMs]),
  );

  return { data, error, loading, refreshing, reload: () => load("refresh"), reloadSilent: () => load("silent") };
}
