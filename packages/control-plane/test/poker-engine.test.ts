import { describe, expect, it } from "vitest";
import type { Card } from "../src/poker/cards.js";
import {
  apply,
  legalActions,
  newHand,
  replay,
  type Action,
  type HandState,
  type SeatId,
  type SeatInput,
} from "../src/poker/engine.js";

const blinds = { small: 5, big: 10 };

function seating(...entries: [SeatId, number][]): SeatInput[] {
  return entries.map(([id, stack]) => ({ id, stack }));
}

/** 换掉底牌和牌堆，公共牌按 board 的顺序发。 */
function rigged(input: SeatInput[], button: SeatId, holes: Record<SeatId, [Card, Card]>, board: Card[]): HandState {
  const state = newHand("rigged", input, button, blinds);
  for (const seat of state.seats) seat.hole = holes[seat.id] ?? seat.hole;
  state.deck = [...board];
  return state;
}

function play(state: HandState, ...moves: [SeatId, Action][]): HandState {
  return moves.reduce((current, [seatId, action]) => apply(current, seatId, action), state);
}

function stacks(state: HandState): Record<SeatId, number> {
  return Object.fromEntries(state.seats.map((seat) => [seat.id, seat.stack]));
}

function toAct(state: HandState): SeatId | null {
  return state.phase.kind === "betting" ? (state.phase.pending[0] ?? null) : null;
}

describe("发牌", () => {
  it("同一个种子两次开局发出的底牌和牌堆完全一样，换个种子就不一样", () => {
    const table = seating(["a", 100], ["b", 100], ["c", 100]);
    const first = newHand("周六晚上", table, "a", blinds);
    const second = newHand("周六晚上", table, "a", blinds);
    const other = newHand("周日晚上", table, "a", blinds);
    expect(second.seats.map((seat) => seat.hole)).toEqual(first.seats.map((seat) => seat.hole));
    expect(second.deck).toEqual(first.deck);
    expect(other.deck).not.toEqual(first.deck);
  });

  it("52 张牌不重不漏：底牌加牌堆正好一副", () => {
    const state = newHand("整副", seating(["a", 100], ["b", 100], ["c", 100]), "a", blinds);
    const all = [...state.seats.flatMap((seat) => seat.hole), ...state.deck];
    expect(new Set(all).size).toBe(52);
  });
});

describe("重放", () => {
  it("用种子和事件日志重放出来的状态和原状态完全相等", () => {
    const table = seating(["a", 200], ["b", 200], ["c", 200]);
    let state = newHand("重放", table, "a", blinds);
    state = play(state, ["a", { kind: "raise", amount: 30 }], ["b", { kind: "call" }], ["c", { kind: "fold" }]);
    while (state.phase.kind === "betting") state = apply(state, toAct(state) as SeatId, { kind: "check" });
    expect(state.phase).toMatchObject({ kind: "complete", ending: "showdown" });
    expect(replay("重放", table, "a", blinds, state.events)).toEqual(state);
  });

  it("日志被改过就重放失败", () => {
    const table = seating(["a", 200], ["b", 200]);
    const state = play(newHand("篡改", table, "a", blinds), ["a", { kind: "raise", amount: 40 }]);
    const forged = state.events.map((event) =>
      event.kind === "action" ? Object.assign({}, event, { put: 1 }) : event,
    );
    expect(() => replay("篡改", table, "a", blinds, forged)).toThrow("事件日志和重放结果对不上");
  });
});

describe("行动合法性", () => {
  it("翻前大盲有 option：前面都跟注时大盲还能过牌或加注，过牌后才发翻牌", () => {
    let state = newHand("option", seating(["a", 100], ["b", 100], ["c", 100]), "a", blinds);
    state = play(state, ["a", { kind: "call" }], ["b", { kind: "call" }]);
    expect(toAct(state)).toBe("c");
    const legal = legalActions(state, "c");
    expect(legal.kind === "your_turn" && legal.options.map((option) => option.kind)).toEqual([
      "fold",
      "check",
      "raise",
      "all_in",
    ]);
    expect(state.board).toEqual([]);
    state = apply(state, "c", { kind: "check" });
    expect(state.board).toHaveLength(3);
    expect(state.phase).toMatchObject({ kind: "betting", street: "flop" });
  });

  it("最小加注额是上一次加注的增量，不是加到的总额", () => {
    let state = newHand("最小加注", seating(["a", 500], ["b", 500], ["c", 500]), "a", blinds);
    state = apply(state, "a", { kind: "raise", amount: 30 });
    expect(legalActions(state, "b")).toMatchObject({
      kind: "your_turn",
      options: expect.arrayContaining([{ kind: "raise", min: 50, max: 500 }]),
    });
    state = apply(state, "b", { kind: "raise", amount: 50 });
    expect(legalActions(state, "c")).toMatchObject({
      options: expect.arrayContaining([{ kind: "raise", min: 70, max: 500 }]),
    });
  });

  it("加注不足最小额而且不是全下时抛错", () => {
    const state = apply(newHand("加不够", seating(["a", 500], ["b", 500], ["c", 500]), "a", blinds), "a", {
      kind: "raise",
      amount: 30,
    });
    expect(() => apply(state, "b", { kind: "raise", amount: 45 })).toThrow("加注额不够，最少要加到 50");
  });

  it("筹码不到最小加注额时可以全下，但不足额全下不让已表态的人再加", () => {
    let state = newHand("短码", seating(["a", 500], ["b", 40], ["c", 500]), "a", blinds);
    state = play(state, ["a", { kind: "raise", amount: 30 }]);
    // b 是小盲，40 筹码全下只比 30 多 10，不够 20 的完整加注。
    state = apply(state, "b", { kind: "all_in" });
    state = apply(state, "c", { kind: "call" });
    const legal = legalActions(state, "a");
    expect(legal.kind === "your_turn" && legal.options.map((option) => option.kind)).toEqual(["fold", "call"]);
    expect(() => apply(state, "a", { kind: "raise", amount: 100 })).toThrow("现在不能加注");
  });

  it("几次不足额全下累计够一个完整加注后，首加注者重新可以再加", () => {
    let state = newHand(
      "累计短全下",
      seating(["a", 500], ["b", 500], ["c", 500], ["d", 40], ["e", 50], ["f", 60], ["g", 500]),
      "g",
      blinds,
    );
    state = play(
      state,
      ["c", { kind: "raise", amount: 30 }],
      ["d", { kind: "all_in" }],
      ["e", { kind: "all_in" }],
      ["f", { kind: "all_in" }],
      ["g", { kind: "call" }],
      ["a", { kind: "call" }],
      ["b", { kind: "call" }],
    );
    // c 加到 30 之后，三次各加 10 的短全下把下注推到 60，比 c 表态时多出 30，够上一次完整加注的 20。
    expect(legalActions(state, "c")).toMatchObject({
      kind: "your_turn",
      toCall: 30,
      options: expect.arrayContaining([{ kind: "raise", min: 80, max: 500 }]),
    });
    state = apply(state, "c", { kind: "raise", amount: 80 });
    expect(state.phase).toMatchObject({ kind: "betting", currentBet: 80, pending: ["g", "a", "b"] });
  });

  it("累计短全下逐人判断：涨够完整加注的人能再加，在更高额度表态过的人仍只能跟或弃", () => {
    let state = newHand(
      "逐人重开",
      seating(["a", 500], ["b", 500], ["c", 500], ["d", 40], ["e", 500], ["f", 50], ["g", 500]),
      "g",
      blinds,
    );
    state = play(
      state,
      ["c", { kind: "raise", amount: 30 }],
      ["d", { kind: "all_in" }],
      ["e", { kind: "call" }],
      ["f", { kind: "all_in" }],
      ["g", { kind: "call" }],
      ["a", { kind: "call" }],
      ["b", { kind: "call" }],
    );
    // c 在 30 表态，下注涨到 50，多出 20；e 在 40 跟注，只多出 10。
    expect(legalActions(state, "c")).toMatchObject({
      options: expect.arrayContaining([{ kind: "raise", min: 70, max: 500 }]),
    });
    state = apply(state, "c", { kind: "call" });
    const legal = legalActions(state, "e");
    expect(legal.kind === "your_turn" && legal.options.map((option) => option.kind)).toEqual(["fold", "call"]);
    expect(() => apply(state, "e", { kind: "raise", amount: 70 })).toThrow("现在不能加注");
  });

  describe.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("座位编号叫 %s", (id) => {
    it("翻前首次说话就能加注和全下，不被当成已经表过态", () => {
      const state = newHand("原型编号", seating([id, 100], ["b", 100]), id, blinds);
      expect(legalActions(state, id)).toEqual({
        kind: "your_turn",
        street: "preflop",
        toCall: 5,
        options: [
          { kind: "fold" },
          { kind: "call", amount: 5 },
          { kind: "raise", min: 20, max: 100 },
          { kind: "all_in", amount: 95 },
        ],
      });
      expect(apply(state, id, { kind: "raise", amount: 20 }).phase).toMatchObject({ currentBet: 20, pending: ["b"] });
    });

    it("翻后新一街首次说话也能下注", () => {
      let state = newHand("原型编号翻后", seating([id, 100], ["b", 100]), id, blinds);
      state = play(state, [id, { kind: "call" }], ["b", { kind: "check" }], ["b", { kind: "check" }]);
      expect(legalActions(state, id)).toMatchObject({
        street: "flop",
        options: expect.arrayContaining([{ kind: "raise", min: 10, max: 90 }]),
      });
    });

    it("首加注者累计短全下够一个完整加注后能再加，不够时仍只能跟或弃", () => {
      let state = newHand(
        "原型编号累计",
        seating(["a", 500], ["b", 500], [id, 500], ["d", 40], ["e", 50], ["f", 60], ["g", 500]),
        "g",
        blinds,
      );
      state = play(state, [id, { kind: "raise", amount: 30 }], ["d", { kind: "all_in" }]);
      const closed = play(state, ["e", { kind: "fold" }], ["f", { kind: "fold" }], ["g", { kind: "call" }]);
      const afterCalls = play(closed, ["a", { kind: "call" }], ["b", { kind: "call" }]);
      const legal = legalActions(afterCalls, id);
      expect(legal.kind === "your_turn" && legal.options.map((option) => option.kind)).toEqual(["fold", "call"]);
      state = play(
        state,
        ["e", { kind: "all_in" }],
        ["f", { kind: "all_in" }],
        ["g", { kind: "call" }],
        ["a", { kind: "call" }],
        ["b", { kind: "call" }],
      );
      expect(legalActions(state, id)).toMatchObject({
        options: expect.arrayContaining([{ kind: "raise", min: 80, max: 500 }]),
      });
    });
  });

  it("没人下注时跟注、有人下注时过牌都被拒绝", () => {
    let state = newHand("非法", seating(["a", 100], ["b", 100], ["c", 100]), "a", blinds);
    expect(() => apply(state, "a", { kind: "check" })).toThrow("有人下注了，不能过牌");
    state = play(state, ["a", { kind: "call" }], ["b", { kind: "call" }], ["c", { kind: "check" }]);
    expect(toAct(state)).toBe("b");
    expect(() => apply(state, "b", { kind: "call" })).toThrow("没人下注，不能跟注");
  });

  it("没轮到的座位说话被拒绝", () => {
    const state = newHand("抢话", seating(["a", 100], ["b", 100], ["c", 100]), "a", blinds);
    expect(legalActions(state, "b")).toEqual({ kind: "waiting", toAct: "a" });
    expect(() => apply(state, "b", { kind: "fold" })).toThrow("还没轮到你，现在该 a 说话");
  });

  it("两人桌按钮是小盲，翻前先说话，翻后后说话", () => {
    let state = newHand("单挑", seating(["a", 100], ["b", 100]), "a", blinds);
    expect(state.events.slice(0, 2)).toEqual([
      { kind: "blind", seatId: "a", amount: 5 },
      { kind: "blind", seatId: "b", amount: 10 },
    ]);
    expect(toAct(state)).toBe("a");
    state = play(state, ["a", { kind: "call" }], ["b", { kind: "check" }]);
    expect(toAct(state)).toBe("b");
  });
});

describe("结束和结算", () => {
  it("只剩一人时不摊牌不发公共牌，直接收池", () => {
    const state = play(
      newHand("都弃", seating(["a", 100], ["b", 100], ["c", 100]), "a", blinds),
      ["a", { kind: "fold" }],
      ["b", { kind: "fold" }],
    );
    expect(state.phase).toEqual({ kind: "complete", ending: "fold", awards: [{ seatId: "c", amount: 15, pot: 0 }] });
    expect(state.board).toEqual([]);
    expect(state.events.some((event) => event.kind === "showdown" || event.kind === "street")).toBe(false);
    expect(stacks(state)).toEqual({ a: 100, b: 95, c: 105 });
    expect(legalActions(state, "c")).toEqual({ kind: "complete" });
  });

  it("三人全下、筹码各不相同时边池分三层，每层只给够得着的人", () => {
    let state = rigged(
      seating(["a", 100], ["b", 200], ["c", 300], ["d", 400]),
      "d",
      { a: ["As", "Ah"], b: ["Ks", "Kh"], c: ["Qs", "Qh"], d: ["7c", "2d"] },
      ["3c", "4d", "8h", "9s", "Jd"],
    );
    state = play(
      state,
      ["c", { kind: "all_in" }],
      ["d", { kind: "call" }],
      ["a", { kind: "all_in" }],
      ["b", { kind: "all_in" }],
    );
    expect(state.phase).toEqual({
      kind: "complete",
      ending: "showdown",
      awards: [
        { seatId: "a", amount: 400, pot: 0 },
        { seatId: "b", amount: 300, pot: 1 },
        { seatId: "c", amount: 200, pot: 2 },
      ],
    });
    expect(stacks(state)).toEqual({ a: 400, b: 300, c: 200, d: 100 });
  });

  it("平分时除不尽的零头给按钮之后的第一位赢家", () => {
    let state = rigged(
      seating(["a", 100], ["b", 100], ["c", 100]),
      "a",
      { a: ["2c", "3d"], b: ["4c", "5d"], c: ["2d", "3c"] },
      ["As", "Ks", "Qs", "Js", "Ts"],
    );
    state = play(state, ["a", { kind: "call" }], ["b", { kind: "fold" }], ["c", { kind: "check" }]);
    while (state.phase.kind === "betting") state = apply(state, toAct(state) as SeatId, { kind: "check" });
    expect(state.phase).toMatchObject({
      awards: [
        { seatId: "c", amount: 13, pot: 0 },
        { seatId: "a", amount: 12, pot: 0 },
      ],
    });
    expect(stacks(state)).toEqual({ a: 102, b: 95, c: 103 });
  });

  it("单挑大盲筹码不足小盲时，小盲不用跟一笔不存在的注，直接发完牌摊牌并退回多出的部分", () => {
    const state = newHand("短大盲", seating(["a", 100], ["b", 3]), "a", blinds);
    expect(legalActions(state, "a")).toEqual({ kind: "complete" });
    expect(() => apply(state, "a", { kind: "fold" })).toThrow("这手牌已经结束了");
    expect(state.board).toHaveLength(5);
    expect(state.phase).toMatchObject({
      kind: "complete",
      ending: "showdown",
      awards: expect.arrayContaining([{ seatId: "a", amount: 2, pot: 1 }]),
    });
    expect(state.seats.reduce((sum, seat) => sum + seat.stack, 0)).toBe(103);
  });

  it("多人桌短大盲全下、其余人弃到只剩小盲时，小盲也不用补齐名义大盲", () => {
    let state = newHand("多人短大盲", seating(["a", 100], ["b", 100], ["c", 3]), "a", blinds);
    expect(legalActions(state, "a")).toMatchObject({ kind: "your_turn", toCall: 10 });
    state = apply(state, "a", { kind: "fold" });
    expect(legalActions(state, "b")).toEqual({ kind: "complete" });
    expect(state.phase).toMatchObject({
      kind: "complete",
      ending: "showdown",
      awards: expect.arrayContaining([{ seatId: "b", amount: 2, pot: 1 }]),
    });
  });

  it("大码跟注短码全下时只跟到对方全下的额度，摊牌牌大的拿走整个底池", () => {
    let state = rigged(seating(["a", 100], ["b", 300]), "a", { a: ["As", "Ah"], b: ["Ks", "Kh"] }, [
      "3c",
      "4d",
      "8h",
      "9s",
      "Jd",
    ]);
    state = play(state, ["a", { kind: "all_in" }], ["b", { kind: "call" }]);
    expect(state.phase).toMatchObject({ ending: "showdown", awards: [{ seatId: "a", amount: 200, pot: 0 }] });
    expect(stacks(state)).toEqual({ a: 200, b: 200 });
  });
});

describe("输入边界", () => {
  it("开局后改传入的盲注对象，不影响已经开出的这手牌和重放", () => {
    const table = seating(["a", 200], ["b", 200]);
    const mutable = { small: 5, big: 10 };
    const state = newHand("外部盲注", table, "a", mutable);
    mutable.big = 99;
    expect(state.blinds).toEqual({ small: 5, big: 10 });
    expect(replay("外部盲注", table, "a", blinds, state.events)).toEqual(state);
  });

  it("执行后改传入的动作对象，返回状态的日志不变，照样能重放", () => {
    const table = seating(["a", 200], ["b", 200]);
    const action: { kind: string } = { kind: "call" };
    const state = apply(newHand("外部动作", table, "a", blinds), "a", action as Action);
    action.kind = "fold";
    expect(state.events.at(-1)).toEqual({ kind: "action", seatId: "a", action: { kind: "call" }, put: 5 });
    expect(replay("外部动作", table, "a", blinds, state.events)).toEqual(state);
  });

  it("筹码和盲注超出安全整数范围、或整桌筹码加起来超出时开局被拒绝", () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    expect(() => newHand("大数", seating(["a", Number.MAX_VALUE], ["b", 100]), "a", blinds)).toThrow(
      "每个座位开局都要有正整数筹码",
    );
    expect(() => newHand("大数", seating(["a", unsafe], ["b", 100]), "a", blinds)).toThrow(
      "每个座位开局都要有正整数筹码",
    );
    expect(() =>
      newHand("大数", seating(["a", Number.MAX_SAFE_INTEGER], ["b", Number.MAX_SAFE_INTEGER]), "a", blinds),
    ).toThrow("整桌筹码总数太大");
    expect(() => newHand("大数", seating(["a", 100], ["b", 100]), "a", { small: 5, big: unsafe })).toThrow(
      "盲注要是正整数",
    );
    expect(() => newHand("大数", seating(["a", 100], ["b", 100]), "a", { small: unsafe, big: unsafe })).toThrow(
      "盲注要是正整数",
    );
  });
});
