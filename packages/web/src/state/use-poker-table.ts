import { useEffect, useState } from "react";
import type { GroupId } from "@baize/shared";
import { useApp } from "./app.js";

export type PokerTableLoad = "loading" | "ready" | "failed";

// 牌桌视图只在 store 里有一份，这里只管什么时候去拉、拉的结果如何。进页面第一眼不能等推送，先拉一次；
// 重连后推送可能漏了，reconnectedAt 一变再拉一次。拉回来的和推送一样走 poker_table_set，旧版本盖不上新版本。
export const usePokerTableLoad = (groupId: GroupId) => {
  const { state, actions } = useApp();
  const reconnectedAt = state.status === "ready" ? state.reconnectedAt : 0;
  const [reloads, setReloads] = useState(0);
  const [outcome, setOutcome] = useState<{ key: string; status: "ready" | "failed" } | null>(null);
  const key = `${groupId}:${reconnectedAt}:${reloads}`;

  useEffect(() => {
    let current = true;
    actions.loadPokerTable(groupId).then(
      (found) => {
        if (current && found !== undefined) setOutcome({ key, status: found ? "ready" : "failed" });
      },
      () => {
        if (current) setOutcome({ key, status: "failed" });
      },
    );
    return () => {
      current = false;
    };
  }, [actions, groupId, key]);

  const load: PokerTableLoad = outcome?.key === key ? outcome.status : "loading";
  return { load, reload: () => setReloads((count) => count + 1) };
};
