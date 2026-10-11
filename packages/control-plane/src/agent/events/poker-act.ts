import { BotId, type AgentToControl, type Message } from "@baize/shared";
import { and, eq, sql } from "drizzle-orm";
import { pokerActReceipts, pokerHands, runs, type PokerActResult } from "../../db/schema.js";
import { apply } from "../../poker/engine.js";
import { converge, pushMessages, pushTable } from "../../poker/converge.js";
import { appendEvents, loadHand, withTableLock } from "../../poker/store.js";
import { appendMessage } from "../../repo/messages.js";
import type { AgentEventDeps } from "../events.js";
import type { AgentConnection } from "../hub.js";

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
    const reply = async (result: PokerActResult, messages: Message[] = [], advance = false) => {
      await db.update(pokerActReceipts).set({ result }).where(receipt);
      return { ownerId: table.ownerId, messages, result, advance };
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
    const messages = await appendEvents(db, table, hand, state);
    if (event.say?.trim())
      messages.push(
        await appendMessage(db, table.groupId, {
          kind: "bot",
          botId: BotId.parse(seat.botId),
          text: event.say,
          streaming: false,
        }),
      );
    return reply({ ok: true }, messages, true);
  });
  if (!outcome) return;
  conn.socket.send(
    JSON.stringify({ type: "poker_result", runId: event.runId, callId: event.callId, result: outcome.result }),
  );
  pushMessages(deps, outcome.ownerId, outcome.messages);
  if (outcome.advance) {
    await converge(deps, event.handId);
    if (outcome.result.ok) await pushTable(deps, initial.row.groupId);
  }
}
