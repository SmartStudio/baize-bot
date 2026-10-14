import {
  GroupId,
  MessageId,
  PokerHandId,
  PokerSessionId,
  RunId,
  UserId,
  type ComputerId,
  type PokerTableView,
  type Viewer,
} from "@baize/shared";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { sendHiddenRun } from "../agent/hidden-run.js";
import type { AgentHub } from "../agent/hub.js";
import type { Db } from "../db/client.js";
import { messages, pokerEvents, pokerHands, pokerHints, pokerTables, runs } from "../db/schema.js";
import { messageVisibleTo } from "../repo/messages.js";
import type { PushHub } from "../ws/hub.js";
import { narrate, seatNamer } from "./narrate.js";
import { latestHand, loadHand, loadTable, PokerError, tableState, tableView, withTableLock } from "./store.js";
import { viewFor } from "./view.js";
import { toWire } from "./wire.js";

type Hint = NonNullable<PokerTableView["hint"]>;
type HintDeps = { readonly db: Db; readonly push: PushHub };
export type AskHintDeps = HintDeps & { readonly agents: AgentHub };

async function decisionHint(db: Db, handId: string, seq: number): Promise<Hint | null> {
  const [row] = await db
    .select({ hint: pokerHints, endedAt: runs.endedAt, confirmedAt: runs.contextConfirmedAt, body: messages.body })
    .from(pokerHints)
    .innerJoin(runs, eq(runs.id, pokerHints.runId))
    .leftJoin(messages, and(eq(messages.id, pokerHints.messageId), messageVisibleTo({ kind: "user" })))
    .where(and(eq(pokerHints.handId, handId), eq(pokerHints.seq, seq)));
  if (!row) return null;
  const answered = row.body?.kind === "bot" && row.body.text.trim() !== "" && !row.body.streaming;
  // 对账/报错收尾不确认 prompt，半截正文即使被通用收尾收成定稿也不算成功回答。
  const failed = row.endedAt !== null && (row.confirmedAt === null || !answered);
  return {
    seq,
    status: failed ? "failed" : answered ? "done" : "waiting",
    messageId: row.hint.messageId === null ? null : MessageId.parse(row.hint.messageId),
  };
}

/** 只取当前手、当前决策点；上一街的建议不能带到下一次行动上。 */
export async function hintOf(db: Db, groupId: string): Promise<PokerTableView["hint"]> {
  const [hand] = await db
    .select({ id: pokerHands.id })
    .from(pokerHands)
    .where(and(eq(pokerHands.groupId, groupId), eq(pokerHands.status, "playing")))
    .orderBy(desc(pokerHands.number))
    .limit(1);
  if (!hand) return null;
  const [events] = await db.select({ seq: count() }).from(pokerEvents).where(eq(pokerEvents.handId, hand.id));
  return decisionHint(db, hand.id, events?.seq ?? 0);
}

async function viewWithHint(db: Db, groupId: string): Promise<PokerTableView | null> {
  const table = await loadTable(db, groupId);
  if (!table) return null;
  return tableView(db, table, await latestHand(db, groupId));
}

/** bot_text 和收尾事务提交后调用，避免 run 锁与桌锁反序。旧 run 的回调不能覆盖重试后的行。 */
export async function refreshHintForRun(deps: HintDeps, runId: RunId, messageId?: MessageId): Promise<void> {
  const [initial] = await deps.db
    .select({ handId: pokerHints.handId })
    .from(pokerHints)
    .where(eq(pokerHints.runId, runId));
  if (!initial) return;
  const [handRow] = await deps.db
    .select({ groupId: pokerHands.groupId })
    .from(pokerHands)
    .where(eq(pokerHands.id, initial.handId));
  if (!handRow) return;
  const result = await withTableLock(deps.db, handRow.groupId, async (db, table) => {
    const [hint] = await db.select().from(pokerHints).where(eq(pokerHints.runId, runId));
    if (!hint) return null;
    if (messageId !== undefined) {
      const [message] = await db.select().from(messages).where(eq(messages.id, messageId));
      if (
        !message ||
        message.groupId !== table.groupId ||
        message.body.kind !== "bot" ||
        message.body.text.trim() === "" ||
        message.visibleTo?.length !== 1 ||
        message.visibleTo[0]?.kind !== "user"
      )
        return null;
      await db.update(pokerHints).set({ messageId }).where(eq(pokerHints.runId, runId));
    }
    const current = await hintOf(db, table.groupId);
    const hand = await latestHand(db, table.groupId, true);
    if (hand?.row.id !== hint.handId || current?.seq !== hint.seq) return null;
    await db
      .update(pokerTables)
      .set({ version: sql`${pokerTables.version} + 1` })
      .where(eq(pokerTables.groupId, table.groupId));
    return { ownerId: table.ownerId, view: await viewWithHint(db, table.groupId) };
  });
  if (result?.view) deps.push.push(result.ownerId, { type: "poker_table_updated", table: result.view });
}

export async function askHint(
  deps: AskHintDeps,
  ownerId: UserId,
  handId: string,
  seq: number,
): Promise<PokerTableView> {
  const initial = await loadHand(deps.db, handId);
  if (!initial) throw new PokerError(404, "没有这手牌");
  const dispatches: ComputerId[] = [];
  const result = await withTableLock(deps.db, initial.row.groupId, async (db, table) => {
    if (table.ownerId !== ownerId) throw new PokerError(404, "没有这手牌");
    const hand = await loadHand(db, handId);
    if (
      !hand ||
      hand.row.status !== "playing" ||
      hand.state.phase.kind !== "betting" ||
      hand.state.phase.pending[0] !== "4"
    )
      throw new PokerError(409, "还没轮到你出牌，轮到你再问老白");
    if (seq !== hand.state.events.length) throw new PokerError(409, "问牌序号已过期");
    const existing = await decisionHint(db, handId, seq);
    if (existing !== null && existing.status !== "failed")
      return { changed: false, view: (await viewWithHint(db, table.groupId))! };

    const state = await tableState(db, table);
    const visibleTo: [Viewer, ...Viewer[]] = [{ kind: "bot", botId: state.host.botId }, { kind: "user" }];
    const sent = await sendHiddenRun(
      {
        db,
        agents: {
          isOnline: (id) => deps.agents.isOnline(id),
          configRejected: (id) => deps.agents.configRejected(id),
          canDeliver: (id) => deps.agents.canDeliver(id),
          // withTableLock 的外层事务提交后再 flush。
          flushOutbox: async (computerId) => {
            dispatches.push(computerId);
          },
        },
      },
      {
        botId: state.host.botId,
        groupId: GroupId.parse(table.groupId),
        role: "advisor",
        visibleTo,
        table: {
          sessionId: PokerSessionId.parse(hand.row.sessionId),
          handId: PokerHandId.parse(handId),
          seq,
          view: toWire(viewFor(hand.state, "4")),
          publicLog: hand.state.events.map((event) => narrate(event, seatNamer(state.seats))),
          question: "这手怎么打？请给我建议和理由。",
          review: null,
        },
      },
    );
    if (sent.kind === "busy") throw new PokerError(409, "老白还在回答上一条，等它说完再问");
    if (sent.kind === "skipped") throw new PokerError(404, "没有这手牌");
    if (sent.kind === "unplaced") throw new PokerError(409, "电脑不在线，这次没有问牌，电脑回来后再问一次");
    const runId = sent.runId;
    await db
      .insert(pokerHints)
      .values({ handId, seq, runId })
      .onConflictDoUpdate({
        target: [pokerHints.handId, pokerHints.seq],
        set: { runId, messageId: null, createdAt: new Date() },
      });
    await db
      .update(pokerTables)
      .set({ version: sql`${pokerTables.version} + 1` })
      .where(eq(pokerTables.groupId, table.groupId));
    return { changed: true, view: (await viewWithHint(db, table.groupId))! };
  });
  if (!result) throw new PokerError(404, "没有这手牌");
  for (const computerId of dispatches) await deps.agents.flushOutbox(computerId);
  // 发送失败或即时回答可能已改变状态，以提交后的快照为准。
  const view = (await viewWithHint(deps.db, initial.row.groupId)) ?? result.view;
  if (result.changed) deps.push.push(ownerId, { type: "poker_table_updated", table: view });
  return view;
}
