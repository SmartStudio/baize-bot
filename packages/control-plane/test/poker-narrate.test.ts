import { describe, expect, it } from "vitest";
import { apply, newHand, type Action, type Event, type HandState, type SeatId } from "../src/poker/engine.js";
import { hostLines, narrate, talkRevealsCards } from "../src/poker/narrate.js";

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

describe("hostLines", () => {
  it("一手打到摊牌，老白只说开场、三街和结算五句，不说任何单个动作", () => {
    const hand = play("老白摊牌", "4", checkOrCall);
    const lines = hostLines(hand, 0, nameOf);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("新一手，你坐庄，阿豹小盲 5，老K大盲 10");
    expect(lines.slice(1, 4)).toEqual([
      expect.stringMatching(/^翻牌：\S+ \S+ \S+，底池 40$/),
      expect.stringMatching(/^转牌：\S+，底池 40$/),
      expect.stringMatching(/^河牌：\S+，底池 40$/),
    ]);
    expect(lines[4]).toMatch(/^摊牌：/);
    for (const name of ["阿豹", "老K", "茉莉", "你"]) expect(lines[4]).toContain(name);
    expect(lines[4], "赢家带赢的数").toMatch(/赢 \d+/);
    expect(lines.join("\n")).not.toMatch(/过牌|跟注|弃牌|加注/);
  });

  it("从中间落的事件只说这次新出的关键处，没到新一街就一句不说", () => {
    const hand = play("老白分段", "4", checkOrCall);
    const flop = hand.events.findIndex((event) => event.kind === "street");
    expect(hostLines(hand, 2, nameOf).slice(0, 1)).toEqual([expect.stringMatching(/^翻牌：/)]);
    const beforeFlop = { ...hand, events: hand.events.slice(0, flop) };
    expect(hostLines(beforeFlop, 2, nameOf)).toEqual([]);
  });

  it("弃牌收场只说一句谁收下底池", () => {
    const hand = play("老白弃牌", "4", foldPreflop);
    expect(hostLines(hand, 2, nameOf)).toEqual(["其他人都弃牌，老K收下底池 15"]);
  });

  it("兜底动作并进这次的第一句；这次没有要说的就不提", () => {
    const hand = play("老白兜底", "4", checkOrCall);
    const flop = hand.events.findIndex((event) => event.kind === "street");
    const closing = flop - 1;
    const [first] = hostLines({ ...hand, events: hand.events.slice(0, flop + 1) }, closing, nameOf, "超时");
    expect(first).toMatch(/^老K（超时）过牌，翻牌：/);
    expect(hostLines({ ...hand, events: hand.events.slice(0, closing + 1) }, closing, nameOf, "超时")).toEqual([]);
  });
});

describe("talkRevealsCards", () => {
  it("只说牌力和态度的台词、金额和牌友名字都能上桌", () => {
    for (const text of ["这把我稳了", "加到 80，你敢跟吗", "老K 别装了", "跟 120"])
      expect(talkRevealsCards(text, []), text).toBe(false);
  });
  it("点名公共牌上已有的牌和点数可以说", () => {
    expect(talkRevealsCards("Q♣ 这张吓人", ["Qc", "Jc", "3h"])).toBe(false);
    expect(talkRevealsCards("中了J", ["Qc", "Jc", "3h"])).toBe(false);
  });
  it("点名公共牌以外的牌或点数一律不公开", () => {
    for (const text of ["我有 A♠", "方块J", "Jd 在手", "中了K", "口袋 10", "AK 同花"])
      expect(talkRevealsCards(text, ["Qc", "Jc", "3h"]), text).toBe(true);
  });
});
