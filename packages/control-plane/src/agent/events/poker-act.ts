import type { AgentToControl } from "@baize/shared";
import type { AgentEventDeps } from "../events.js";
import type { AgentConnection } from "../hub.js";

export type PokerActEvent = Extract<AgentToControl, { type: "poker_act" }>;

/**
 * 牌友出一手。单元 7 实现：校验 run 是这个座位当前轮到的那次、seq 没过期，过引擎 apply，
 * 写 poker_events，回 poker_result，推 poker_table_updated，轮到下一个座位就派下一条 prompt。
 */
export async function handlePokerAct(deps: AgentEventDeps, conn: AgentConnection, event: PokerActEvent): Promise<void> {
  void deps;
  void conn;
  void event;
  throw new Error("未实现");
}
