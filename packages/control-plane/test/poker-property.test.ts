import { describe, expect, it } from "vitest";
import { seededRng } from "../src/poker/cards.js";
import { apply, legalActions, newHand, replay, type Action, type HandState } from "../src/poker/engine.js";

const HANDS = 2000;
const MAX_ACTIONS = 400;

function randomAction(state: HandState, rng: () => number): { seatId: string; action: Action } {
  if (state.phase.kind !== "betting") throw new Error("已结束的牌局不该再选动作");
  const seatId = state.phase.pending[0] as string;
  const legal = legalActions(state, seatId);
  if (legal.kind !== "your_turn") throw new Error(`pending 第一位 ${seatId} 却不能说话`);
  const option = legal.options[Math.floor(rng() * legal.options.length)];
  if (option === undefined) throw new Error("没有可选动作");
  if (option.kind === "raise") {
    return {
      seatId,
      action: { kind: "raise", amount: option.min + Math.floor(rng() * (option.max - option.min + 1)) },
    };
  }
  return { seatId, action: { kind: option.kind } };
}

describe("随机牌局", () => {
  it(`${HANDS} 手随机合法动作：每手都能结束，筹码守恒，没有负筹码，日志能重放回同一状态`, () => {
    const rng = seededRng("属性测试");
    const seen = { fold: 0, showdown: 0, sidePots: 0 };
    for (let hand = 0; hand < HANDS; hand++) {
      const count = 2 + Math.floor(rng() * 5);
      const table = Array.from({ length: count }, (_, i) => ({ id: `s${i}`, stack: 1 + Math.floor(rng() * 400) }));
      const total = table.reduce((sum, seat) => sum + seat.stack, 0);
      const button = `s${Math.floor(rng() * count)}`;
      const small = 1 + Math.floor(rng() * 5);
      const blinds = { small, big: small * 2 };
      const seed = `第${hand}手`;

      let state = newHand(seed, table, button, blinds);
      let steps = 0;
      while (state.phase.kind === "betting") {
        expect(steps++, `${seed} 超过 ${MAX_ACTIONS} 步还没结束`).toBeLessThan(MAX_ACTIONS);
        const { seatId, action } = randomAction(state, rng);
        state = apply(state, seatId, action);
        const inPlay = state.seats.reduce((sum, seat) => sum + seat.stack + seat.contributed, 0);
        if (state.phase.kind === "betting") expect(inPlay, `${seed} 进行中筹码不守恒`).toBe(total);
        expect(state.seats.every((seat) => seat.stack >= 0)).toBe(true);
      }
      expect(
        state.seats.reduce((sum, seat) => sum + seat.stack, 0),
        `${seed} 结算后筹码不守恒`,
      ).toBe(total);
      expect(state.board.length === 5 || state.phase.ending === "fold", `${seed} 摊牌前没发完公共牌`).toBe(true);
      seen[state.phase.ending]++;
      if (state.phase.awards.some((award) => award.pot > 0)) seen.sidePots++;
      if (hand % 50 === 0) expect(replay(seed, table, button, blinds, state.events)).toEqual(state);
    }
    expect(
      Math.min(seen.fold, seen.showdown, seen.sidePots),
      `随机动作要覆盖弃牌收池、摊牌和边池：${JSON.stringify(seen)}`,
    ).toBeGreaterThan(50);
  });
});
