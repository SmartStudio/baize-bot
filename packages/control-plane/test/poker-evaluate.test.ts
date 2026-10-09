import { describe, expect, it } from "vitest";
import type { Card } from "../src/poker/cards.js";
import { compareHands, describeHand, evaluate } from "../src/poker/evaluate.js";

function hand(hole: [Card, Card], board: Card[]) {
  return evaluate(hole, board);
}

describe("牌力", () => {
  it("A 2 3 4 5 认作顺子，顶张算 5，输给 6 高的顺子、赢三条", () => {
    const wheel = hand(["As", "2d"], ["3c", "4h", "5s", "Kd", "9c"]);
    expect(wheel.category).toBe("straight");
    expect(describeHand(wheel)).toBe("顺子，5 高");
    const sixHigh = hand(["6s", "2d"], ["3c", "4h", "5s", "Kd", "9c"]);
    const trips = hand(["9s", "9d"], ["3c", "4h", "5s", "Kd", "9c"]);
    expect(compareHands(sixHigh, wheel)).toBeGreaterThan(0);
    expect(compareHands(wheel, trips)).toBeGreaterThan(0);
  });

  it("同花顺里的 A 也能当 1", () => {
    expect(hand(["Ah", "2h"], ["3h", "4h", "5h", "Kd", "Kc"]).category).toBe("straight_flush");
  });

  it("两手同花顶张一样时一张张往下比踢脚", () => {
    const board: Card[] = ["Ah", "9h", "6h", "2h", "Kc"];
    const queen = hand(["Qh", "3c"], board);
    const jack = hand(["Jh", "Ks"], board);
    expect(queen.category).toBe("flush");
    expect(jack.category).toBe("flush");
    expect(compareHands(queen, jack)).toBeGreaterThan(0);
    expect(describeHand(queen)).toBe("同花，A 高");
  });

  it("公共牌就是最好的五张时双方平手", () => {
    const board: Card[] = ["As", "Ks", "Qs", "Js", "Ts"];
    expect(compareHands(hand(["2c", "3d"], board), hand(["4c", "5d"], board))).toBe(0);
  });

  it("一对一样大时比剩下的三张踢脚", () => {
    const board: Card[] = ["Ac", "Ad", "9s", "6h", "3c"];
    expect(compareHands(hand(["Kc", "2d"], board), hand(["Qc", "Jd"], board))).toBeGreaterThan(0);
  });

  it("两对先比大对再比小对再比踢脚", () => {
    const board: Card[] = ["Kc", "Kd", "7s", "7h", "2c"];
    expect(compareHands(hand(["Qc", "3d"], board), hand(["Jc", "Td"], board))).toBeGreaterThan(0);
    expect(describeHand(hand(["Qc", "3d"], board))).toBe("两对，K 和 7");
  });

  it("葫芦先比三条再比对子", () => {
    const tripsKings = hand(["Ks", "Kh"], ["Kc", "2d", "2s", "9h", "4c"]);
    const tripsQueens = hand(["Qs", "Qh"], ["Qc", "Ad", "As", "9h", "4c"]);
    expect(tripsKings.category).toBe("full_house");
    expect(compareHands(tripsKings, tripsQueens)).toBeGreaterThan(0);
  });

  it("七张里挑最好的五张，牌型从大到小排得对", () => {
    const ladder: [Card, Card, Card[]][] = [
      ["2c", "7d", ["9s", "Jh", "Kc", "4d", "3s"]],
      ["2c", "2d", ["9s", "Jh", "Kc", "4d", "3s"]],
      ["2c", "2d", ["9s", "9h", "Kc", "4d", "3s"]],
      ["2c", "2d", ["2s", "9h", "Kc", "4d", "3s"]],
      ["5c", "6d", ["2s", "9h", "Kc", "4d", "3s"]],
      ["5c", "6c", ["2c", "9c", "Kd", "4d", "3c"]],
      ["2c", "2d", ["2s", "9h", "9c", "4d", "3s"]],
      ["2c", "2d", ["2s", "2h", "Kc", "4d", "3s"]],
      ["5c", "6c", ["2c", "4c", "3c", "Kd", "Kh"]],
    ];
    const categories = ladder.map(([a, b, board]) => hand([a, b], board).category);
    expect(categories).toEqual([
      "high_card",
      "pair",
      "two_pair",
      "three_of_a_kind",
      "straight",
      "flush",
      "full_house",
      "four_of_a_kind",
      "straight_flush",
    ]);
  });
});
