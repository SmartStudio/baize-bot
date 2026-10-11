import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PokerTableResponse, PokerTableView, ServerPush, type Message, type PokerAction } from "@baize/shared";
import { pokerRoutes } from "../../mock/routes/poker.js";
import { pokerTableList, reseed, resetPoker } from "../../mock/state.js";

// 对手底牌：1 号 K♥ Q♣，2 号 7♦ 2♣，3 号 J♣ 10♦。公共牌和你的 A♠ K♦ 都不和它们重复，所以出现就是漏了。
const OPPONENT_CARDS = ["Kh", "Qc", "7d", "2c", "Jc", "Td"];
const OPPONENT_TEXT = ["K♥", "Q♣", "7♦", "2♣", "J♣", "10♦"];

type Reply = { status: number; json: unknown };

// 一个测试一份「客户端」：调路由函数，把回包里的整桌和推出来的帧都按时间顺序记下来。
const client = () => {
  const snapshots: { from: string; table: PokerTableView }[] = [];
  const messages: Message[] = [];
  const raw: string[] = [];

  const call = async (method: string, path: string, body?: unknown): Promise<Reply> => {
    const reply: Reply = { status: 0, json: null };
    const res = {
      writeHead: (status: number) => {
        reply.status = status;
        return res;
      },
      end: (payload?: string) => {
        reply.json = payload === undefined ? null : JSON.parse(payload);
        if (payload !== undefined) raw.push(payload);
      },
    };
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    const handled = await pokerRoutes({
      req: req as unknown as IncomingMessage,
      res: res as unknown as ServerResponse,
      url: new URL(`http://mock${path}`),
      path,
      method,
      push: (event) => {
        raw.push(JSON.stringify(event));
        const push = ServerPush.parse(event);
        if (push.type === "poker_table_updated") snapshots.push({ from: "push", table: push.table });
        if (push.type === "message") messages.push(push.message);
      },
    });
    expect(handled, `${method} ${path} 应该被牌桌路由接住`).toBe(true);
    if (reply.status === 200 || reply.status === 201) {
      const table = (reply.json as { table?: unknown }).table;
      if (table !== undefined)
        snapshots.push({ from: `${method} ${path}`, table: PokerTableResponse.parse(reply.json).table });
    }
    return reply;
  };

  const tableOf = (reply: Reply): PokerTableView => PokerTableResponse.parse(reply.json).table;
  const tick = async () =>
    (await call("POST", "/api/poker/test/tick", {})).json as { ran: boolean; table: PokerTableView };
  // 牌友的回合一拍一拍走，直到轮到你或这手结束。
  const untilMine = async (table: PokerTableView): Promise<PokerTableView> => {
    let current = table;
    for (
      let guard = 0;
      guard < 20 && current.hand !== null && current.hand.toAct !== 4 && current.status === "in_hand";
      guard += 1
    ) {
      current = (await tick()).table;
    }
    return current;
  };
  const act = async (table: PokerTableView, action: PokerAction): Promise<Reply> => {
    const hand = table.hand;
    if (hand === null) throw new Error("没有进行中的一手");
    return call("POST", `/api/poker/hands/${hand.id}/act`, { seq: hand.view.events.length, action });
  };
  // 打一步：出牌、等牌友回完，回到下一个轮到你的桌面。
  const play = async (table: PokerTableView, action: PokerAction): Promise<PokerTableView> => {
    const reply = await act(table, action);
    expect(reply.status, JSON.stringify(reply.json)).toBe(200);
    return untilMine(tableOf(reply));
  };
  const open = async (): Promise<PokerTableView> => {
    await call("POST", "/api/poker/test/delay", { ms: null });
    const created = tableOf(await call("POST", "/api/poker/tables", { requestId: "t1" }));
    const started = tableOf(await call("POST", `/api/poker/tables/${created.groupId}/hands`, {}));
    return untilMine(started);
  };
  return { call, snapshots, messages, raw, tableOf, tick, untilMine, act, play, open };
};

beforeEach(() => {
  reseed();
});

afterEach(() => {
  resetPoker();
  vi.useRealTimers();
});

describe("牌桌 mock 的剧本", () => {
  it("脚本每一步产出的视图都能被 shared 的 PokerTableView 解析", async () => {
    const c = client();
    let table = await c.open();
    table = await c.play(table, { kind: "call" });
    table = await c.play(table, { kind: "call" });
    table = await c.play(table, { kind: "check" });
    table = await c.play(table, { kind: "call" });

    expect(table.status, "河牌跟注后这手结束").toBe("idle");
    expect(table.hand?.view.legal).toEqual({ kind: "complete" });
    expect(c.snapshots.length, "开局到摊牌之间每一步都有一份快照").toBeGreaterThan(10);
    for (const { from, table: snapshot } of c.snapshots) {
      expect(PokerTableView.safeParse(snapshot).success, `${from} 的视图过不了 shared 的 schema`).toBe(true);
    }
    const versions = c.snapshots.map((snapshot) => snapshot.table.version);
    expect(
      versions.every((version, index) => index === 0 || version >= (versions[index - 1] ?? 0)),
      "版本只增不减，客户端才不会丢帧",
    ).toBe(true);
    const pushed = c.snapshots.filter((snapshot) => snapshot.from === "push").map((snapshot) => snapshot.table.version);
    expect(new Set(pushed).size, "每次推送的版本都是新的").toBe(pushed.length);
  });

  it("摊牌前每一步的视图里找不到对手底牌", async () => {
    const c = client();
    let table = await c.open();
    table = await c.play(table, { kind: "raise", amount: 180 });
    await c.call("POST", `/api/poker/hands/${table.hand?.id}/hint`, { seq: table.hand?.view.events.length });
    table = (await c.tick()).table;
    table = await c.play(table, { kind: "call" });
    table = await c.play(table, { kind: "check" });

    const beforeShowdown = c.raw.join("\n");
    for (const card of OPPONENT_CARDS)
      expect(beforeShowdown, `摊牌前出现了对手的牌 ${card}`).not.toContain(`"${card}"`);
    for (const card of OPPONENT_TEXT) expect(beforeShowdown, `摊牌前解说里出现了对手的牌 ${card}`).not.toContain(card);
    expect(table.hand?.view.seats.map((seat) => seat.shown)).toEqual([null, null, null, null]);

    table = await c.play(table, { kind: "call" });
    expect(table.hand?.view.seats.find((seat) => seat.seatId === "s1")?.shown, "摊牌之后才亮出 1 号的牌").toEqual([
      "Kh",
      "Qc",
    ]);
    expect(table.hand?.view.seats.find((seat) => seat.seatId === "s2")?.shown, "弃了牌的人不亮").toBeNull();
  });

  it("你自己弃牌，一手打完对手的底牌也不会亮", async () => {
    const c = client();
    let table = await c.open();
    table = await c.play(table, { kind: "call" });
    const folded = await c.act(table, { kind: "fold" });
    table = await c.untilMine(c.tableOf(folded));

    expect(table.status).toBe("idle");
    expect(table.hand?.view.awards?.length).toBeGreaterThan(0);
    const everything = c.raw.join("\n");
    for (const card of OPPONENT_CARDS) expect(everything).not.toContain(`"${card}"`);
    for (const card of OPPONENT_TEXT) expect(everything).not.toContain(card);
  });

  it("mock 换人只改那一个座位", async () => {
    const c = client();
    let created = await c.open();
    for (const action of [{ kind: "call" }, { kind: "call" }, { kind: "check" }, { kind: "call" }] as const) {
      created = await c.play(created, action);
    }
    expect(new Set(created.seats.map((seat) => seat.stack)).size, "打完一手四家筹码各不相同，换人才看得出谁动了").toBe(
      4,
    );
    const swapped = c.tableOf(
      await c.call("POST", `/api/poker/tables/${created.groupId}/seats/2`, { persona: "old_k" }),
    );

    expect(swapped.seats[1], "2 号换成老K，筹码不变").toMatchObject({
      seat: 2,
      persona: "old_k",
      name: "老K",
      botId: "bot_poker_old_k",
      stack: created.seats[1]?.stack,
    });
    expect([swapped.seats[0], swapped.seats[2], swapped.seats[3]], "别的座位一字不动").toEqual([
      created.seats[0],
      created.seats[2],
      created.seats[3],
    ]);
    expect({ ...swapped, seats: [], version: 0 }, "除了座位和版本，桌上别的东西不动").toEqual({
      ...created,
      seats: [],
      version: 0,
    });
    expect(swapped.version).toBeGreaterThan(created.version);
  });

  it("换人的限制：重复的牌友、4 号位、打牌中都不行", async () => {
    const c = client();
    const created = c.tableOf(await c.call("POST", "/api/poker/tables", { requestId: "swap2" }));
    const path = (seat: number) => `/api/poker/tables/${created.groupId}/seats/${seat}`;

    expect((await c.call("POST", path(2), { persona: "leopard" })).status, "阿豹已经坐在 1 号").toBe(409);
    expect((await c.call("POST", path(4), { persona: "old_k" })).status, "4 号位是你自己").toBe(400);
    expect((await c.call("POST", path(2), { persona: "laobai" })).status, "老白是解说不入座").toBe(400);
    expect((await c.call("POST", path(2), { persona: "jasmine" })).status, "原地换成自己是空操作").toBe(200);
    await c.call("POST", `/api/poker/tables/${created.groupId}/hands`, {});
    expect((await c.call("POST", path(2), { persona: "old_k" })).status, "这手没打完不能换").toBe(409);
  });
});

describe("牌桌 mock 的规则", () => {
  it("一路跟注到河牌：你的踢脚大，赢走底池，四家筹码总数不变", async () => {
    const c = client();
    let table = await c.open();
    expect(table.hand?.view.legal).toMatchObject({ kind: "your_turn", street: "preflop", toCall: 60 });
    for (const action of [{ kind: "call" }, { kind: "call" }, { kind: "check" }, { kind: "call" }] as const) {
      table = await c.play(table, action);
    }

    expect(table.seats.map((seat) => seat.stack)).toEqual([1640, 1980, 1940, 2440]);
    expect(table.hand?.view.board).toEqual(["Ks", "9h", "4c", "2d", "7s"]);
    expect(table.hand?.view.awards).toEqual([{ seatId: "s4", amount: 800, pot: 0 }]);
    expect(table.session).toMatchObject({ handCount: 1, net: 440 });
  });

  it("不合规矩的动作被拒，并且拒了不动桌面", async () => {
    const c = client();
    const table = await c.open();
    const check = await c.act(table, { kind: "check" });
    const small = await c.act(table, { kind: "raise", amount: 90 });
    const big = await c.act(table, { kind: "raise", amount: 99999 });
    const stale = await c.call("POST", `/api/poker/hands/${table.hand?.id}/act`, { seq: 0, action: { kind: "call" } });
    const unknown = await c.call("POST", "/api/poker/hands/hand_nope/act", { seq: 0, action: { kind: "call" } });

    expect([check.status, small.status, big.status, stale.status, unknown.status]).toEqual([400, 400, 400, 409, 404]);
    expect(check.json).toEqual({ error: "有人下注了，不能过牌，要跟注或弃牌" });
    expect(small.json).toEqual({ error: "加注额不够，最少要加到 100" });
    const again = c.tableOf(await c.call("GET", `/api/poker/tables/${table.groupId}`));
    expect(again).toEqual(table);
  });

  it("牌友没轮完不让你出牌", async () => {
    const c = client();
    const started = await c.open();
    const reply = await c.act(started, { kind: "call" });
    const waiting = c.tableOf(reply);
    expect(waiting.hand?.toAct, "你跟注之后 1 号要说话").toBe(1);
    expect(waiting.hand?.view.legal).toEqual({ kind: "waiting", toAct: "s1" });
    expect(waiting.hand?.deadline, "牌友回合带 60 秒的期限").not.toBeNull();

    const early = await c.call("POST", `/api/poker/hands/${waiting.hand?.id}/act`, {
      seq: waiting.hand?.view.events.length,
      action: { kind: "call" },
    });
    expect(early.status).toBe(409);
  });

  it("提示：同一个决策点只出一条，只发给你，你出牌之后清掉", async () => {
    const c = client();
    const table = await c.open();
    const path = `/api/poker/hands/${table.hand?.id}/hint`;
    const seq = table.hand?.view.events.length;
    const first = c.tableOf(await c.call("POST", path, { seq }));
    const second = c.tableOf(await c.call("POST", path, { seq }));

    expect(first.hint).toEqual({ seq, status: "waiting", messageId: null });
    expect(second.hint, "重复问是同一个提示").toEqual(first.hint);
    expect(second.version, "重复问不排新任务，版本也不动").toBe(first.version);
    const done = (await c.tick()).table;
    const hintMessage = c.messages.find((message) => message.id === done.hint?.messageId);
    expect(done.hint?.status).toBe("done");
    expect(hintMessage?.visibleTo, "提示只给你看").toEqual([{ kind: "user" }]);
    expect(c.messages.filter((message) => message.visibleTo !== null)).toHaveLength(1);
    expect((await c.call("POST", path, { seq: (seq ?? 0) + 1 })).status, "决策点变了，旧 seq 不认").toBe(409);

    const acted = c.tableOf(await c.act(done, { kind: "call" }));
    expect(acted.hint).toBeNull();
  });

  it("散场：战绩记一局，复盘晚一拍到，打到一半不让走", async () => {
    const c = client();
    let table = await c.open();
    const leave = `/api/poker/tables/${table.groupId}/leave`;
    expect((await c.call("POST", leave, {})).status, "这手没打完").toBe(409);
    for (const action of [{ kind: "call" }, { kind: "call" }, { kind: "check" }, { kind: "call" }] as const) {
      table = await c.play(table, action);
    }

    const left = c.tableOf(await c.call("POST", leave, {}));
    expect(left.session).toBeNull();
    expect(left.stats).toEqual({ sessions: 1, sessionsWon: 1, net: 440 });
    expect(left.lastReview, "复盘还没写好").toBeNull();
    expect(left.reviewState, "复盘生成中").toEqual({ sessionId: table.session!.id, status: "generating" });
    const reviewed = (await c.tick()).table;
    expect(reviewed.lastReview).toMatchObject({ hands: [expect.objectContaining({ number: 1 })] });
    expect(reviewed.reviewState).toEqual({ sessionId: table.session!.id, status: "done" });
    expect((await c.call("POST", leave, {})).status, "没有打着的一场了").toBe(409);
  });

  it("复盘失败后状态是失败，重试只认最近一场，重试后再写一遍", async () => {
    const c = client();
    let table = await c.open();
    const sessionId = table.session!.id;
    for (const action of [{ kind: "call" }, { kind: "call" }, { kind: "check" }, { kind: "call" }] as const) {
      table = await c.play(table, action);
    }
    const review = `/api/poker/tables/${table.groupId}/review`;
    expect((await c.call("POST", review, { sessionId })).status, "还没散场就没有可重试的复盘").toBe(409);
    await c.call("POST", `/api/poker/tables/${table.groupId}/leave`, {});
    expect((await c.call("POST", "/api/poker/test/fail-review", { groupId: table.groupId })).status).toBe(200);
    const failed = c.tableOf(await c.call("GET", `/api/poker/tables/${table.groupId}`));
    expect(failed.reviewState).toEqual({ sessionId, status: "failed" });
    expect(failed.lastReview).toBeNull();
    expect((await c.tick()).ran, "失败后队里没有复盘任务").toBe(false);

    expect((await c.call("POST", review, { sessionId: "ses_other" })).status, "不是最近一场").toBe(409);
    expect((await c.call("POST", review, {})).status).toBe(400);
    const retried = c.tableOf(await c.call("POST", review, { sessionId }));
    expect(retried.reviewState).toEqual({ sessionId, status: "generating" });
    const again = c.tableOf(await c.call("POST", review, { sessionId }));
    expect(again.version, "生成中再试不排第二条").toBe(retried.version);
    const done = (await c.tick()).table;
    expect(done.reviewState).toEqual({ sessionId, status: "done" });
    expect(done.lastReview?.sessionId).toBe(sessionId);
    const after = c.tableOf(await c.call("POST", review, { sessionId }));
    expect(after.version, "写好了再试什么都不做").toBe(done.version);
  });

  it("没筹码的座位下一手补回 2000，创建桌子按 requestId 幂等", async () => {
    const c = client();
    const first = await c.call("POST", "/api/poker/tables", { requestId: "same" });
    const again = await c.call("POST", "/api/poker/tables", { requestId: "same" });
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(pokerTableList()).toHaveLength(1);

    const table = pokerTableList()[0];
    if (table === undefined) throw new Error("没建出桌子");
    const seat = table.seats[0];
    if (seat === undefined) throw new Error("没有 1 号位");
    seat.stack = 0;
    const started = c.tableOf(await c.call("POST", `/api/poker/tables/${table.groupId}/hands`, {}));
    expect(started.hand?.view.seats[0]?.stack, "补满 2000 再扣小盲 10").toBe(1990);
  });
});

describe("牌桌 mock 的节奏", () => {
  it("默认每 600ms 走一条牌友动作，不会一口气全走完", async () => {
    vi.useFakeTimers();
    const c = client();
    const created = c.tableOf(await c.call("POST", "/api/poker/tables", { requestId: "pace" }));
    const started = c.tableOf(await c.call("POST", `/api/poker/tables/${created.groupId}/hands`, {}));
    const acts = (table: PokerTableView) =>
      table.hand?.view.events.filter((event) => event.kind === "action").length ?? 0;
    const latest = () => c.snapshots.at(-1)?.table as PokerTableView;

    expect(started.hand?.toAct, "3 号先说话，还没动").toBe(3);
    expect(acts(started)).toBe(0);
    vi.advanceTimersByTime(599);
    expect(acts(latest()), "不到 600ms 不动").toBe(0);
    vi.advanceTimersByTime(1);
    expect(acts(latest()), "到点 3 号加注").toBe(1);
    expect(latest().hand?.toAct, "轮到你，不再排任务").toBe(4);
    expect(vi.getTimerCount()).toBe(0);

    const called = c.tableOf(await c.act(latest(), { kind: "call" }));
    expect(called.hand?.toAct).toBe(1);
    vi.advanceTimersByTime(600);
    expect(acts(latest()), "你跟注后 1 号跟，一拍只走一条").toBe(3);
    expect(latest().hand?.toAct).toBe(2);
  });

  it("挂起之后不排定时器，测试入口一拍一拍放行", async () => {
    vi.useFakeTimers();
    const c = client();
    await c.call("POST", "/api/poker/test/delay", { ms: null });
    const created = c.tableOf(await c.call("POST", "/api/poker/tables", { requestId: "held" }));
    await c.call("POST", `/api/poker/tables/${created.groupId}/hands`, {});

    expect(vi.getTimerCount(), "挂起时一个定时器都没有").toBe(0);
    vi.advanceTimersByTime(60_000);
    expect((await c.tick()).ran).toBe(true);
    expect((await c.tick()).ran, "轮到你，队里没任务").toBe(false);
  });

  it("整套 mock 重置，牌桌和排着的定时器一起清", async () => {
    vi.useFakeTimers();
    const c = client();
    const created = c.tableOf(await c.call("POST", "/api/poker/tables", { requestId: "reset" }));
    await c.call("POST", `/api/poker/tables/${created.groupId}/hands`, {});
    expect(vi.getTimerCount()).toBe(1);

    reseed();
    expect((await c.call("GET", `/api/poker/tables/${created.groupId}`)).status).toBe(404);
    expect(vi.getTimerCount(), "旧一代的定时器不能留着再推帧").toBe(0);
  });
});
