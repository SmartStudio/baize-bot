import type { AgentToControl, BotId, GroupId, PokerTableRole, RunId, Viewer } from "@baize/shared";
import type { Db } from "../db/client.js";
import { tableRoleOfRun } from "../repo/runs.js";

export type RunRef = { readonly runId: RunId; readonly botId: BotId; readonly groupId: GroupId };

type UplinkKind = AgentToControl["type"];

/**
 * 牌桌 run 能发哪些上行，默认拒绝：没列在这里的一律丢，不然一个牌友能往桌上插卡、@ 人、派活。
 * 牌友的 bot_text 也不在里面，公开台词只走 poker_act.say。
 */
const UPLINKS_OF_ROLE: Readonly<Record<PokerTableRole, ReadonlySet<UplinkKind>>> = {
  player: new Set<UplinkKind>(["poker_act", "run_done"]),
  advisor: new Set<UplinkKind>(["bot_text", "bot_text_done", "run_done"]),
  reviewer: new Set<UplinkKind>(["poker_review", "run_done"]),
};

/** 普通 run（runs.table_role 为空）全部放行；run 行不存在不放行。 */
export async function isUplinkAllowed(db: Db, run: RunRef, kind: UplinkKind): Promise<boolean> {
  const found = await tableRoleOfRun(db, run.runId);
  switch (found.kind) {
    case "missing":
      return false;
    case "plain":
      return true;
    case "table":
      return UPLINKS_OF_ROLE[found.role].has(kind);
  }
}

/** 老白回答问牌的 bot_text 只有用户看得到，牌友 Bot 下一次的 prompt 里不能出现它。普通 run 的文字全群可见。 */
const BOT_TEXT_VISIBLE_TO: Readonly<Partial<Record<PokerTableRole, readonly Viewer[]>>> = {
  advisor: [{ kind: "user" }],
};

export async function botTextVisibility(db: Db, runId: RunId): Promise<Viewer[] | null> {
  const found = await tableRoleOfRun(db, runId);
  if (found.kind !== "table") return null;
  const visibleTo = BOT_TEXT_VISIBLE_TO[found.role];
  return visibleTo === undefined ? null : [...visibleTo];
}
