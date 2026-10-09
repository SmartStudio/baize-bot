import { describe, expect, it } from "vitest";
import { apply, newHand, type HandState, type SeatId } from "../src/poker/engine.js";
import { viewFor } from "../src/poker/view.js";

const blinds = { small: 5, big: 10 };
const table = [
  { id: "you", stack: 200 },
  { id: "豹", stack: 200 },
  { id: "老K", stack: 200 },
  { id: "茉莉", stack: 200 },
];

function othersCards(state: HandState, seatId: SeatId): string[] {
  return state.seats.filter((seat) => seat.id !== seatId).flatMap((seat) => seat.hole);
}

describe("座位视图", () => {
  it("每一街序列化后的视图里都找不到别人的底牌，也没有种子和剩余牌堆", () => {
    let state = newHand("看不见", table, "you", blinds);
    for (;;) {
      for (const seat of state.seats) {
        const json = JSON.stringify(viewFor(state, seat.id));
        for (const card of othersCards(state, seat.id)) expect(json).not.toContain(`"${card}"`);
        for (const card of seat.hole) expect(json).toContain(`"${card}"`);
        expect(json).not.toContain(state.seed);
      }
      if (state.board.length === 5) break;
      const toAct = state.phase.kind === "betting" ? (state.phase.pending[0] as SeatId) : null;
      if (toAct === null) break;
      const legal = viewFor(state, toAct).legal;
      state = apply(
        state,
        toAct,
        legal.kind === "your_turn" && legal.toCall > 0 ? { kind: "call" } : { kind: "check" },
      );
    }
    expect(state.board).toHaveLength(5);
  });

  it("摊牌之后亮牌的座位才在视图里露出底牌，弃牌的一直不露", () => {
    let state = newHand("亮牌", table, "you", blinds);
    state = apply(state, "茉莉", { kind: "fold" });
    state = apply(state, "you", { kind: "call" });
    state = apply(state, "豹", { kind: "call" });
    state = apply(state, "老K", { kind: "check" });
    while (state.phase.kind === "betting") state = apply(state, state.phase.pending[0] as SeatId, { kind: "check" });
    const view = viewFor(state, "you");
    const shown = Object.fromEntries(view.seats.map((seat) => [seat.seatId, seat.shown]));
    const holes = Object.fromEntries(state.seats.map((seat) => [seat.id, seat.hole]));
    expect(shown).toEqual({ you: holes["you"], 豹: holes["豹"], 老K: holes["老K"], 茉莉: null });
    expect(JSON.stringify(view)).not.toContain(`"${holes["茉莉"]?.[0]}"`);
  });

  it("视图附上位置和牌力，翻前说起手牌，翻后说牌型", () => {
    const state = newHand("位置", table, "you", blinds);
    expect(viewFor(state, "you").summary).toMatch(/^你在按钮位，/);
    expect(viewFor(state, "豹").summary).toMatch(/^你在小盲位，(口袋对 |[0-9JQKA]+ [0-9JQKA]+ (不同花|同花))/);
    expect(viewFor(state, "老K").position).toBe("big_blind");
    expect(viewFor(state, "茉莉").position).toBe("under_the_gun");
    expect(viewFor(state, "茉莉").legal).toMatchObject({ kind: "your_turn", toCall: 10 });
    expect(viewFor(state, "you").legal).toEqual({ kind: "waiting", toAct: "茉莉" });

    let flop = apply(state, "茉莉", { kind: "call" });
    flop = apply(flop, "you", { kind: "call" });
    flop = apply(flop, "豹", { kind: "call" });
    flop = apply(flop, "老K", { kind: "check" });
    expect(viewFor(flop, "you").summary).toMatch(/^你在按钮位，(高牌|一对|两对|三条|顺子|同花|葫芦|四条|同花顺|皇家)/);
  });

  it("改视图里的事件、底牌和盲注碰不到原状态", () => {
    const state = newHand("视图拷贝", table, "you", blinds);
    const before = structuredClone(state);
    const view = viewFor(state, "you") as unknown as {
      events: unknown[];
      hole: string[];
      blinds: { big: number };
    };
    view.events.push({ kind: "fold" });
    view.hole[0] = "2c";
    view.blinds.big = 99;
    expect(state).toEqual(before);
  });
});
