import {
  BotId,
  GroupId,
  POKER_USER_SEAT,
  PokerEvent,
  PokerHandId,
  PokerSessionId,
  UserId,
  type BotHue,
  type Message,
  type PokerTableView,
} from "@baize/shared";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { Db } from "../db/client.js";
import {
  bots,
  groupMembers,
  pokerEvents,
  pokerHands,
  pokerSessions,
  pokerTables,
  runs,
  users,
  type StoredPokerHandStatus,
} from "../db/schema.js";
import { newId } from "../ids.js";
import { appendMessage } from "../repo/messages.js";
import { lockOwner } from "../repo/runs.js";
import { newHand, replay, type HandState } from "./engine.js";
import { narrate, seatNamer } from "./narrate.js";
import { hintOf } from "./hint.js";
import { engineSeatId, seatNextHand } from "./seating.js";
import { buildTableView, type TableState } from "./table-view.js";

export type TableRow = typeof pokerTables.$inferSelect;
export type HandRow = typeof pokerHands.$inferSelect;
type SessionRow = typeof pokerSessions.$inferSelect;
export type StoredHand = { row: HandRow; state: HandState };
export type CurrentHand = NonNullable<PokerTableView["hand"]>;

// 用户座位的头像色，和 Web mock 一致；牌友的色相取自人设表。
const USER_HUE: BotHue = "lime";

export class PokerError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}
export class TableGroupError extends Error {
  constructor() {
    super("牌桌里请用按钮出牌");
    this.name = "TableGroupError";
  }
}
export async function assertNotTable(db: Db, groupId: GroupId): Promise<void> {
  if (await loadTable(db, groupId)) throw new TableGroupError();
}
export async function loadTable(db: Db, groupId: string): Promise<TableRow | null> {
  const [row] = await db.select().from(pokerTables).where(eq(pokerTables.groupId, groupId));
  return row ?? null;
}

/** 所有动作、开手和扫描走同一把桌锁；事务句柄传给隐藏派活，其内部事务是 savepoint，不另占连接。 */
export async function withTableLock<T>(
  db: Db,
  groupId: string,
  run: (tx: Db, table: TableRow) => Promise<T>,
): Promise<T | null> {
  return db.transaction(async (tx) => {
    const table = await loadTable(tx as unknown as Db, groupId);
    if (!table) return null;
    await lockOwner(tx, UserId.parse(table.ownerId), "shared");
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1652199536::int4, hashtext(${groupId}::text))`);
    const [locked] = await tx.select().from(pokerTables).where(eq(pokerTables.groupId, groupId)).for("update");
    if (!locked) return null;
    // Drizzle 的事务支持 select/update/transaction；这里复用已有只接受 Db 的派活接口。
    return run(tx as unknown as Db, locked);
  });
}

export async function loadHand(db: Db, id: string): Promise<StoredHand | null> {
  const [row] = await db.select().from(pokerHands).where(eq(pokerHands.id, id));
  return row ? restoreHand(db, row) : null;
}
async function restoreHand(db: Db, row: HandRow): Promise<StoredHand> {
  const events = await db
    .select()
    .from(pokerEvents)
    .where(eq(pokerEvents.handId, row.id))
    .orderBy(asc(pokerEvents.seq));
  // jsonb 重排对象键，replay 按 JSON 字符串校验；用 shared 镜像恢复引擎的字段顺序。
  return {
    row,
    state: replay(
      row.seed,
      row.seatsStart.map((seat) => ({ id: engineSeatId(seat.seat), stack: seat.stack })),
      engineSeatId(row.buttonSeat),
      row.blinds,
      events.map((event) => PokerEvent.parse(event.event)),
    ),
  };
}
// 视图只认打着的和打完的手。扫描器作废的手（status 'abandoned'，筹码已退回）不算这桌的当前手，
// 否则视图会画出一手停在下注中、看似轮到用户的牌。
const VISIBLE_HAND_STATUSES: StoredPokerHandStatus[] = ["playing", "complete"];
export async function latestHand(db: Db, groupId: string, playingOnly = false): Promise<StoredHand | null> {
  const [row] = await db
    .select()
    .from(pokerHands)
    .where(
      and(
        eq(pokerHands.groupId, groupId),
        playingOnly ? eq(pokerHands.status, "playing") : inArray(pokerHands.status, VISIBLE_HAND_STATUSES),
      ),
    )
    .orderBy(desc(pokerHands.number))
    .limit(1);
  return row ? restoreHand(db, row) : null;
}

/** 这一手用户筹码的变化：结算后的筹码减开手时的。 */
export function userDeltaOf(hand: StoredHand): number {
  const now = hand.state.seats.find((seat) => seat.id === engineSeatId(POKER_USER_SEAT))?.stack ?? 0;
  const start = hand.row.seatsStart.find((seat) => seat.seat === POKER_USER_SEAT)?.stack ?? 0;
  return now - start;
}

/**
 * 最近一场已散场的复盘状态，全部从现有列推：复盘落了是 done；老白的 reviewer run 还开着是 generating；
 * 其余都是 failed，包括散场时没有电脑在线、复盘根本没派出去的情况。reviewer run 一桌最多一条开着，只会是这一场的。
 */
async function reviewStateOf(
  db: Db,
  groupId: string,
  latest: SessionRow | undefined,
): Promise<PokerTableView["reviewState"]> {
  if (!latest) return null;
  const sessionId = PokerSessionId.parse(latest.id);
  if (latest.review !== null) return { sessionId, status: "done" };
  const [open] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.groupId, groupId), eq(runs.tableRole, "reviewer"), isNull(runs.endedAt)))
    .limit(1);
  return { sessionId, status: open ? "generating" : "failed" };
}

/** 除了正在打的手之外的整张桌，HTTP 读视图和推送都从这里拼，用户座位用归属人的名字。 */
export async function tableState(db: Db, table: TableRow): Promise<TableState> {
  const members = await db
    .select({ bot: bots })
    .from(groupMembers)
    .innerJoin(bots, eq(bots.id, groupMembers.botId))
    .where(eq(groupMembers.groupId, table.groupId));
  const host = members.find(({ bot }) => bot.preset === "laobai")?.bot;
  if (!host) throw new Error("牌桌没有老白");
  const [owner] = await db.select({ name: users.name }).from(users).where(eq(users.id, table.ownerId));
  if (!owner) throw new Error("牌桌的归属人不存在");
  const sessions = await db
    .select()
    .from(pokerSessions)
    .where(eq(pokerSessions.groupId, table.groupId))
    .orderBy(desc(pokerSessions.startedAt));
  const hands = await db
    .select()
    .from(pokerHands)
    .where(and(eq(pokerHands.groupId, table.groupId), eq(pokerHands.status, "complete")));
  const netBySession = new Map<string, number>();
  for (const row of hands) {
    const delta = userDeltaOf(await restoreHand(db, row));
    netBySession.set(row.sessionId, (netBySession.get(row.sessionId) ?? 0) + delta);
  }
  const open = sessions.find((session) => session.endedAt === null);
  const ended = sessions.filter((session) => session.endedAt !== null);
  const [counts] = open
    ? await db
        .select({ value: sql<number>`count(*)::int` })
        .from(pokerHands)
        .where(and(eq(pokerHands.sessionId, open.id), inArray(pokerHands.status, VISIBLE_HAND_STATUSES)))
    : [];
  return {
    groupId: GroupId.parse(table.groupId),
    status: table.status,
    version: table.version,
    seats: table.seats.map((seat) => {
      const bot = members.find(({ bot: candidate }) => candidate.id === seat.botId)?.bot;
      if (seat.botId !== null && !bot) throw new Error(`座位 ${seat.seat} 的牌友不在群里`);
      return {
        seat: seat.seat,
        engineSeatId: engineSeatId(seat.seat),
        kind: seat.botId === null ? "user" : "bot",
        botId: bot ? BotId.parse(bot.id) : null,
        name: bot?.name ?? owner.name,
        persona: bot?.preset ?? null,
        hue: bot?.hue ?? USER_HUE,
        stack: seat.stack,
      };
    }),
    host: { botId: BotId.parse(host.id), name: host.name, hue: host.hue },
    session: open
      ? { id: PokerSessionId.parse(open.id), handCount: counts?.value ?? 0, net: netBySession.get(open.id) ?? 0 }
      : null,
    hint: await hintOf(db, table.groupId),
    lastReview: ended.find((session) => session.review !== null)?.review ?? null,
    reviewState: await reviewStateOf(db, table.groupId, ended[0]),
    stats: {
      sessions: ended.length,
      sessionsWon: ended.filter((session) => (netBySession.get(session.id) ?? 0) > 0).length,
      net: ended.reduce((sum, session) => sum + (netBySession.get(session.id) ?? 0), 0),
    },
  };
}
export async function tableView(db: Db, table: TableRow, hand: StoredHand | null): Promise<PokerTableView> {
  return buildTableView(
    await tableState(db, table),
    hand
      ? {
          id: PokerHandId.parse(hand.row.id),
          number: hand.row.number,
          version: hand.row.version,
          state: hand.state,
          turnDeadline: hand.row.turnDeadline,
        }
      : null,
    POKER_USER_SEAT,
  );
}
export async function snapshot(db: Db, groupId: string): Promise<PokerTableView | null> {
  return db.transaction(
    async (tx) => {
      const table = await loadTable(tx as unknown as Db, groupId);
      return table ? tableView(tx as unknown as Db, table, await latestHand(tx as unknown as Db, groupId)) : null;
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
export async function currentHandOf(db: Db, tableId: GroupId): Promise<CurrentHand | null> {
  return db.transaction(
    async (tx) => {
      const table = await loadTable(tx as unknown as Db, tableId);
      if (!table) return null;
      const hand = await latestHand(tx as unknown as Db, tableId);
      return hand ? (await tableView(tx as unknown as Db, table, hand)).hand : null;
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export async function hostMessage(db: Db, table: TableRow, text: string): Promise<Message> {
  const [host] = await db
    .select({ id: bots.id })
    .from(groupMembers)
    .innerJoin(bots, eq(bots.id, groupMembers.botId))
    .where(and(eq(groupMembers.groupId, table.groupId), eq(bots.preset, "laobai")));
  if (!host) throw new Error("牌桌没有老白");
  return appendMessage(db, table.groupId, { kind: "bot", botId: BotId.parse(host.id), text, streaming: false });
}
export async function clearTurn(db: Db, handId: string): Promise<void> {
  await db
    .update(pokerHands)
    .set({ turnSeat: null, turnRunId: null, turnAttempts: 0, turnDeadline: null })
    .where(eq(pokerHands.id, handId));
}
/** 只写引擎新增的事件，消息和版本同事务提交；每次动作都清掉上一决策点的四列。 */
export async function appendEvents(db: Db, table: TableRow, hand: StoredHand, state: HandState): Promise<Message[]> {
  const added = state.events.slice(hand.state.events.length);
  if (added.length === 0) return [];
  await db.insert(pokerEvents).values(
    added.map((event, offset) => ({
      handId: hand.row.id,
      seq: hand.state.events.length + offset,
      event,
      createdAt: new Date(),
    })),
  );
  await clearTurn(db, hand.row.id);
  await db
    .update(pokerHands)
    .set({ version: sql`${pokerHands.version} + 1` })
    .where(eq(pokerHands.id, hand.row.id));
  await db
    .update(pokerTables)
    .set({ version: sql`${pokerTables.version} + 1` })
    .where(eq(pokerTables.groupId, table.groupId));
  const names = (await tableState(db, table)).seats;
  const messages: Message[] = [];
  for (const event of added) messages.push(await hostMessage(db, table, narrate(event, seatNamer(names))));
  return messages;
}
export async function startHand(
  db: Db,
  table: TableRow,
  seed: string = randomBytes(32).toString("hex"),
): Promise<{ handId: PokerHandId; messages: Message[] }> {
  const [claimed] = await db
    .update(pokerTables)
    .set({ status: "in_hand", handCount: sql`${pokerTables.handCount} + 1`, version: sql`${pokerTables.version} + 1` })
    .where(and(eq(pokerTables.groupId, table.groupId), eq(pokerTables.status, "idle")))
    .returning();
  if (!claimed) throw new PokerError(409, "桌上已有一手牌在进行");
  const seating = seatNextHand(table.seats, table.handCount === 0 ? null : table.buttonSeat, table.startingStack);
  const seats = table.seats.map((seat) => ({
    ...seat,
    stack: seating.seats.find((next) => next.seat === seat.seat)!.stack,
  }));
  const sessionId = newId();
  await db.insert(pokerSessions).values({ id: sessionId, groupId: table.groupId }).onConflictDoNothing();
  const [session] = await db
    .select()
    .from(pokerSessions)
    .where(and(eq(pokerSessions.groupId, table.groupId), isNull(pokerSessions.endedAt)));
  if (!session) throw new Error("牌桌没有未散场的会话");
  const state = newHand(
    seed,
    seats.toSorted((a, b) => a.seat - b.seat).map((seat) => ({ id: engineSeatId(seat.seat), stack: seat.stack })),
    engineSeatId(seating.button),
    { small: table.smallBlind, big: table.bigBlind },
  );
  const handId = PokerHandId.parse(newId());
  await db.insert(pokerHands).values({
    id: handId,
    groupId: table.groupId,
    sessionId: session.id,
    number: claimed.handCount,
    seed,
    seatsStart: seats,
    buttonSeat: seating.button,
    blinds: state.blinds,
    version: 1,
    createdAt: new Date(),
  });
  await db
    .insert(pokerEvents)
    .values(state.events.map((event, seq) => ({ handId, seq, event, createdAt: new Date() })));
  await db.update(pokerTables).set({ seats, buttonSeat: seating.button }).where(eq(pokerTables.groupId, table.groupId));
  const messages: Message[] = [];
  for (const rebuy of seating.rebuys)
    messages.push(await hostMessage(db, table, `${rebuy.seat} 号位补码 ${rebuy.amount}`));
  const names = (await tableState(db, table)).seats;
  for (const event of state.events) messages.push(await hostMessage(db, table, narrate(event, seatNamer(names))));
  return { handId, messages };
}
