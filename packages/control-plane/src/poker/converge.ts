import {
  type ComputerId,
  type ControlToAgent,
  GroupId,
  PokerHandId,
  PokerSessionId,
  RunId,
  UserId,
  type Message,
} from "@baize/shared";
import { and, eq, sql } from "drizzle-orm";
import type { AgentHub } from "../agent/hub.js";
import { sendHiddenRun } from "../agent/hidden-run.js";
import type { Db } from "../db/client.js";
import { messages as storedMessages, pokerHands, pokerTables, runs } from "../db/schema.js";
import { finishRun } from "../repo/runs.js";
import type { PushHub } from "../ws/hub.js";
import { BOT_TURN_TIMEOUT_MS, nextStep, type PlanTurn, type Step } from "./converge-plan.js";
import { apply } from "./engine.js";
import { narrate } from "./narrate.js";
import { engineSeatId } from "./seating.js";
import {
  appendEvents,
  clearTurn,
  hostMessage,
  loadHand,
  loadTable,
  snapshot,
  tableState,
  tableView,
  withTableLock,
} from "./store.js";
import { viewFor } from "./view.js";
import { toWire } from "./wire.js";

export type PokerDeps = { readonly db: Db; readonly push: PushHub; readonly agents: AgentHub };
export type PokerOptions = { readonly now?: () => Date; readonly turnTimeoutMs?: number };
const MAX_TURN_REDISPATCHES = 3;
const optionsByDb = new WeakMap<Db, PokerOptions>();
export function configurePoker(db: Db, options: PokerOptions): void {
  optionsByDb.set(db, options);
}
export function pushMessages(deps: PokerDeps, ownerId: string, messages: readonly Message[]): void {
  for (const message of messages) deps.push.push(UserId.parse(ownerId), { type: "message", message });
}
export async function pushTable(deps: PokerDeps, groupId: string): Promise<void> {
  const table = await loadTable(deps.db, groupId);
  if (!table) return;
  const view = await snapshot(deps.db, groupId);
  if (view) deps.push.push(UserId.parse(table.ownerId), { type: "poker_table_updated", table: view });
}

/** 库中日志是事实来源。锁内每次重新载入，重复推进不会再落同一个动作或重复结算。 */
export async function converge(deps: PokerDeps, handId: string): Promise<void> {
  const initial = await loadHand(deps.db, handId);
  if (!initial) return;
  const options = optionsByDb.get(deps.db);
  const dispatches: { computerId: ComputerId; message: Extract<ControlToAgent, { type: "prompt" }> }[] = [];
  const outcome = await withTableLock(deps.db, initial.row.groupId, async (db, locked) => {
    const messages: Message[] = [];
    let changed = false;
    for (;;) {
      const table = await loadTable(db, locked.groupId);
      const hand = await loadHand(db, handId);
      if (!table || !hand) return null;
      const now = options?.now?.() ?? new Date();
      let turn: PlanTurn | null =
        hand.row.turnSeat !== null && hand.row.turnDeadline !== null
          ? {
              seat: hand.row.turnSeat,
              runId: hand.row.turnRunId ?? "",
              attempts: hand.row.turnAttempts,
              deadline: hand.row.turnDeadline,
            }
          : null;
      let missing = hand.row.turnRunId === null;
      if (hand.row.turnRunId !== null && turn !== null) {
        const [run] = await db.select().from(runs).where(eq(runs.id, hand.row.turnRunId));
        missing = run === undefined || (run.endedAt !== null && run.contextConfirmedAt === null);
        if (run?.endedAt !== null && run?.contextConfirmedAt !== null && run !== undefined)
          turn = { ...turn, deadline: now };
      }
      const planTable = {
        seats: table.seats.map((seat) => ({
          seat: seat.seat,
          kind: seat.botId === null ? ("user" as const) : ("bot" as const),
        })),
      };
      let step: Step = nextStep({ status: hand.row.status, state: hand.state, turn }, planTable, now);
      // hello 已按 activeRuns 收掉丢失的 run；没有派出去的回合也在此重试，沿用原截止时间。
      const dispatchTag = `牌桌决策点 ${handId}/${hand.state.events.length}`;
      if (step.kind === "wait_bot" && missing && turn !== null) {
        const [sent] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(storedMessages)
          .where(and(eq(storedMessages.groupId, table.groupId), sql`${storedMessages.body}->>'text' = ${dispatchTag}`));
        // 首派加三次重派；计数独立于引擎拒绝次数，保存在隐藏触发消息中，重启仍有效。
        if ((sent?.count ?? 0) < 1 + MAX_TURN_REDISPATCHES)
          step = { kind: "dispatch_bot", seat: turn.seat, seq: hand.state.events.length };
      }
      switch (step.kind) {
        case "await_user":
          if (hand.row.turnSeat !== null || hand.row.turnDeadline !== null) {
            await clearTurn(db, handId);
            changed = true;
          }
          return {
            ownerId: table.ownerId,
            messages,
            changed,
            view: changed
              ? await tableView(db, (await loadTable(db, table.groupId))!, (await loadHand(db, handId))!)
              : null,
          };
        case "wait_bot":
        case "hand_over":
          return { ownerId: table.ownerId, messages, changed, view: changed ? await tableView(db, table, hand) : null };
        case "dispatch_bot": {
          const state = await tableState(db, table);
          const seat = state.seats.find((candidate) => candidate.seat === step.seat);
          if (!seat?.botId) throw new Error("待出牌的座位没有牌友");
          const deadline =
            hand.row.turnSeat === step.seat && hand.row.turnDeadline !== null
              ? hand.row.turnDeadline
              : new Date(now.getTime() + (options?.turnTimeoutMs ?? BOT_TURN_TIMEOUT_MS));
          const sent = await sendHiddenRun(
            {
              db,
              agents: {
                isOnline: (id) => deps.agents.isOnline(id),
                configRejected: (id) => deps.agents.configRejected(id),
                // 外层事务提交后才发 prompt，避免重连对账看不到刚创建的 run。
                send: (computerId, message) => {
                  if (!deps.agents.isOnline(computerId)) return false;
                  if (message.type !== "prompt") throw new Error("隐藏派活只能发送 prompt");
                  dispatches.push({ computerId, message });
                  return true;
                },
              },
            },
            {
              botId: seat.botId,
              groupId: GroupId.parse(table.groupId),
              role: "player",
              visibleTo: [{ kind: "bot", botId: seat.botId }],
              table: {
                sessionId: PokerSessionId.parse(hand.row.sessionId),
                handId: PokerHandId.parse(handId),
                seq: step.seq,
                view: toWire(viewFor(hand.state, engineSeatId(step.seat))),
                publicLog: hand.state.events.map((event) =>
                  narrate(
                    event,
                    (id) => state.seats.find((candidate) => engineSeatId(candidate.seat) === id)?.name ?? id,
                  ),
                ),
                question: null,
                review: null,
              },
            },
          );
          if (sent.kind === "sent")
            await db
              .update(storedMessages)
              .set({ body: { kind: "system", text: dispatchTag }, revision: sql`${storedMessages.revision} + 1` })
              .where(eq(storedMessages.id, sent.messageId));
          const runId = sent.kind === "sent" ? sent.runId : null;
          if (runId !== hand.row.turnRunId || hand.row.turnSeat !== step.seat || hand.row.turnDeadline === null) {
            await db
              .update(pokerHands)
              .set({ turnSeat: step.seat, turnRunId: runId, turnDeadline: deadline })
              .where(eq(pokerHands.id, handId));
            await db
              .update(pokerTables)
              .set({ version: sql`${pokerTables.version} + 1` })
              .where(eq(pokerTables.groupId, table.groupId));
            changed = true;
          }
          return {
            ownerId: table.ownerId,
            messages,
            changed,
            view: changed
              ? await tableView(db, (await loadTable(db, table.groupId))!, (await loadHand(db, handId))!)
              : null,
          };
        }
        case "timeout_action": {
          const state = await tableState(db, table);
          if (hand.row.turnRunId !== null)
            await finishRun(
              db,
              RunId.parse(hand.row.turnRunId),
              GroupId.parse(table.groupId),
              { steps: 0, inputTokens: 0, outputTokens: 0, amount: 0 },
              "abandoned",
            );
          messages.push(
            await hostMessage(
              db,
              table,
              `${state.seats.find((seat) => seat.seat === step.seat)?.name ?? step.seat}${hand.row.turnAttempts >= 3 ? "连续三次出牌无效" : "没有及时出牌"}，按兜底处理`,
            ),
          );
          messages.push(
            ...(await appendEvents(db, table, hand, apply(hand.state, engineSeatId(step.seat), step.action))),
          );
          changed = true;
          break;
        }
        case "settle": {
          const [settled] = await db
            .update(pokerHands)
            .set({
              status: "complete",
              completedAt: now,
              turnSeat: null,
              turnRunId: null,
              turnAttempts: 0,
              turnDeadline: null,
              version: sql`${pokerHands.version} + 1`,
            })
            .where(and(eq(pokerHands.id, handId), eq(pokerHands.status, "playing")))
            .returning();
          if (settled) {
            const seats = table.seats.map((seat) => ({
              ...seat,
              stack: hand.state.seats.find((engineSeat) => engineSeat.id === engineSeatId(seat.seat))!.stack,
            }));
            await db
              .update(pokerTables)
              .set({ status: "idle", seats, version: sql`${pokerTables.version} + 1` })
              .where(eq(pokerTables.groupId, table.groupId));
            changed = true;
          }
          break;
        }
      }
    }
  });
  if (!outcome) return;
  for (const dispatch of dispatches) {
    if (!deps.agents.send(dispatch.computerId, dispatch.message)) {
      await finishRun(
        deps.db,
        dispatch.message.runId,
        dispatch.message.groupId,
        { steps: 0, inputTokens: 0, outputTokens: 0, amount: 0 },
        "abandoned",
      );
    }
  }
  pushMessages(deps, outcome.ownerId, outcome.messages);
  if (outcome.changed && outcome.view !== null)
    deps.push.push(UserId.parse(outcome.ownerId), { type: "poker_table_updated", table: outcome.view });
}
