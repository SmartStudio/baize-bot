import { describe, expect, it } from "vitest";
import { apply, legalActions, newHand } from "../src/poker/engine.js";
import { fallbackAction } from "../src/poker/fallback.js";
import { pickKeyHands } from "../src/poker/keyhands.js";
import { engineSeatId, seatNoOf, seatNextHand } from "../src/poker/seating.js";

const stacks = (...values: number[]) => values.map((stack, index) => ({ seat: (index + 1) as 1 | 2 | 3 | 4, stack }));

describe("兜底动作", () => {
  const blinds = { small: 5, big: 10 };
  const seats = ["1", "2", "3", "4"].map((id) => ({ id, stack: 200 }));

  it("能过牌就过牌", () => {
    // 按钮在 4 号时 1 号小盲、2 号大盲，翻前大盲跟注一圈后轮到 2 号，可以过牌
    let state = newHand("兜底", seats, "4", blinds);
    state = apply(state, "3", { kind: "call" });
    state = apply(state, "4", { kind: "call" });
    state = apply(state, "1", { kind: "call" });
    const legal = legalActions(state, "2");
    expect(legal.kind === "your_turn" && legal.options.some((option) => option.kind === "check")).toBe(true);
    expect(fallbackAction(legal)).toEqual({ kind: "check" });
  });

  it("面对下注不能过牌，就弃牌", () => {
    const state = newHand("兜底弃", seats, "4", blinds);
    const legal = legalActions(state, "3");
    expect(legal.kind === "your_turn" && legal.toCall).toBeGreaterThan(0);
    expect(fallbackAction(legal)).toEqual({ kind: "fold" });
  });

  it("没轮到或已结束时没有兜底可言", () => {
    const state = newHand("兜底错", seats, "4", blinds);
    expect(() => fallbackAction(legalActions(state, "4"))).toThrow("没有轮到");
  });
});

describe("座位和庄位", () => {
  it("引擎座位 id 和座位号互相转换，不是座位号的 id 报错", () => {
    expect(engineSeatId(3)).toBe("3");
    expect(seatNoOf("3")).toBe(3);
    expect(() => seatNoOf("9")).toThrow("不是座位号");
    expect(() => seatNoOf("x")).toThrow("不是座位号");
  });

  it("庄位逐手顺时针轮转，第一手落在第一个有筹码的座位", () => {
    expect(seatNextHand(stacks(100, 100, 100, 100), null, 2000).button).toBe(1);
    expect(seatNextHand(stacks(100, 100, 100, 100), 1, 2000).button).toBe(2);
    expect(seatNextHand(stacks(100, 100, 100, 100), 4, 2000).button).toBe(1);
  });

  it("庄位轮转跳过没有筹码的座位", () => {
    expect(seatNextHand(stacks(100, 0, 0, 100), 1, 2000).button).toBe(4);
    expect(seatNextHand(stacks(0, 100, 100, 100), 4, 2000).button).toBe(2);
    expect(seatNextHand(stacks(0, 100, 100, 100), null, 2000).button).toBe(2);
  });

  it("破产座位补回起始筹码并记一次，再算下一手不重复记", () => {
    const input = stacks(0, 350, 0, 1650);
    const first = seatNextHand(input, 4, 2000);
    expect(first.seats).toEqual(stacks(2000, 350, 2000, 1650));
    expect(first.rebuys).toEqual([
      { seat: 1, amount: 2000 },
      { seat: 3, amount: 2000 },
    ]);
    expect(input, "不改传入的座位").toEqual(stacks(0, 350, 0, 1650));
    const second = seatNextHand(first.seats, first.button, 2000);
    expect(second.rebuys).toEqual([]);
  });

  it("补码后的座位交给引擎不会因零筹码被拒", () => {
    const next = seatNextHand(stacks(0, 100, 100, 100), 4, 2000);
    const hand = newHand(
      "补码",
      next.seats.map((seat) => ({ id: engineSeatId(seat.seat), stack: seat.stack })),
      engineSeatId(next.button),
      { small: 10, big: 20 },
    );
    expect(hand.seats).toHaveLength(4);
  });
});

const hands = (...deltas: number[]) => deltas.map((delta, index) => ({ number: index + 1, delta }));

describe("关键手", () => {
  it("按筹码变化的绝对值挑三手，结果按手序排", () => {
    const picked = pickKeyHands(hands(10, -300, 40, 250, -20, 120));
    expect(picked.map((hand) => hand.number)).toEqual([2, 4, 6]);
  });

  it("平手按手序，先打的先入选", () => {
    const picked = pickKeyHands(hands(100, -100, 100, -100, 100));
    expect(picked.map((hand) => hand.number)).toEqual([1, 2, 3]);
  });

  it("不足三手有几手挑几手，没打也不报错", () => {
    expect(pickKeyHands(hands(5, -5)).map((hand) => hand.number)).toEqual([1, 2]);
    expect(pickKeyHands([])).toEqual([]);
  });

  it("不改传入的数组，原样带回额外字段", () => {
    const input = [
      { number: 1, delta: 5, tag: "a" },
      { number: 2, delta: -50, tag: "b" },
    ];
    const copy = structuredClone(input);
    expect(pickKeyHands(input, 1)).toEqual([{ number: 2, delta: -50, tag: "b" }]);
    expect(input).toEqual(copy);
  });
});
