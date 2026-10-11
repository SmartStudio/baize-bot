import {
  BotId,
  GroupId,
  PokerEvent,
  PokerHandId,
  PokerSessionId,
  UserId,
  type Message,
  type PokerTableView,
} from "@baize/shared";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { Db } from "../db/client.js";
import { bots, groupMembers, pokerEvents, pokerHands, pokerSessions, pokerTables } from "../db/schema.js";
import { newId } from "../ids.js";
import { appendMessage } from "../repo/messages.js";
import { lockOwner } from "../repo/runs.js";
import { newHand, replay, type HandState } from "./engine.js";
import { narrate } from "./narrate.js";
import { hintOf } from "./hint.js";
import { engineSeatId, seatNextHand } from "./seating.js";
import { buildTableView, type TableState } from "./table-view.js";

export type TableRow = typeof pokerTables.$inferSelect;
export type HandRow = typeof pokerHands.$inferSelect;
export type StoredHand = { row: HandRow; state: HandState };
export type CurrentHand = NonNullable<PokerTableView["hand"]>;

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
export async function latestHand(db: Db, groupId: string, playingOnly = false): Promise<StoredHand | null> {
  const [row] = await db
    .select()
    .from(pokerHands)
    .where(and(eq(pokerHands.groupId, groupId), playingOnly ? eq(pokerHands.status, "playing") : undefined))
    .orderBy(desc(pokerHands.number))
    .limit(1);
  return row ? restoreHand(db, row) : null;
}

export async function tableState(db: Db, table: TableRow): Promise<TableState> {
  const members = await db
    .select({ bot: bots })
    .from(groupMembers)
    .innerJoin(bots, eq(bots.id, groupMembers.botId))
    .where(eq(groupMembers.groupId, table.groupId));
  const host = members.find(({ bot }) => bot.preset === "laobai")?.bot;
  if (!host) throw new Error("牌桌没有老白");
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
    const { state } = await restoreHand(db, row);
    const delta =
      (state.seats.find((seat) => seat.id === "4")?.stack ?? 0) -
      (row.seatsStart.find((seat) => seat.seat === 4)?.stack ?? 0);
    netBySession.set(row.sessionId, (netBySession.get(row.sessionId) ?? 0) + delta);
  }
  const open = sessions.find((session) => session.endedAt === null);
  const ended = sessions.filter((session) => session.endedAt !== null);
  const [counts] = open
    ? await db
        .select({ value: sql<number>`count(*)::int` })
        .from(pokerHands)
        .where(eq(pokerHands.sessionId, open.id))
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
        kind: seat.botId === null ? "user" : "bot",
        botId: bot ? BotId.parse(bot.id) : null,
        name: bot?.name ?? "你",
        persona: bot?.preset ?? null,
        hue: bot?.hue ?? "sky",
        stack: seat.stack,
      };
    }),
    host: { botId: BotId.parse(host.id), name: host.name, hue: host.hue },
    session: open
      ? { id: PokerSessionId.parse(open.id), handCount: counts?.value ?? 0, net: netBySession.get(open.id) ?? 0 }
      : null,
    hint: await hintOf(db, table.groupId),
    lastReview: ended.find((session) => session.review !== null)?.review ?? null,
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
    4,
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
  for (const event of added)
    messages.push(
      await hostMessage(
        db,
        table,
        narrate(event, (id) => names.find((seat) => engineSeatId(seat.seat) === id)?.name ?? id),
      ),
    );
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
  for (const event of state.events)
    messages.push(
      await hostMessage(
        db,
        table,
        narrate(event, (id) => names.find((seat) => engineSeatId(seat.seat) === id)?.name ?? id),
      ),
    );
  return { handId, messages };
}
