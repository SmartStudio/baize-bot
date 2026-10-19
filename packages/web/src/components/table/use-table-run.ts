import { useState } from "react";
import type { GroupId } from "@baize/shared";
import { useNavigate } from "react-router-dom";
import { RequestFailed } from "../../api/client.js";
import { useApp } from "../../state/app.js";
import { pathOf } from "../../routes/screen.js";

export type TableRun = "start" | "leave";

// 开一手和散场在牌桌页上不止一处能点（页头、桌上空着时、一手打完的结束卡），共用同一份忙闲和报错。
export const useTableRun = (groupId: GroupId) => {
  const navigate = useNavigate();
  const { actions } = useApp();
  const [busy, setBusy] = useState<TableRun | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async (kind: TableRun) => {
    setBusy(kind);
    setFailure(null);
    try {
      if (kind === "start") await actions.startPokerHand(groupId);
      else {
        const left = await actions.leavePokerTable(groupId);
        if (left !== undefined) navigate(pathOf({ kind: "project", groupId: left }));
      }
    } catch (cause) {
      setFailure(cause instanceof RequestFailed ? cause.message : "没成，再试一次");
    } finally {
      setBusy(null);
    }
  };

  return { busy, failure, run };
};
