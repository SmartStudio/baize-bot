import type { PokerTableView } from "@baize/shared";

// 第 3 期形状提交的空状态：按群存牌桌视图，一手脚本归单元 6。
export const pokerTables = new Map<string, PokerTableView>();

export const resetPoker = (): void => {
  pokerTables.clear();
};
