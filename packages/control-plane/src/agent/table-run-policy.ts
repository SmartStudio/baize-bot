import type { AgentToControl, BotId, GroupId, RunId } from "@baize/shared";
import type { Db } from "../db/client.js";

export type RunRef = { readonly runId: RunId; readonly botId: BotId; readonly groupId: GroupId };

/**
 * 牌桌 run 能发哪些上行。牌友（player）只能 poker_act，老白（advisor、reviewer）只能说话和交复盘，
 * 其余报文（mention、handoff、skill_offer 这些）在牌桌上一律丢掉，不然一个牌友能往桌上插卡、@ 人、派活。
 * 普通 run（runs.table_role 为 null）全部放行。
 * S3 桩恒回 true。单元 2 实现：按 runs.table_role 查表决定。
 */
export async function isUplinkAllowed(db: Db, run: RunRef, kind: AgentToControl["type"]): Promise<boolean> {
  void db;
  void run;
  void kind;
  return true;
}
