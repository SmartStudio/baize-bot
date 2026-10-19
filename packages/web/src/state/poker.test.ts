import { describe, expect, it } from "vitest";
import { PokerTableView } from "@baize/shared";
import { isPokerTable, reducePoker } from "./poker.js";
import type { ReadyState } from "./types.js";

const table = (version: number, stack: number) =>
  PokerTableView.parse({
    groupId: "grp_table",
    status: "idle",
    version,
    seats: [
      {
        seat: 1,
        engineSeatId: "1",
        kind: "user",
        botId: null,
        name: "你",
        persona: null,
        hue: "sky",
        shape: "pillow",
        stack,
      },
    ],
    host: { botId: "bot_laobai", name: "老白", hue: "sky", shape: "pillow" },
    session: null,
    hand: null,
    hint: null,
    lastReview: null,
    reviewState: null,
    stats: { sessions: 0, sessionsWon: 0, net: 0 },
  });

// 牌桌这条只读写 poker，别的字段用不上。
const initial = { poker: {} } as unknown as ReadyState;

describe("牌桌视图", () => {
  it("先到 v2 后到 v1，停在 v2", () => {
    const v2 = reducePoker(initial, { type: "poker_table_set", table: table(2, 1200) });
    const late = reducePoker(v2, { type: "poker_table_set", table: table(1, 1000) });
    expect(late.poker["grp_table" as never]).toEqual(table(2, 1200));
  });

  it("同一版重复到达不换，新版照换", () => {
    const v1 = reducePoker(initial, { type: "poker_table_set", table: table(1, 1000) });
    const same = reducePoker(v1, { type: "poker_table_set", table: table(1, 999) });
    expect(same.poker["grp_table" as never]?.seats[0]?.stack).toBe(1000);
    const v2 = reducePoker(v1, { type: "poker_table_set", table: table(2, 1200) });
    expect(v2.poker["grp_table" as never]?.seats[0]?.stack).toBe(1200);
  });

  it("没拉过视图的群不算牌桌，拉过才算", () => {
    expect(isPokerTable(initial, "grp_table" as never)).toBe(false);
    const loaded = reducePoker(initial, { type: "poker_table_set", table: table(1, 1000) });
    expect(isPokerTable(loaded, "grp_table" as never)).toBe(true);
    expect(isPokerTable(loaded, "grp_other" as never)).toBe(false);
  });
});
