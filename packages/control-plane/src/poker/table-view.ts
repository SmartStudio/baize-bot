import { PokerTableView, type PokerSeatNo, type PokerHandId } from "@baize/shared";
import type { HandState } from "./engine.js";
import { engineSeatId, seatNoOf } from "./seating.js";
import { viewFor } from "./view.js";
import { toWire } from "./wire.js";

/** 桌子这一层的状态：除了「正在打的手」之外 PokerTableView 的全部字段，由调用方从库里拼好。 */
export type TableState = Omit<PokerTableView, "hand">;

/** 正在打的那手。state 里有种子和别人的底牌，只在这里被 viewFor 过一遍，原样不出这个函数。 */
export interface TableHand {
  readonly id: PokerHandId;
  readonly number: number;
  readonly version: number;
  readonly state: HandState;
  /** 牌友这一步的截止时间；轮到用户时不论传什么都不进视图。 */
  readonly turnDeadline: Date | null;
}

/**
 * perspective 座位看到的整张桌。手上的内容只取自 viewFor，座位筹码也取视图里的实时值，
 * 输出再过一遍 PokerTableView：多出来的字段（比如调用方手滑塞进来的种子）被 zod 剥掉，缺字段直接报错。
 */
export function buildTableView(table: TableState, hand: TableHand | null, perspective: PokerSeatNo): PokerTableView {
  if (hand === null) return PokerTableView.parse({ ...table, hand: null });

  const view = toWire(viewFor(hand.state, engineSeatId(perspective)));
  const stacks = new Map(view.seats.map((seat) => [seatNoOf(seat.seatId), seat.stack]));
  const toAct =
    view.legal.kind === "your_turn" ? perspective : view.legal.kind === "waiting" ? seatNoOf(view.legal.toAct) : null;
  const actor = table.seats.find((seat) => seat.seat === toAct);
  return PokerTableView.parse({
    ...table,
    seats: table.seats.map((seat) => ({ ...seat, stack: stacks.get(seat.seat) ?? seat.stack })),
    hand: {
      id: hand.id,
      number: hand.number,
      version: hand.version,
      toAct,
      deadline: actor?.kind === "bot" && hand.turnDeadline !== null ? hand.turnDeadline.toISOString() : null,
      view,
    },
  });
}
