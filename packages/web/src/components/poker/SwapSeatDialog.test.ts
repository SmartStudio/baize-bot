import { describe, expect, it } from "vitest";
import { POKER_PERSONAS, PokerTableView, type PokerPersona } from "@baize/shared";
import { swapCandidates } from "./SwapSeatDialog.js";

const tableWith = (personas: readonly PokerPersona[]) =>
  PokerTableView.parse({
    groupId: "grp_table",
    status: "idle",
    version: 1,
    seats: [
      {
        seat: 4,
        engineSeatId: "4",
        kind: "user",
        botId: null,
        name: "你",
        persona: null,
        hue: "sky",
        shape: "pillow",
        stack: 2000,
      },
      ...personas.map((persona, index) => ({
        seat: index + 1,
        engineSeatId: String(index + 1),
        kind: "bot",
        botId: `bot_poker_${persona}`,
        name: persona,
        persona,
        hue: POKER_PERSONAS[persona].hue,
        shape: POKER_PERSONAS[persona].shape,
        stack: 2000,
      })),
    ],
    host: { botId: "bot_laobai", name: "老白", hue: "sky", shape: "pillow" },
    session: null,
    hand: null,
    hint: null,
    lastReview: null,
    reviewState: null,
    stats: { sessions: 0, sessionsWon: 0, net: 0 },
  });

describe("换人候选", () => {
  it("桌上的牌友和你都不列，老白不入座也不列", () => {
    expect(swapCandidates(tableWith(["leopard", "jasmine", "dalu"]))).toEqual(["old_k", "xiaoqi"]);
  });

  it("换走一位以后，被换下的人又能被挑", () => {
    expect(swapCandidates(tableWith(["leopard", "xiaoqi", "dalu"]))).toEqual(["old_k", "jasmine"]);
  });
});
