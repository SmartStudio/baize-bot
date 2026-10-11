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
import { errorKind } from "../agent/events.js";
import type { AgentHub } from "../agent/hub.js";
import { sendHiddenRun } from "../agent/hidden-run.js";
import type { Db } from "../db/client.js";
import { pokerHands, pokerTables, runs } from "../db/schema.js";
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
/** 提交后尽力而为的几步，见 http/routes/poker-hands.ts 的 afterCommit。 */
export type AfterCommitStep = "message_push" | "converge" | "table_push" | "snapshot";
export type PokerOptions = {
  readonly now?: () => Date;
  readonly turnTimeoutMs?: number;
  /** 测试从启动参数注入提交后某一步失败：每步开始前调用，抛错就当这一步失败。生产不传。 */
  readonly afterCommitProbe?: (step: AfterCommitStep) => void;
};
const MAX_TURN_REDISPATCHES = 3;
const optionsByDb = new WeakMap<Db, PokerOptions>();
export function configurePoker(db: Db, options: PokerOptions): void {
  optionsByDb.set(db, options);
}
export function pokerOptions(db: Db): PokerOptions {
  return optionsByDb.get(db) ?? {};
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
      if (!table || !hand || hand.row.status === "abandoned") return null;
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
      // 首派加三次重派；计数独立于引擎拒绝次数，记在手上按决策点认，重启仍有效。
      const dispatched = hand.row.dispatchSeq === hand.state.events.length ? hand.row.dispatchCount : 0;
      if (step.kind === "wait_bot" && missing && turn !== null && dispatched < 1 + MAX_TURN_REDISPATCHES)
        step = { kind: "dispatch_bot", seat: turn.seat, seq: hand.state.events.length };
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
              .update(pokerHands)
              .set({
                dispatchCount: sql`CASE WHEN ${pokerHands.dispatchSeq} = ${step.seq} THEN ${pokerHands.dispatchCount} + 1 ELSE 1 END`,
                dispatchSeq: step.seq,
              })
              .where(eq(pokerHands.id, handId));
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

/**
 * 推进一直失败的手的最后出路：作废，不结算。只碰手和桌这两行，不重放日志，日志本身坏了也能收掉。
 * 座位筹码退回 seats_start，桌子回 idle，用户能开下一手或散场；在途的牌友 run 收成 abandoned，晚到的出牌拿失败回执。
 */
export async function abandonHand(deps: PokerDeps, handId: string): Promise<boolean> {
  const [initial] = await deps.db
    .select({ groupId: pokerHands.groupId })
    .from(pokerHands)
    .where(eq(pokerHands.id, handId));
  if (!initial) return false;
  const outcome = await withTableLock(deps.db, initial.groupId, async (db, table) => {
    const playing = and(eq(pokerHands.id, handId), eq(pokerHands.status, "playing"));
    const [hand] = await db.select().from(pokerHands).where(playing);
    if (!hand) return null;
    await db
      .update(pokerHands)
      .set({
        status: "abandoned",
        completedAt: pokerOptions(deps.db).now?.() ?? new Date(),
        turnSeat: null,
        turnRunId: null,
        turnAttempts: 0,
        turnDeadline: null,
        version: sql`${pokerHands.version} + 1`,
      })
      .where(playing);
    if (hand.turnRunId !== null)
      await finishRun(
        db,
        RunId.parse(hand.turnRunId),
        GroupId.parse(table.groupId),
        { steps: 0, inputTokens: 0, outputTokens: 0, amount: 0 },
        "abandoned",
      );
    await db
      .update(pokerTables)
      .set({ status: "idle", seats: hand.seatsStart, version: sql`${pokerTables.version} + 1` })
      .where(eq(pokerTables.groupId, table.groupId));
    const said = await hostMessage(db, table, `第 ${hand.number} 手出了故障打不下去，这一手作废，筹码退回开手时的样子`);
    return { ownerId: table.ownerId, said };
  });
  if (!outcome) return false;
  pushMessages(deps, outcome.ownerId, [outcome.said]);
  await pushTable(deps, initial.groupId).catch((error: unknown) =>
    console.error("作废牌局后推送视图失败", handId, errorKind(error)),
  );
  return true;
}
