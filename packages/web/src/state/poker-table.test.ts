import { describe, expect, it } from "vitest";
import { PokerTableView, type PokerEvent } from "@baize/shared";
import { actionBarOf, feltOf, quickAction, raiseCheck } from "./poker.js";

type SeatSpec = {
  id: string;
  stack: number;
  committed: number;
  status?: "active" | "folded" | "all_in";
  shown?: [string, string];
};

// 引擎座位 id 由视图的 engineSeatId 给出，控制面是 "1" 到 "4"，mock 是 "s1" 到 "s4"，Web 不猜。
const handTable = (
  options: {
    prefix?: string;
    version?: number;
    street?: "preflop" | "flop" | "turn" | "river" | "complete";
    board?: string[];
    toAct?: number | null;
    legal?: unknown;
    seats?: Record<number, Partial<SeatSpec>>;
    events?: PokerEvent[];
    awards?: unknown;
  } = {},
) => {
  const prefix = options.prefix ?? "";
  const seatOf = (no: number): SeatSpec => ({
    id: `${prefix}${no}`,
    stack: 2000,
    committed: 0,
    ...options.seats?.[no],
  });
  return PokerTableView.parse({
    groupId: "grp_table",
    status: options.street === "complete" ? "idle" : "in_hand",
    version: options.version ?? 5,
    seats: [
      {
        seat: 1,
        kind: "bot",
        botId: "bot_a",
        name: "阿豹",
        persona: "leopard",
        hue: "coral",
        shape: "triangle",
        stack: 2000,
      },
      {
        seat: 2,
        kind: "bot",
        botId: "bot_b",
        name: "茉莉",
        persona: "jasmine",
        hue: "pink",
        shape: "leaf",
        stack: 2000,
      },
      {
        seat: 3,
        kind: "bot",
        botId: "bot_c",
        name: "大刘",
        persona: "dalu",
        hue: "tangerine",
        shape: "pudding",
        stack: 2000,
      },
      { seat: 4, kind: "user", botId: null, name: "你", persona: null, hue: "lime", shape: "pillow", stack: 2000 },
    ].map((seat) => ({ ...seat, engineSeatId: `${prefix}${seat.seat}` })),
    host: { botId: "bot_laobai", name: "老白", hue: "sky", shape: "pillow" },
    session: { id: "ses_1", handCount: 1, net: 0 },
    hand: {
      id: "hand_1",
      number: 1,
      version: (options.events ?? []).length,
      toAct: options.toAct === undefined ? 4 : options.toAct,
      deadline: null,
      view: {
        seatId: `${prefix}4`,
        position: "button",
        hole: ["As", "Kd"],
        stack: 2000,
        summary: "你在按钮位，A K 不同花",
        street: options.street ?? "preflop",
        board: options.board ?? [],
        pot: 150,
        blinds: { small: 10, big: 20 },
        seats: [1, 2, 3, 4].map((no) => {
          const seat = seatOf(no);
          return {
            seatId: seat.id,
            position: "middle",
            stack: seat.stack,
            committed: seat.committed,
            status: seat.status ?? "active",
            shown: seat.shown ?? null,
          };
        }),
        legal: options.legal ?? {
          kind: "your_turn",
          street: "preflop",
          toCall: 60,
          options: [{ kind: "fold" }, { kind: "call", amount: 60 }, { kind: "raise", min: 100, max: 2000 }],
        },
        awards: options.awards ?? null,
        events: options.events ?? [],
      },
    },
    hint: null,
    lastReview: null,
    reviewState: null,
    stats: { sessions: 0, sessionsWon: 0, net: 0 },
  });
};

const idle = () => PokerTableView.parse({ ...handTable(), status: "idle", hand: null });

describe("牌桌上的牌", () => {
  it.each(["", "s"])("对手只有背面，只有你的两张看得见（座位 id 前缀 %j）", (prefix) => {
    const felt = feltOf(handTable({ prefix }));
    expect(felt?.opponents.map((seat) => [seat.seat, seat.name, seat.hasCards, seat.cards])).toEqual([
      [1, "阿豹", true, null],
      [2, "茉莉", true, null],
      [3, "大刘", true, null],
    ]);
    expect(felt?.me?.cards).toEqual(["As", "Kd"]);
  });

  it("座位和引擎里的人按视图给的 engineSeatId 对上，Web 不从座位号猜 id", () => {
    const felt = feltOf(
      handTable({
        prefix: "seat-",
        seats: { 2: { status: "folded", stack: 1500 }, 3: { committed: 60, stack: 1940 } },
        events: [{ kind: "action", seatId: "seat-3", action: { kind: "raise", amount: 60 }, put: 60 }],
      }),
    );
    expect(felt?.opponents.map((seat) => [seat.seat, seat.stack, seat.bet, seat.status, seat.label])).toEqual([
      [1, 2000, 0, "active", ""],
      [2, 1500, 0, "folded", "弃牌"],
      [3, 1940, 60, "active", "加注到 60"],
    ]);
  });

  it("公共牌固定五个槽，没发的是 null", () => {
    expect(feltOf(handTable({ street: "flop", board: ["Ks", "9h", "4c"] }))?.board).toEqual([
      "Ks",
      "9h",
      "4c",
      null,
      null,
    ]);
  });

  it("弃牌的对手没有牌面也没有背面，标弃牌", () => {
    const felt = feltOf(handTable({ seats: { 2: { status: "folded" } } }));
    const folded = felt?.opponents.find((seat) => seat.seat === 2);
    expect(folded).toMatchObject({ hasCards: false, status: "folded", label: "弃牌" });
  });

  it("摊牌亮出的牌面翻开，标签写各家牌型，赢家标赢了多少，桌上不再画下注", () => {
    const felt = feltOf(
      handTable({
        street: "complete",
        board: ["Ks", "9h", "4c", "2d", "7s"],
        seats: { 1: { shown: ["Kh", "Qc"], committed: 200 }, 4: { shown: ["As", "Kd"], committed: 200 } },
        toAct: null,
        legal: { kind: "complete" },
        awards: [{ seatId: "4", amount: 800, pot: 0 }],
      }),
    );
    const leopard = felt?.opponents.find((seat) => seat.seat === 1);
    expect(leopard).toMatchObject({ cards: ["Kh", "Qc"], label: "一对 K", won: 0, bet: 0 });
    expect(felt?.me).toMatchObject({ label: "一对 K", won: 800, bet: 0 });
  });

  it("庄位和大小盲在座位上标出来", () => {
    const table = handTable();
    const view = table.hand?.view;
    if (view === undefined) throw new Error("应该有一手");
    const positions = ["small_blind", "big_blind", "middle", "button"] as const;
    const marked = PokerTableView.parse({
      ...table,
      hand: {
        ...table.hand,
        view: { ...view, seats: view.seats.map((seat, index) => ({ ...seat, position: positions[index] })) },
      },
    });
    const felt = feltOf(marked);
    expect(felt?.opponents.map((seat) => seat.marker)).toEqual(["小盲", "大盲", null]);
    expect(felt?.me?.marker).toBe("庄");
  });

  it("动作标签取本街最后一个动作，写推完后本街一共多少，换街就清", () => {
    const preflop: PokerEvent[] = [
      { kind: "blind", seatId: "1", amount: 10 },
      { kind: "blind", seatId: "2", amount: 20 },
      { kind: "action", seatId: "3", action: { kind: "raise", amount: 60 }, put: 60 },
      { kind: "action", seatId: "1", action: { kind: "call" }, put: 50 },
      { kind: "action", seatId: "2", action: { kind: "fold" }, put: 0 },
    ];
    const before = feltOf(handTable({ events: preflop, toAct: 4 }));
    expect(before?.opponents.map((seat) => seat.label)).toEqual(["跟 60", "弃牌", "加注到 60"]);
    const flop: PokerEvent[] = [...preflop, { kind: "street", street: "flop", cards: ["Ks", "9h", "4c"] }];
    const after = feltOf(handTable({ events: flop, street: "flop", board: ["Ks", "9h", "4c"] }));
    expect(after?.opponents.map((seat) => seat.label)).toEqual(["", "", ""]);
  });

  it("翻牌后本街第一个往里推的叫下注，再往上加叫加注到，全下写总额", () => {
    const events: PokerEvent[] = [
      { kind: "street", street: "flop", cards: ["Ks", "9h", "4c"] },
      { kind: "action", seatId: "1", action: { kind: "check" }, put: 0 },
      { kind: "action", seatId: "2", action: { kind: "raise", amount: 40 }, put: 40 },
      { kind: "action", seatId: "3", action: { kind: "raise", amount: 120 }, put: 120 },
      { kind: "action", seatId: "1", action: { kind: "all_in" }, put: 1500 },
    ];
    const felt = feltOf(handTable({ events, street: "flop", board: ["Ks", "9h", "4c"] }));
    expect(felt?.opponents.map((seat) => seat.label)).toEqual(["全下 1,500", "下注 40", "加注到 120"]);
  });

  it("轮到牌友时带上他的出牌期限，轮到你时没有", () => {
    const table = handTable({ toAct: 2, legal: { kind: "waiting", toAct: "2" } });
    const deadline = "2026-10-20T00:01:00.000Z";
    const waiting = PokerTableView.parse({ ...table, hand: { ...table.hand, deadline } });
    expect(feltOf(waiting)?.deadline).toBe(deadline);
    const mine = handTable({ toAct: 4 });
    expect(feltOf(PokerTableView.parse({ ...mine, hand: { ...mine.hand, deadline } }))?.deadline).toBeNull();
  });

  it("轮到谁谁高亮", () => {
    const felt = feltOf(handTable({ toAct: 2, legal: { kind: "waiting", toAct: "2" } }));
    expect(felt?.opponents.map((seat) => seat.acting)).toEqual([false, true, false]);
    expect(felt?.me?.acting).toBe(false);
    expect(feltOf(handTable({ toAct: 4 }))?.me?.acting).toBe(true);
  });

  it("还没开手：只有座位和筹码，没有牌", () => {
    const felt = feltOf(idle());
    expect(felt?.opponents.every((seat) => !seat.hasCards && seat.cards === null)).toBe(true);
    expect(felt?.me).toMatchObject({ name: "你", stack: 2000, cards: null });
    expect(felt?.board).toEqual([null, null, null, null, null]);
    expect(felt?.pot).toBe(0);
  });
});

describe("按钮条", () => {
  it("没开手或这手结束了不画", () => {
    expect(actionBarOf(idle())).toBeNull();
    const done = handTable({ street: "complete", toAct: null, legal: { kind: "complete" } });
    expect(actionBarOf(done)).toBeNull();
  });

  it("轮到你，有人下注：跟注写数额，加注给范围", () => {
    const bar = actionBarOf(handTable({ seats: { 3: { committed: 60 } } }));
    expect(bar).toMatchObject({
      mine: true,
      seq: 0,
      handId: "hand_1",
      canFold: true,
      pass: { kind: "call", amount: 60 },
      raise: { kind: "raise", verb: "加注到", min: 100, max: 2000 },
    });
  });

  it("轮到你，没人下注：过牌", () => {
    const bar = actionBarOf(
      handTable({
        street: "turn",
        legal: {
          kind: "your_turn",
          street: "turn",
          toCall: 0,
          options: [{ kind: "fold" }, { kind: "check" }, { kind: "raise", min: 20, max: 2000 }],
        },
      }),
    );
    expect(bar).toMatchObject({ mine: true, pass: { kind: "check" }, raise: { kind: "raise", verb: "下注", min: 20 } });
  });

  it("seq 就是已落库的事件数", () => {
    const events: PokerEvent[] = [
      { kind: "blind", seatId: "1", amount: 10 },
      { kind: "blind", seatId: "2", amount: 20 },
    ];
    expect(actionBarOf(handTable({ events }))?.seq).toBe(2);
  });

  it("不轮到你：按桌上的下注推出按钮写什么，但不可操作", () => {
    const bar = actionBarOf(
      handTable({ toAct: 1, legal: { kind: "waiting", toAct: "1" }, seats: { 3: { committed: 60 } } }),
    );
    expect(bar).toMatchObject({ mine: false, pass: { kind: "call", amount: 60 }, raise: null });
    const quiet = actionBarOf(handTable({ toAct: 1, legal: { kind: "waiting", toAct: "1" } }));
    expect(quiet?.pass).toEqual({ kind: "check" });
  });

  it("加注快捷档夹在最小和最大之间，半池满池按跟注后的底池算", () => {
    const bar = actionBarOf(handTable({ seats: { 3: { committed: 60 } } }));
    if (bar?.raise?.kind !== "raise") throw new Error("应该能加注");
    // 底池 150，跟 60 后 210，当前注 60：半池 60 + 105 = 165，满池 60 + 210 = 270。
    expect(bar.raise.quick.map((pick) => [pick.id, pick.label, pick.amount])).toEqual([
      ["min", "最小 100", 100],
      ["half", "半池 165", 165],
      ["pot", "满池 270", 270],
      ["all", "全下 2,000", 2000],
    ]);
    expect(quickAction(bar.raise, bar.raise.quick[1]!), "半池直接按这个数加注").toEqual({ kind: "raise", amount: 165 });
    expect(quickAction(bar.raise, bar.raise.quick[3]!), "顶到上限就是全下").toEqual({ kind: "all_in" });
    expect(bar.raise.step).toBe(20);
  });

  it("筹码不够跟时，全下就是跟注，加注位空着", () => {
    const bar = actionBarOf(
      handTable({
        legal: {
          kind: "your_turn",
          street: "preflop",
          toCall: 60,
          options: [{ kind: "fold" }, { kind: "call", amount: 40 }, { kind: "all_in", amount: 40 }],
        },
        seats: { 3: { committed: 60 } },
      }),
    );
    expect(bar).toMatchObject({ mine: true, pass: { kind: "call", amount: 40 }, raise: null });
  });

  it("够不上最小加注但还能多下：加注位变成全下", () => {
    const bar = actionBarOf(
      handTable({
        legal: {
          kind: "your_turn",
          street: "preflop",
          toCall: 20,
          options: [{ kind: "fold" }, { kind: "call", amount: 20 }, { kind: "all_in", amount: 50 }],
        },
        seats: { 3: { committed: 20 } },
      }),
    );
    expect(bar).toMatchObject({
      mine: true,
      pass: { kind: "call", amount: 20 },
      raise: { kind: "all_in", amount: 50 },
    });
  });
});

describe("加注额校验", () => {
  const spec = { kind: "raise", verb: "加注到", min: 100, max: 500, step: 20, quick: [] } as const;

  it("范围内的整数通过", () => {
    expect(raiseCheck(spec, "100")).toEqual({ ok: true, amount: 100 });
    expect(raiseCheck(spec, " 500 ")).toEqual({ ok: true, amount: 500 });
  });

  it("低于最小额说清最少要加到多少", () => {
    expect(raiseCheck(spec, "80")).toEqual({ ok: false, reason: "最少要加注到 100", fix: 100 });
    expect(raiseCheck({ ...spec, verb: "下注" }, "10")).toEqual({ ok: false, reason: "最少要下注 100", fix: 100 });
  });

  it("高于筹码说清最多加到多少", () => {
    expect(raiseCheck(spec, "900")).toEqual({ ok: false, reason: "筹码不够，最多只能加注到 500", fix: 500 });
  });

  it("空、小数、不是数字都不通过", () => {
    expect(raiseCheck(spec, "")).toMatchObject({ ok: false });
    expect(raiseCheck(spec, "12.5")).toMatchObject({ ok: false });
    expect(raiseCheck(spec, "abc")).toMatchObject({ ok: false });
  });
});
