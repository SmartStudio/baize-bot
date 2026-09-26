import { useCallback, useEffect, useRef, useState } from "react";
import type { TodayResponse } from "@baize/shared";
import { useApp } from "./app.js";

type TodayLoad =
  | { status: "loading"; data: null; error: null }
  | { status: "ready"; data: TodayResponse; error: string | null }
  | { status: "failed"; data: null; error: string };

const REFRESH_DEBOUNCE_MS = 100;
const LOAD_ERROR = "今天的清单没取到。";
const REFRESH_ERROR = "今天的清单刷新失败。";

export const pendingCountOf = (data: TodayResponse): number => data.pending.length;

export const useToday = () => {
  const { state, actions } = useApp();
  const loadToday = actions.loadToday;
  const todayVersion = state.status === "ready" ? state.todayVersion : 0;
  const [load, setLoad] = useState<TodayLoad>({ status: "loading", data: null, error: null });
  const requestVersion = useRef(0);
  const mounted = useRef(true);
  const firstLoad = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fetchToday = useCallback(async () => {
    const currentRequest = requestVersion.current + 1;
    requestVersion.current = currentRequest;
    setLoad((current) =>
      current.data === null ? { status: "loading", data: null, error: null } : { ...current, error: null },
    );
    try {
      const data = await loadToday();
      if (data === undefined) return;
      if (mounted.current && requestVersion.current === currentRequest) setLoad({ status: "ready", data, error: null });
    } catch {
      if (!mounted.current || requestVersion.current !== currentRequest) return;
      setLoad((current) =>
        current.data === null
          ? { status: "failed", data: null, error: LOAD_ERROR }
          : { status: "ready", data: current.data, error: REFRESH_ERROR },
      );
    }
  }, [loadToday]);

  useEffect(() => {
    const delay = firstLoad.current ? 0 : REFRESH_DEBOUNCE_MS;
    firstLoad.current = false;
    const timer = setTimeout(() => void fetchToday(), delay);
    return () => clearTimeout(timer);
  }, [fetchToday, todayVersion]);

  return { ...load, refresh: fetchToday };
};

export type Today = ReturnType<typeof useToday>;
