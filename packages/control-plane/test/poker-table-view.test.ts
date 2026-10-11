import { PokerHandId, PokerSessionId, PokerTableView } from "@baize/shared";
import type { BotId, GroupId } from "@baize/shared";
import { describe, expect, it } from "vitest";
import { apply, newHand, type HandState, type SeatId } from "../src/poker/engine.js";
import { buildTableView, type TableState } from "../src/poker/table-view.js";

const blinds = { small: 5, big: 10 };
const engineSeats = ["1", "2", "3", "4"].map((id) => ({ id, stack: 200 }));
const SEED = "绝密种子-9f3a";

const table: TableState = {
  groupId: "g-table" as GroupId,
  status: "in_hand",
  version: 7,
  seats: [
    { seat: 1, kind: "bot", botId: "b-1" as BotId, name: "阿豹", persona: "leopard", hue: "coral", stack: 2000 },
    { seat: 2, kind: "bot", botId: "b-2" as BotId, name: "老K", persona: "old_k", hue: "violet", stack: 2000 },
    { seat: 3, kind: "bot", botId: "b-3" as BotId, name: "茉莉", persona: "jasmine", hue: "pink", stack: 2000 },
    { seat: 4, kind: "user", botId: null, name: "你", persona: null, hue: "sky", stack: 2000 },
  ],
  host: { botId: "b-h" as BotId, name: "老白", hue: "sky" },
  session: { id: PokerSessionId.parse("s-1"), handCount: 1, net: 0 },
  hint: null,
  lastReview: null,
  stats: { sessions: 0, sessionsWon: 0, net: 0 },
};

const handRow = (state: HandState, turnDeadline: Date | null = null) => ({
  id: PokerHandId.parse("h-1"),
  number: 1,
  version: 3,
  state,
  turnDeadline,
});

function otherHoles(state: HandState, seat: SeatId): string[] {
  return state.seats.filter((candidate) => candidate.id !== seat).flatMap((candidate) => candidate.hole);
}

describe("buildTableView", () => {
  it("每一街序列化后找不到别的座位的底牌和种子，自己的底牌在", () => {
    let state = newHand(SEED, engineSeats, "4", blinds);
    let streets = 0;
    for (;;) {
      const json = JSON.stringify(buildTableView(table, handRow(state), 4));
      expect(json, "种子").not.toContain(SEED);
      expect(json, "种子字段名").not.toMatch(/seed|deck/i);
      for (const card of otherHoles(state, "4")) expect(json).not.toContain(`"${card}"`);
      for (const card of state.seats.find((seat) => seat.id === "4")?.hole ?? []) expect(json).toContain(`"${card}"`);
      streets += 1;
      if (state.phase.kind !== "betting" || state.board.length === 5) break;
      const seat = state.phase.pending[0] as SeatId;
      const me = state.seats.find((candidate) => candidate.id === seat);
      state = apply(
        state,
        seat,
        me !== undefined && state.phase.currentBet > me.committed ? { kind: "call" } : { kind: "check" },
      );
    }
    expect(streets).toBeGreaterThan(4);
  });

  it("弃牌收场的那手，赢家以外的底牌也一直不露", () => {
    let state = newHand(SEED, engineSeats, "4", blinds);
    for (const seat of ["3", "4", "1"] as const) state = apply(state, seat, { kind: "fold" });
    expect(state.phase.kind).toBe("complete");
    const json = JSON.stringify(buildTableView(table, handRow(state), 4));
    for (const card of otherHoles(state, "4")) expect(json).not.toContain(`"${card}"`);
  });

  it("输出能被 shared 的 PokerTableView 解析，且就是用户视角的 viewFor", () => {
    const state = newHand(SEED, engineSeats, "4", blinds);
    const view = buildTableView(table, handRow(state), 4);
    expect(PokerTableView.parse(view)).toEqual(view);
    expect(view.hand?.view.seatId).toBe("4");
    expect(view.hand?.view.legal.kind).toBe("waiting");
    expect(view.version).toBe(7);
    expect(view.hand).toMatchObject({ id: "h-1", number: 1, version: 3 });
  });

  it("toAct 换算成座位号，座位筹码取手上的实时值", () => {
    const state = newHand(SEED, engineSeats, "4", blinds);
    const view = buildTableView(table, handRow(state), 4);
    expect(view.hand?.toAct).toBe(3);
    const stacks = Object.fromEntries(view.seats.map((seat) => [seat.seat, seat.stack]));
    expect(stacks, "1 号小盲 5、2 号大盲 10 已经推进底池").toEqual({ 1: 195, 2: 190, 3: 200, 4: 200 });
  });

  it("牌友行动时带期限，轮到你时没有期限，哪怕调用方传了", () => {
    const deadline = new Date("2026-10-10T20:01:00.000Z");
    const botTurn = newHand(SEED, engineSeats, "4", blinds);
    expect(buildTableView(table, handRow(botTurn, deadline), 4).hand?.deadline).toBe("2026-10-10T20:01:00.000Z");
    const userTurn = apply(botTurn, "3", { kind: "call" });
    expect(userTurn.phase.kind === "betting" && userTurn.phase.pending[0]).toBe("4");
    const view = buildTableView(table, handRow(userTurn, deadline), 4);
    expect(view.hand?.toAct).toBe(4);
    expect(view.hand?.deadline).toBeNull();
  });

  it("没有在打的手时 hand 为 null，其余字段原样带过", () => {
    const view = buildTableView({ ...table, status: "idle" }, null, 4);
    expect(view.hand).toBeNull();
    expect(view.status).toBe("idle");
    expect(view.stats).toEqual(table.stats);
    expect(view.seats).toEqual(table.seats);
  });

  it("手牌行上多出来的字段不会漏进输出", () => {
    const state = newHand(SEED, engineSeats, "4", blinds);
    const leaky = { ...handRow(state), seed: SEED, deck: state.deck, hole: state.seats.map((seat) => seat.hole) };
    const json = JSON.stringify(buildTableView(table, leaky, 4));
    expect(json).not.toContain(SEED);
    for (const card of state.deck) expect(json).not.toContain(`"${card}"`);
  });
});
