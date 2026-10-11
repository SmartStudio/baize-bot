import { PokerSeatView } from "@baize/shared";
import type { SeatView } from "./view.js";

// shared 的 PokerSeatView 是引擎 SeatView 的 zod 镜像。两边必须一字不差：引擎多一个字段，
// 下面这行就编译不过；shared 多一个字段也一样。改任一边先改另一边。
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const seatViewMirrorsEngine: Equal<PokerSeatView, SeatView> = true;
void seatViewMirrorsEngine;

/** 引擎视图出边界前过一遍 zod，形状对不上在控制面就炸，不让坏数据流到客户端和 prompt。 */
export function toWire(view: SeatView): PokerSeatView {
  return PokerSeatView.parse(view);
}
