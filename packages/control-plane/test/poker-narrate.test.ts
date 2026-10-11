import { describe, expect, it } from "vitest";
import { apply, newHand, type Action, type Event, type HandState, type SeatId } from "../src/poker/engine.js";
import { narrate } from "../src/poker/narrate.js";

const names: Record<string, string> = { "1": "阿豹", "2": "老K", "3": "茉莉", "4": "你" };
const nameOf = (seatId: SeatId): string => names[seatId] ?? seatId;
const seats = ["1", "2", "3", "4"].map((id) => ({ id, stack: 200 }));
const blinds = { small: 5, big: 10 };

function play(seed: string, button: SeatId, choose: (state: HandState, seat: SeatId) => Action): HandState {
  let state = newHand(seed, seats, button, blinds);
  while (state.phase.kind === "betting") {
    const seat = state.phase.pending[0] as SeatId;
    state = apply(state, seat, choose(state, seat));
  }
  return state;
}

const checkOrCall = (state: HandState, seat: SeatId): Action => {
  const me = state.seats.find((candidate) => candidate.id === seat);
  const phase = state.phase.kind === "betting" ? state.phase : null;
  return me !== undefined && phase !== null && phase.currentBet > me.committed ? { kind: "call" } : { kind: "check" };
};

const foldPreflop = (state: HandState): Action =>
  state.phase.kind === "betting" && state.phase.street === "preflop" ? { kind: "fold" } : { kind: "check" };

describe("narrate", () => {
  it("对引擎每种事件都有一句中文，动作的五种写法也都有", () => {
    const showdown = play("播报", "4", checkOrCall);
    const folded = play("播报弃牌", "4", foldPreflop);
    const raised = newHand("播报加注", seats, "4", blinds);
    const toAct = raised.phase.kind === "betting" ? (raised.phase.pending[0] as SeatId) : "1";
    const allIn = apply(raised, toAct, { kind: "all_in" });
    const raising = apply(newHand("播报加注", seats, "4", blinds), toAct, { kind: "raise", amount: 40 });

    const events: Event[] = [...showdown.events, ...folded.events, ...allIn.events, ...raising.events];
    const kinds = new Set(events.map((event) => event.kind));
    expect([...kinds].toSorted(), "样本要覆盖引擎的五种事件").toEqual([
      "action",
      "award",
      "blind",
      "showdown",
      "street",
    ]);
    const actions = new Set(events.flatMap((event) => (event.kind === "action" ? [event.action.kind] : [])));
    expect([...actions].toSorted(), "样本要覆盖五种动作").toEqual(["all_in", "call", "check", "fold", "raise"]);

    for (const event of events) {
      const line = narrate(event, nameOf);
      expect(line, JSON.stringify(event)).toMatch(/[一-鿿]/);
      expect(line, JSON.stringify(event)).not.toMatch(/undefined|NaN|\[object/);
    }
    const lines = new Set(events.map((event) => narrate(event, nameOf)));
    expect(lines.size, "不同事件不该都是同一句").toBeGreaterThan(8);
  });

  it("摊牌前的播报不含任何座位的底牌，弃牌收场的整手都不含", () => {
    const hands = [play("摊牌前", "4", checkOrCall), play("摊牌前弃", "4", foldPreflop)];
    expect(hands[1]?.phase.kind === "complete" && hands[1].phase.ending).toBe("fold");
    for (const hand of hands) {
      const holes = hand.seats.flatMap((seat) => seat.hole);
      const firstShowdown = hand.events.findIndex((event) => event.kind === "showdown");
      const before = firstShowdown < 0 ? hand.events : hand.events.slice(0, firstShowdown);
      const text = before.map((event) => narrate(event, nameOf)).join("\n");
      expect(before.length).toBeGreaterThan(4);
      for (const card of holes) {
        const shown = `${card.charAt(0) === "T" ? "10" : card.charAt(0)}${{ s: "♠", h: "♥", d: "♦", c: "♣" }[card.charAt(1) as "s"]}`;
        expect(text, `${card} 不该出现在摊牌前的播报里`).not.toContain(shown);
      }
    }
  });

  it("摊牌那一句才亮出底牌", () => {
    const state = play("亮", "4", checkOrCall);
    const showdown = state.events.find((event) => event.kind === "showdown");
    expect(showdown).toBeDefined();
    if (showdown?.kind !== "showdown") return;
    const line = narrate(showdown, nameOf);
    expect(line).toContain(nameOf(showdown.seatId));
    expect(line).toMatch(/[♠♥♦♣]/);
  });
});
