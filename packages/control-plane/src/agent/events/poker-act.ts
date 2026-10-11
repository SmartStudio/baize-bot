import { BotId, ControlToAgent, type AgentToControl, type Message } from "@baize/shared";
import { eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { messages as storedMessages, pokerHands, runs } from "../../db/schema.js";
import { apply } from "../../poker/engine.js";
import { converge, pushMessages, pushTable } from "../../poker/converge.js";
import { appendEvents, loadHand, withTableLock } from "../../poker/store.js";
import { appendMessage } from "../../repo/messages.js";
import type { AgentEventDeps } from "../events.js";
import type { AgentConnection } from "../hub.js";

type PokerResult = Extract<ControlToAgent, { type: "poker_result" }>["result"];
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

    // 首次回执和动作同事务落库。主键认领挡重复帧，隐藏系统消息让重启后仍能回同一个结果。
    const receiptId = `poker-result:${createHash("sha256")
      .update(JSON.stringify([event.runId, event.callId]))
      .digest("hex")}`;
    const [claimed] = await db
      .insert(storedMessages)
      .values({
        id: receiptId,
        groupId: table.groupId,
        body: { kind: "system", text: "出牌确认处理中" },
        visibleTo: [{ kind: "bot", botId: BotId.parse(run.botId) }],
        createdAt: new Date(),
      })
      .onConflictDoNothing({ target: storedMessages.id })
      .returning();
    if (!claimed) {
      const [receipt] = await db.select().from(storedMessages).where(eq(storedMessages.id, receiptId));
      if (receipt?.body.kind !== "system") throw new Error("出牌回执记录不完整");
      const saved = ControlToAgent.parse(JSON.parse(receipt.body.text));
      if (saved.type !== "poker_result") throw new Error("出牌回执记录格式不对");
      return { ownerId: table.ownerId, messages: [] as Message[], result: saved.result, advance: false };
    }
    const reply = async (result: PokerResult, messages: Message[] = [], advance = false) => {
      await db
        .update(storedMessages)
        .set({
          body: {
            kind: "system",
            text: JSON.stringify({ type: "poker_result", runId: event.runId, callId: event.callId, result }),
          },
          revision: sql`${storedMessages.revision} + 1`,
        })
        .where(eq(storedMessages.id, receiptId));
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
