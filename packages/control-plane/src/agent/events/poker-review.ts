import type { AgentToControl } from "@baize/shared";
import type { AgentEventDeps } from "../events.js";
import type { AgentConnection } from "../hub.js";

export type PokerReviewEvent = Extract<AgentToControl, { type: "poker_review" }>;

/**
 * 老白交复盘。单元 10 实现：校验 run 是这场的 reviewer run、session 已散，
 * 写 poker_sessions.review，推 poker_table_updated。
 */
export async function handlePokerReview(
  deps: AgentEventDeps,
  conn: AgentConnection,
  event: PokerReviewEvent,
): Promise<void> {
  void deps;
  void conn;
  void event;
  throw new Error("未实现");
}
