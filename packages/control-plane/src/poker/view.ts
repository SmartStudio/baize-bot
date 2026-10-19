import { rankValue, suitOf, type Card } from "./cards.js";
import {
  legalActions,
  type Award,
  type Blinds,
  type Event,
  type HandState,
  type LegalActions,
  type SeatId,
  type SeatStatus,
  type Street,
} from "./engine.js";
import { describePokerHand, evaluatePokerHand, pokerRankName } from "@baize/shared";

// 某个座位能看到的一手牌。这是可见范围的基础：只拼公开信息加这个座位自己的底牌，
// 种子和剩余牌堆也不出现，拿到种子就能推出所有人的牌。

export type Position = "button" | "small_blind" | "big_blind" | "under_the_gun" | "middle" | "cutoff";

const POSITION_LABELS: Record<Position, string> = {
  button: "按钮位",
  small_blind: "小盲位",
  big_blind: "大盲位",
  under_the_gun: "枪口位",
  middle: "中间位",
  cutoff: "关煞位",
};

export interface OtherSeatView {
  readonly seatId: SeatId;
  readonly position: Position;
  readonly stack: number;
  readonly committed: number;
  readonly status: SeatStatus;
  /** 只在摊牌后、这个座位亮了牌时才有。 */
  readonly shown: readonly [Card, Card] | null;
}

export interface SeatView {
  readonly seatId: SeatId;
  readonly position: Position;
  readonly hole: readonly [Card, Card];
  readonly stack: number;
  /** 给模型的一句话，例如「你在按钮位，两对，K 和 7」。 */
  readonly summary: string;
  readonly street: Street | "complete";
  readonly board: readonly Card[];
  readonly pot: number;
  readonly blinds: Blinds;
  readonly seats: readonly OtherSeatView[];
  readonly legal: LegalActions;
  readonly awards: readonly Award[] | null;
  readonly events: readonly Event[];
}

export function viewFor(state: HandState, seatId: SeatId): SeatView {
  const me = state.seats.find((seat) => seat.id === seatId);
  if (me === undefined) throw new Error(`桌上没有座位 ${seatId}`);
  const shown = new Map(
    state.events.flatMap((event) => (event.kind === "showdown" ? [[event.seatId, event.hole] as const] : [])),
  );
  const position = positionOf(state, seatId);
  // 整份拷贝，调用方改视图碰不到状态里的底牌、盲注、奖金和事件。
  return structuredClone({
    seatId,
    position,
    hole: me.hole,
    stack: me.stack,
    summary: `你在${POSITION_LABELS[position]}，${strengthOf(me.hole, state.board)}`,
    street: state.phase.kind === "betting" ? state.phase.street : "complete",
    board: [...state.board],
    pot: state.seats.reduce((sum, seat) => sum + seat.contributed, 0),
    blinds: state.blinds,
    seats: state.seats.map((seat) => ({
      seatId: seat.id,
      position: positionOf(state, seat.id),
      stack: seat.stack,
      committed: seat.committed,
      status: seat.status,
      shown: shown.get(seat.id) ?? null,
    })),
    legal: legalActions(state, seatId),
    awards: state.phase.kind === "complete" ? state.phase.awards : null,
    events: state.events,
  });
}

export function positionOf(state: HandState, seatId: SeatId): Position {
  const count = state.seats.length;
  const buttonIndex = state.seats.findIndex((seat) => seat.id === state.button);
  const offset = (state.seats.findIndex((seat) => seat.id === seatId) - buttonIndex + count) % count;
  if (offset === 0) return "button";
  if (count === 2) return "big_blind";
  if (offset === 1) return "small_blind";
  if (offset === 2) return "big_blind";
  if (offset === 3) return "under_the_gun";
  if (offset === count - 1) return "cutoff";
  return "middle";
}

function strengthOf(hole: readonly [Card, Card], board: readonly Card[]): string {
  if (board.length > 0) return describePokerHand(evaluatePokerHand(hole, board));
  const [a, b] = [rankValue(hole[0]), rankValue(hole[1])].toSorted((x, y) => y - x) as [number, number];
  if (a === b) return `口袋对 ${pokerRankName(a)}`;
  return `${pokerRankName(a)} ${pokerRankName(b)} ${suitOf(hole[0]) === suitOf(hole[1]) ? "同花" : "不同花"}`;
}
