import type { GroupId, PokerTableView } from "@baize/shared";
import type { Action, ReadyState } from "./types.js";

// 一张桌一份整视图，推送和接口回的都是整份，都走 poker_table_set。控制面的广播不保证按版本先后到，
// 版本不比手上新的一律丢掉，晚到的旧版才盖不回来。这一行守卫是契约的一部分，poker.test.ts 钉着它。
export const reducePoker = (state: ReadyState, action: Action): ReadyState => {
  if (action.type !== "poker_table_set") return state;
  const known = state.poker[action.table.groupId];
  if (known !== undefined && action.table.version <= known.version) return state;
  return { ...state, poker: { ...state.poker, [action.table.groupId]: action.table } };
};

export const pokerTableOf = (state: ReadyState, groupId: GroupId): PokerTableView | undefined => state.poker[groupId];

// 牌桌群在用户这边只有拉过或推过视图之后才认得出来。进项目页先拉一次视图归单元 13。
export const isPokerTable = (state: ReadyState, groupId: GroupId): boolean =>
  pokerTableOf(state, groupId) !== undefined;
