import type { PokerSeatNo, PokerTableSeat } from "@baize/shared";
import { legalActions, type Action, type HandState } from "./engine.js";
import { fallbackAction } from "./fallback.js";
import { engineSeatId, seatNoOf } from "./seating.js";

// converge 的决策半边：给定库里读出来的一手牌和桌子，说下一步该做什么。副作用（派活、写事件、
// 结算）在单元 7，这里不碰库、不读时钟，now 由调用方给。

/** D23：牌友 60 秒没出牌就兜底，用户不限时。单元 7 派活时用它算 turn_deadline。 */
export const BOT_TURN_TIMEOUT_MS = 60_000;
/** D24：同一个决策点牌友被引擎拒绝这么多次就不再等，直接兜底（两次重试都失败）。 */
export const MAX_REJECTED_ACTIONS = 3;

/**
 * 已经派给牌友的那次回合。单元 7 每次落一个动作都要把它清掉：这里只认座位对得上，
 * 座位没换时一份没清的旧记录会被当成新决策点的记录。
 */
export interface PlanTurn {
  readonly seat: PokerSeatNo;
  readonly runId: string;
  /** 这个决策点上牌友已被引擎拒绝的次数。 */
  readonly attempts: number;
  readonly deadline: Date;
}

export interface PlanHand {
  /** poker_hands.status：引擎走到 complete 和手牌行标成 complete 之间有一段要结算。 */
  readonly status: "playing" | "complete";
  readonly state: HandState;
  readonly turn: PlanTurn | null;
}

export interface PlanTable {
  readonly seats: readonly Pick<PokerTableSeat, "seat" | "kind">[];
}

export type Step =
  | { readonly kind: "await_user" }
  | { readonly kind: "wait_bot" }
  /** seq 是这个决策点之前引擎已写的事件数，也就是下一条事件的序号；牌友的 poker_act 带它回来对账。 */
  | { readonly kind: "dispatch_bot"; readonly seat: PokerSeatNo; readonly seq: number }
  | { readonly kind: "timeout_action"; readonly seat: PokerSeatNo; readonly action: Action }
  | { readonly kind: "settle" }
  | { readonly kind: "hand_over" };

export function nextStep(hand: PlanHand, table: PlanTable, now: Date): Step {
  const phase = hand.state.phase;
  if (phase.kind === "complete") return hand.status === "complete" ? { kind: "hand_over" } : { kind: "settle" };

  const seat = seatNoOf(phase.pending[0] as string);
  const seated = table.seats.find((candidate) => candidate.seat === seat);
  if (seated === undefined) throw new Error(`座位 ${seat} 不在桌上`);
  if (seated.kind === "user") return { kind: "await_user" };

  const turn = hand.turn !== null && hand.turn.seat === seat ? hand.turn : null;
  if (turn === null) return { kind: "dispatch_bot", seat, seq: hand.state.events.length };
  if (turn.attempts >= MAX_REJECTED_ACTIONS || now.getTime() >= turn.deadline.getTime()) {
    return { kind: "timeout_action", seat, action: fallbackAction(legalActions(hand.state, engineSeatId(seat))) };
  }
  return { kind: "wait_bot" };
}
