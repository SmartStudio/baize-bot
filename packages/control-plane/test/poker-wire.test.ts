import { PokerSeatView } from "@baize/shared";
import { describe, expect, it } from "vitest";
import { apply, newHand, type SeatId } from "../src/poker/engine.js";
import { viewFor } from "../src/poker/view.js";
import { toWire } from "../src/poker/wire.js";

const blinds = { small: 5, big: 10 };
const table = [
  { id: "you", stack: 200 },
  { id: "豹", stack: 200 },
  { id: "老K", stack: 200 },
  { id: "茉莉", stack: 200 },
];

describe("引擎视图上线", () => {
  it("每一街每个座位的 viewFor 输出都能原样过 shared 的 PokerSeatView 解析", () => {
    let state = newHand("上线", table, "you", blinds);
    let parsed = 0;
    for (;;) {
      for (const seat of state.seats) {
        const view = viewFor(state, seat.id);
        expect(toWire(view), `${seat.id} 在 ${view.street} 的视图过 zod 不该丢字段`).toEqual(view);
        parsed += 1;
      }
      const toAct = state.phase.kind === "betting" ? (state.phase.pending[0] as SeatId) : null;
      if (toAct === null) break;
      const legal = viewFor(state, toAct).legal;
      state = apply(
        state,
        toAct,
        legal.kind === "your_turn" && legal.toCall > 0 ? { kind: "call" } : { kind: "check" },
      );
    }
    expect(state.board, "一路过牌跟注到河牌才算每一街都验过").toHaveLength(5);
    expect(parsed).toBeGreaterThanOrEqual(4 * 4);
  });

  it("摊牌后的视图带着亮牌和分池事件，照样过解析", () => {
    let state = newHand("摊牌", table, "you", blinds);
    for (;;) {
      const toAct = state.phase.kind === "betting" ? (state.phase.pending[0] as SeatId) : null;
      if (toAct === null) break;
      const legal = viewFor(state, toAct).legal;
      state = apply(
        state,
        toAct,
        legal.kind === "your_turn" && legal.toCall > 0 ? { kind: "call" } : { kind: "check" },
      );
    }
    expect(state.phase.kind).toBe("complete");
    for (const seat of state.seats) {
      const view = viewFor(state, seat.id);
      expect(PokerSeatView.safeParse(view).success, `${seat.id} 摊牌后的视图`).toBe(true);
    }
  });
});
