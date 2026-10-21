import { BotId, type AgentToControl, type Message } from "@baize/shared";
import { and, count, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { messages, pokerActReceipts, pokerHands, runs, type PokerActResult } from "../../db/schema.js";
import { apply } from "../../poker/engine.js";
import { talkRevealsCards } from "../../poker/narrate.js";
import { converge, pushMessages, pushTable } from "../../poker/converge.js";
import { appendEvents, loadHand, withTableLock } from "../../poker/store.js";
import { appendMessage, messageVisibleTo } from "../../repo/messages.js";
import type { AgentEventDeps } from "../events.js";
import type { AgentConnection } from "../hub.js";

/** 每个牌友一手牌最多在群里说这么多句，超出的台词丢掉，动作照常落。 */
export const BOT_LINES_PER_HAND = 2;

/** 这个牌友从开手到现在在群里说过几句。读的是用户能看到的那些。 */
async function linesThisHand(db: Db, groupId: string, botId: BotId, handStartedAt: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(messages)
    .where(
      and(
        eq(messages.groupId, groupId),
        sql`${messages.body} ->> 'kind' = 'bot'`,
        sql`${messages.body} ->> 'botId' = ${botId}`,
        gte(messages.createdAt, handStartedAt),
        messageVisibleTo({ kind: "user" }),
      ),
    );
  return row?.n ?? 0;
}

export type PokerActEvent = Extract<AgentToControl, { type: "poker_act" }>;
export async function handlePokerAct(deps: AgentEventDeps, conn: AgentConnection, event: PokerActEvent): Promise<void> {
  const initial = await loadHand(deps.db, event.handId);
  if (!initial) return;
  const outcome = await withTableLock(deps.db, initial.row.groupId, async (db, table) => {
    const hand = await loadHand(db, event.handId);
    const [run] = await db.select().from(runs).where(eq(runs.id, event.runId));
    if (
      !hand ||
      table.ownerId !== conn.ownerId ||
      !run?.botId ||
      run.groupId !== table.groupId ||
      run.computerId !== conn.computerId ||
      run.tableRole !== "player" ||
      !hand.row.seatsStart.some((seat) => seat.botId === run.botId)
    )
      return null;

    // 首次回执和动作同事务落库。主键认领挡重复帧，重启后重复的帧读回同一个结果。
    const receipt = and(eq(pokerActReceipts.runId, event.runId), eq(pokerActReceipts.callId, event.callId));
    const [claimed] = await db
      .insert(pokerActReceipts)
      .values({ runId: event.runId, callId: event.callId, result: null })
      .onConflictDoNothing()
      .returning();
    if (!claimed) {
      const [saved] = await db.select({ result: pokerActReceipts.result }).from(pokerActReceipts).where(receipt);
      if (!saved?.result) throw new Error("出牌回执记录不完整");
      return { ownerId: table.ownerId, messages: [] as Message[], result: saved.result, advance: false };
    }
    const reply = async (result: PokerActResult, posted: Message[] = [], advance = false) => {
      await db.update(pokerActReceipts).set({ result }).where(receipt);
      return { ownerId: table.ownerId, messages: posted, result, advance };
    };
    if (
      hand.row.status !== "playing" ||
      hand.row.turnRunId !== event.runId ||
      run.endedAt !== null ||
      hand.state.phase.kind !== "betting"
    )
      return reply({ ok: false, error: "这个决策点已经结束，不用再出牌。" });
    if (hand.state.events.length !== event.seq)
      return reply({ ok: false, error: "出牌序号已过期，请按最新决策点出牌。" });
    const actor = hand.state.phase.pending[0];
    const seat = table.seats.find((candidate) => String(candidate.seat) === actor);
    if (!seat?.botId || hand.row.turnSeat !== seat.seat || run.botId !== seat.botId)
      return reply({ ok: false, error: "已经不在这个牌友的决策点，不用再出牌。" });
    let state;
    try {
      state = apply(hand.state, actor!, event.action);
    } catch (error) {
      await db
        .update(pokerHands)
        .set({ turnAttempts: sql`${pokerHands.turnAttempts} + 1` })
        .where(eq(pokerHands.id, event.handId));
      return reply({ ok: false, error: error instanceof Error ? error.message : "出牌无效" }, [], true);
    }
    // 点名牌的台词整句丢掉，真话假话一样处理。台词排在这一下引起的老白播报前面；只有被接受的动作带的台词才上桌，所以一手结算之后不会再有牌友说话。
    const botId = BotId.parse(seat.botId);
    const said: Message[] = [];
    if (
      event.say?.trim() &&
      !talkRevealsCards(event.say, hand.state.board) &&
      (await linesThisHand(db, table.groupId, botId, hand.row.createdAt)) < BOT_LINES_PER_HAND
    )
      said.push(await appendMessage(db, table.groupId, { kind: "bot", botId, text: event.say, streaming: false }));
    said.push(...(await appendEvents(db, table, hand, state)));
    return reply({ ok: true }, said, true);
  });
  if (!outcome) return;
  deps.agents.send(conn.computerId, {
    type: "poker_result",
    runId: event.runId,
    callId: event.callId,
    result: outcome.result,
  });
  pushMessages(deps, outcome.ownerId, outcome.messages);
  if (outcome.advance) {
    const advance = async (real: AgentEventDeps) => {
      await converge(real, event.handId);
      if (outcome.result.ok) await pushTable(real, initial.row.groupId);
    };
    if (deps.afterCommit !== undefined) deps.afterCommit(advance);
    else await advance(deps);
  }
}
