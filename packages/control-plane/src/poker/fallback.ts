import type { Action, LegalActions } from "./engine.js";

/** 牌友超时或连着出非法动作后替它出的牌：能过牌就过牌，否则弃牌。不会替它投一个筹码。 */
export function fallbackAction(legal: LegalActions): Action {
  if (legal.kind !== "your_turn") throw new Error("没有轮到这个座位，不能兜底");
  return legal.options.some((option) => option.kind === "check") ? { kind: "check" } : { kind: "fold" };
}
