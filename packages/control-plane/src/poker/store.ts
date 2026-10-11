import type { GroupId, PokerTableView } from "@baize/shared";
import type { Db } from "../db/client.js";

/** 桌面视图里「正在打的这手」那一截，和 PokerTableView.hand 同形。 */
export type CurrentHand = NonNullable<PokerTableView["hand"]>;

/**
 * 这张桌正在打的那手牌，用户视角。没有在打的回 null。
 * S3 桩恒回 null。单元 7 实现：按 poker_hands 里 status = 'playing' 的那行 replay 出 viewFor(4 号位)。
 */
export async function currentHandOf(db: Db, tableId: GroupId): Promise<CurrentHand | null> {
  void db;
  void tableId;
  return null;
}

/**
 * 牌桌群里用户不能发普通消息，只能按按钮出牌。是牌桌就抛 TableGroupError，路由做成 409。
 * S3 桩不抛。单元 7 填：查 poker_tables 有没有这个 group_id。
 */
export class TableGroupError extends Error {
  constructor() {
    super("牌桌里请用按钮出牌");
    this.name = "TableGroupError";
  }
}

export async function assertNotTable(db: Db, groupId: GroupId): Promise<void> {
  void db;
  void groupId;
}
