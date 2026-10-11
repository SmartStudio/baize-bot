import { useCallback, useEffect, useState } from "react";
import type { GroupId, PokerTableView } from "@baize/shared";
import { api } from "../api/client.js";
import { newerTable } from "./poker.js";

export type PokerTableLoad = "loading" | "ready" | "failed";

// store 里的牌桌只有推送来过才有，进页面第一眼不能等推送：自己拉一份放在本地，和 store 里的取版本更大的那份。
// 重连后推送可能漏了，reconnectedAt 一变就再拉一次。拉回来的和接口回的整份同样只认更大的版本。
export const usePokerTable = (groupId: GroupId, stored: PokerTableView | null, reconnectedAt: number) => {
  const [local, setLocal] = useState<PokerTableView | null>(null);
  const [outcome, setOutcome] = useState<{ key: string; status: "ready" | "failed" } | null>(null);
  const [reloads, setReloads] = useState(0);
  const key = `${groupId}:${reconnectedAt}:${reloads}`;

  const adopt = useCallback((table: PokerTableView) => {
    setLocal((known) => (known === null || known.groupId !== table.groupId ? table : newerTable(known, table)));
  }, []);

  useEffect(() => {
    let current = true;
    api
      .pokerTable(groupId)
      .then((table) => {
        if (!current) return;
        adopt(table);
        setOutcome({ key, status: "ready" });
      })
      .catch(() => {
        if (current) setOutcome({ key, status: "failed" });
      });
    return () => {
      current = false;
    };
  }, [groupId, key, adopt]);

  const mine = local !== null && local.groupId === groupId ? local : undefined;
  const table = mine === undefined ? stored : stored === null ? mine : newerTable(stored, mine);
  const load: PokerTableLoad = outcome?.key === key ? outcome.status : "loading";
  return { table, load, adopt, reload: () => setReloads((count) => count + 1) };
};
