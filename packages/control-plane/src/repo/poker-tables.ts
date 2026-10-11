import {
  BotId,
  GroupId,
  POKER_PERSONAS,
  POKER_USER_SEAT,
  PokerPersona,
  type Group,
  type Message,
  type PokerSeatNo,
  type PokerTableView,
  type TopicTask,
  type UserId,
} from "@baize/shared";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bots, groups, pokerTables, type StoredPokerSeat } from "../db/schema.js";
import { newId } from "../ids.js";
import { loadTable, snapshot } from "../poker/store.js";
import { openGroup, swapGroupMember } from "./groups.js";
import { appendMessage } from "./messages.js";
import { lockOwner } from "./runs.js";

export const DEFAULT_TABLE_TITLE = "周末德州";
export const SMALL_BLIND = 10;
export const BIG_BLIND = 20;
export const STARTING_STACK = 2000;
/** 默认三位牌友，按座位 1 到 3 排（D22）。 */
export const DEFAULT_OPPONENTS: readonly PokerPersona[] = ["leopard", "old_k", "jasmine"];

export type CreateTableResult = {
  readonly groupId: GroupId;
  /** 这次真的建了才有；requestId 重复回原来那张桌时是 null。 */
  readonly opened: { readonly group: Group; readonly task: TopicTask } | null;
};

class RequestAlreadyUsed extends Error {}

/**
 * 建桌：群、主题任务、成员、poker_tables 一个事务。幂等靠 (owner_id, request_id) 的唯一索引：
 * 撞上就回滚这次开的群，再读原来那张。预置牌友要先由调用方 ensurePokerPresets。
 */
export async function createPokerTable(db: Db, ownerId: UserId, requestId: string): Promise<CreateTableResult> {
  try {
    return await db.transaction(async (tx): Promise<CreateTableResult> => {
      await lockOwner(tx, ownerId, "shared");
      const presets = await tx
        .select({ id: bots.id, preset: bots.preset })
        .from(bots)
        .where(and(eq(bots.ownerId, ownerId), isNotNull(bots.preset)));
      const idOf = (persona: PokerPersona): BotId => {
        const found = presets.find((row) => row.preset === persona);
        if (found === undefined) throw new Error(`${POKER_PERSONAS[persona].name} 还没建出来`);
        return BotId.parse(found.id);
      };
      const opponentIds = DEFAULT_OPPONENTS.map(idOf);
      const hostId = idOf("laobai");

      const groupId = GroupId.parse(newId());
      const opened = await openGroup(tx, ownerId, {
        id: groupId,
        title: DEFAULT_TABLE_TITLE,
        botIds: [...opponentIds, hostId],
        summary: "",
        dueAt: null,
        chiefBotId: hostId,
        cadence: "",
        checklist: [],
      });
      const seats: StoredPokerSeat[] = [
        ...opponentIds.map((botId, index) => ({
          seat: (index + 1) as PokerSeatNo,
          botId: botId as string | null,
          stack: STARTING_STACK,
        })),
        { seat: POKER_USER_SEAT, botId: null, stack: STARTING_STACK },
      ];
      // button_seat 记「上一手的庄位」。取 4 号位，第一手顺时针找到的就是 1 号位。
      const [inserted] = await tx
        .insert(pokerTables)
        .values({
          groupId,
          ownerId,
          requestId,
          seats,
          buttonSeat: POKER_USER_SEAT,
          smallBlind: SMALL_BLIND,
          bigBlind: BIG_BLIND,
          startingStack: STARTING_STACK,
        })
        .onConflictDoNothing({ target: [pokerTables.ownerId, pokerTables.requestId] })
        .returning({ groupId: pokerTables.groupId });
      if (inserted === undefined) throw new RequestAlreadyUsed();
      return { groupId, opened };
    });
  } catch (error) {
    if (!(error instanceof RequestAlreadyUsed)) throw error;
    const [existing] = await db
      .select({ groupId: pokerTables.groupId })
      .from(pokerTables)
      .where(and(eq(pokerTables.ownerId, ownerId), eq(pokerTables.requestId, requestId)));
    if (existing === undefined) throw new Error("requestId 撞了唯一索引却读不到那张桌", { cause: error });
    return { groupId: GroupId.parse(existing.groupId), opened: null };
  }
}

export type SwapResult =
  | { readonly kind: "not_found" }
  | { readonly kind: "not_a_bot_seat" }
  | { readonly kind: "in_hand" }
  | { readonly kind: "already_seated" }
  | { readonly kind: "ok"; readonly message: Message };

/**
 * 手之间换一个座位上的牌友（D27，筹码跟座位走）：群成员里同位置那行改人，poker_tables.seats 改 botId，
 * version 加一，老白留一句话。整件事锁在桌子这一行上，和开一手那条 UPDATE ... WHERE status = 'idle' 互斥。
 */
export async function swapPokerSeat(
  db: Db,
  ownerId: UserId,
  groupId: GroupId,
  seat: PokerSeatNo,
  persona: PokerPersona,
): Promise<SwapResult> {
  return db.transaction(async (tx): Promise<SwapResult> => {
    await lockOwner(tx, ownerId, "shared");
    const [table] = await tx
      .select()
      .from(pokerTables)
      .where(and(eq(pokerTables.groupId, groupId), eq(pokerTables.ownerId, ownerId)))
      .for("update");
    if (table === undefined) return { kind: "not_found" };

    const current = table.seats.find((entry) => entry.seat === seat);
    if (current === undefined || current.botId === null) return { kind: "not_a_bot_seat" };
    if (table.status === "in_hand") return { kind: "in_hand" };

    const [group] = await tx.select({ chiefBotId: groups.chiefBotId }).from(groups).where(eq(groups.id, groupId));
    const [incoming] = await tx
      .select()
      .from(bots)
      .where(and(eq(bots.ownerId, ownerId), eq(bots.preset, persona)));
    const [outgoing] = await tx.select().from(bots).where(eq(bots.id, current.botId));
    if (
      group?.chiefBotId === undefined ||
      group.chiefBotId === null ||
      incoming === undefined ||
      outgoing === undefined
    ) {
      throw new Error(`牌桌 ${groupId} 缺老白或缺要换的牌友`);
    }
    if (table.seats.some((entry) => entry.botId === incoming.id)) return { kind: "already_seated" };

    if (!(await swapGroupMember(tx, groupId, BotId.parse(outgoing.id), BotId.parse(incoming.id)))) {
      throw new Error(`${outgoing.name} 在 poker_tables.seats 里却不在群成员里`);
    }
    await tx
      .update(pokerTables)
      .set({
        seats: table.seats.map((entry) => (entry.seat === seat ? { ...entry, botId: incoming.id } : entry)),
        version: table.version + 1,
      })
      .where(eq(pokerTables.groupId, groupId));
    const message = await appendMessage(tx, groupId, {
      kind: "bot",
      botId: BotId.parse(group.chiefBotId),
      text: `${outgoing.name}下桌，${incoming.name}上桌`,
      streaming: false,
    });
    return { kind: "ok", message };
  });
}

/** 这个用户名下的牌桌，建桌时间升序。 */
export async function listPokerTableIds(db: Db, ownerId: UserId): Promise<GroupId[]> {
  const rows = await db
    .select({ groupId: pokerTables.groupId })
    .from(pokerTables)
    .where(eq(pokerTables.ownerId, ownerId))
    .orderBy(asc(pokerTables.createdAt), asc(pokerTables.groupId));
  return rows.map((row) => GroupId.parse(row.groupId));
}

/** 用户视角的整张桌，别人的桌和不存在的桌都是 null。拼装只有 poker/store.ts 一处，这里只做归属校验。 */
export async function loadPokerTableView(db: Db, ownerId: UserId, groupId: GroupId): Promise<PokerTableView | null> {
  const table = await loadTable(db, groupId);
  if (!table || table.ownerId !== ownerId) return null;
  return snapshot(db, groupId);
}
