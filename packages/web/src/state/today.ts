import { useCallback, useEffect, useRef, useState } from "react";
import type { TodayResponse } from "@baize/shared";
import { useApp } from "./app.js";

type TodayLoad =
  | { status: "loading"; data: null; error: null }
  | { status: "ready"; data: TodayResponse; error: string | null }
  | { status: "failed"; data: null; error: string };

type Flight = { state: "idle" } | { state: "running" | "rerun"; drained: Promise<void> };

const REFRESH_DEBOUNCE_MS = 100;
const LOAD_ERROR = "今天的清单没取到。";
const REFRESH_ERROR = "今天的清单刷新失败。";

export const useToday = () => {
  const { state, actions } = useApp();
  const loadToday = actions.loadToday;
  const todayVersion = state.status === "ready" ? state.todayVersion : 0;
  const [load, setLoad] = useState<TodayLoad>({ status: "loading", data: null, error: null });
  // 同一时刻只让一个 today 请求在途；在途时再来的触发只记成 rerun，落定后最多补拉一次。
  // drained 在这一串请求全部排空后落定，调用方 await refresh() 等的就是它。
  const flight = useRef<Flight>({ state: "idle" });
  const latestLoad = useRef(loadToday);
  const mounted = useRef(true);
  const firstLoad = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const drain = useCallback(async () => {
    for (;;) {
      setLoad((current) =>
        current.data === null ? { status: "loading", data: null, error: null } : { ...current, error: null },
      );
      const result = await latestLoad.current().then(
        (data) => ({ ok: true, data }) as const,
        () => ({ ok: false }) as const,
      );
      const settled = flight.current;
      if (!mounted.current) break;
      // 落定时已记 rerun，这趟回包已经落后，成功失败都不上屏，直接补拉。
      if (settled.state === "rerun") {
        flight.current = { state: "running", drained: settled.drained };
        continue;
      }
      if (!result.ok)
        setLoad((load) =>
          load.data === null
            ? { status: "failed", data: null, error: LOAD_ERROR }
            : { status: "ready", data: load.data, error: REFRESH_ERROR },
        );
      else if (result.data !== undefined) setLoad({ status: "ready", data: result.data, error: null });
      break;
    }
    flight.current = { state: "idle" };
  }, []);

  const refresh = useCallback((): Promise<void> => {
    const current = flight.current;
    if (current.state !== "idle") {
      flight.current = { state: "rerun", drained: current.drained };
      return current.drained;
    }
    const drained = drain();
    flight.current = { state: "running", drained };
    return drained;
  }, [drain]);

  useEffect(() => {
    latestLoad.current = loadToday;
    const delay = firstLoad.current ? 0 : REFRESH_DEBOUNCE_MS;
    firstLoad.current = false;
    const timer = setTimeout(() => void refresh(), delay);
    return () => clearTimeout(timer);
  }, [loadToday, refresh, todayVersion]);

  return { ...load, refresh };
};

export type Today = ReturnType<typeof useToday>;
