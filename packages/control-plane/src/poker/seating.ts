import type { PokerSeatNo } from "@baize/shared";
import type { SeatId } from "./engine.js";

// 桌子的座位号 1 到 4 和引擎的座位 id 是同一个数的两种写法：引擎 id 恒为座位号的十进制字符串。
// 座位号从小到大就是顺时针，引擎按传入顺序排盲注，所以调用方总是按座位号升序交给引擎。

export interface SeatStack {
  readonly seat: PokerSeatNo;
  readonly stack: number;
}

export interface Rebuy {
  readonly seat: PokerSeatNo;
  readonly amount: number;
}

export interface NextHandSeating {
  readonly button: PokerSeatNo;
  readonly seats: SeatStack[];
  readonly rebuys: Rebuy[];
}

export function engineSeatId(seat: PokerSeatNo): SeatId {
  return String(seat);
}

export function seatNoOf(id: SeatId): PokerSeatNo {
  if (id === "1" || id === "2" || id === "3" || id === "4") return Number(id) as PokerSeatNo;
  throw new Error(`${id} 不是座位号`);
}

/**
 * 下一手的庄位和筹码。庄位从上一手的庄位之后顺时针找第一个有筹码的座位，第一手（prevButton 为 null）
 * 从 1 号起找。破产座位（筹码不为正）补回 startingStack 并记一条补码；庄位按补码前的筹码判，
 * 刚补码的人不当手坐庄。
 */
export function seatNextHand(
  seats: readonly SeatStack[],
  prevButton: PokerSeatNo | null,
  startingStack: number,
): NextHandSeating {
  const ordered = seats.toSorted((a, b) => a.seat - b.seat);
  const start = prevButton === null ? 0 : ordered.findIndex((seat) => seat.seat === prevButton) + 1;
  if (prevButton !== null && start === 0) throw new Error(`上一手的庄位 ${prevButton} 不在桌上`);
  const button = ordered
    .map((_, offset) => ordered[(start + offset) % ordered.length] as SeatStack)
    .find((seat) => seat.stack > 0);
  if (button === undefined) throw new Error("桌上没有人有筹码，没法定庄位");

  const rebuys: Rebuy[] = ordered
    .filter((seat) => seat.stack <= 0)
    .map((seat) => ({ seat: seat.seat, amount: startingStack }));
  return {
    button: button.seat,
    seats: ordered.map((seat) => ({ seat: seat.seat, stack: seat.stack > 0 ? seat.stack : startingStack })),
    rebuys,
  };
}
