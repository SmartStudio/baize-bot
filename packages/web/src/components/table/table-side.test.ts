import { beforeEach, describe, expect, it } from "vitest";
import { Message, type PokerEvent, type PokerSeatView, type PokerTableView } from "@baize/shared";
import { pokerCreateTable, pokerStartHand, pokerView, resetPoker } from "../../../mock/state/poker.js";
import { handResult, hintStage, hintText, netOf, publicLines } from "./table-side.js";

let started: PokerTableView;

beforeEach(() => {
  resetPoker();
  const { table } = pokerCreateTable("table-side-unit");
  pokerStartHand(table, () => undefined);
  started = pokerView(table);
});

const withView = (table: PokerTableView, patch: Partial<PokerSeatView>): PokerTableView => {
  if (table.hand === null) throw new Error("夹具里应该有一手牌");
  return { ...table, hand: { ...table.hand, view: { ...table.hand.view, ...patch } } };
};

const mineOf = (table: PokerTableView): string => {
  if (table.hand === null) throw new Error("夹具里应该有一手牌");
  return table.hand.view.seatId;
};

const bot = (table: PokerTableView, seat: number) => {
  const found = table.seats.find((candidate) => candidate.seat === seat);
  if (found?.botId == null) throw new Error(`${seat} 号位不是牌友`);
  return found;
};

const said = (table: PokerTableView, who: "host" | number | "user", text: string, at: string, id: string) =>
  Message.parse({
    id,
    groupId: table.groupId,
    body:
      who === "user"
        ? { kind: "user", text }
        : { kind: "bot", botId: who === "host" ? table.host.botId : bot(table, who).botId, text, streaming: false },
    createdAt: at,
    revision: 0,
    visibleTo: null,
  });

describe("netOf", () => {
  it("赢回来的减去投进去的：盲注加每次动作的投入", () => {
    const me = mineOf(started);
    const events: PokerEvent[] = [
      { kind: "blind", seatId: me, amount: 20 },
      { kind: "blind", seatId: "other", amount: 10 },
      { kind: "action", seatId: me, action: { kind: "call" }, put: 40 },
      { kind: "action", seatId: "other", action: { kind: "fold" }, put: 0 },
    ];
    const lost = withView(started, { events, awards: [{ seatId: "other", amount: 70, pot: 0 }] });
    expect(netOf(lost.hand!.view), "输掉自己投的 60").toBe(-60);
    const won = withView(started, { events, awards: [{ seatId: me, amount: 130, pot: 0 }] });
    expect(netOf(won.hand!.view), "收 130 投 60").toBe(70);
  });

  it("没人把底池分给你、你也没投钱，净变化是 0", () => {
    const view = withView(started, { events: [], awards: [{ seatId: "other", amount: 30, pot: 0 }] }).hand!.view;
    expect(netOf(view)).toBe(0);
  });
});

describe("publicLines", () => {
  it("按发出的时间排，同一时刻保持到达的先后", () => {
    const lines = publicLines(
      [
        said(started, 1, "晚", "2030-01-01T00:00:02.000Z", "m3"),
        said(started, 3, "同时甲", "2030-01-01T00:00:01.000Z", "m1"),
        said(started, "host", "同时乙", "2030-01-01T00:00:01.000Z", "m2"),
      ],
      started,
    );
    expect(lines.map((line) => line.text)).toEqual(["同时甲", "同时乙", "晚"]);
  });

  it("署名取自座位和主持，不用查 Bot 表；用户自己的话署用户座位的名字", () => {
    const lines = publicLines(
      [
        said(started, 3, "跟", "2030-01-01T00:00:01.000Z", "m1"),
        said(started, "host", "发牌", "2030-01-01T00:00:02.000Z", "m2"),
        said(started, "user", "我来了", "2030-01-01T00:00:03.000Z", "m3"),
      ],
      started,
    );
    const me = started.seats.find((seat) => seat.kind === "user");
    expect(lines.map((line) => line.name)).toEqual([bot(started, 3).name, started.host.name, me?.name]);
    expect(lines[0]?.hue, "头像颜色跟座位走").toBe(bot(started, 3).hue);
  });

  it("只给你一个人看的不进公开记录，已经下桌的牌友署个泛称，空话不显示", () => {
    const hint = Message.parse({
      ...said(started, "host", "悄悄话", "2030-01-01T00:00:01.000Z", "m1"),
      visibleTo: [{ kind: "user" }],
    });
    const gone = Message.parse({
      ...said(started, 1, "我走了", "2030-01-01T00:00:02.000Z", "m2"),
      body: { kind: "bot", botId: "bot_poker_gone", text: "我走了", streaming: false },
    });
    const blank = said(started, 1, "  ", "2030-01-01T00:00:03.000Z", "m3");
    const lines = publicLines([hint, gone, blank], started);
    expect(lines.map((line) => [line.name, line.text])).toEqual([["已下桌的牌友", "我走了"]]);
  });
});

describe("hintStage 和 hintText", () => {
  it("提示挂在决策点上：seq 对得上才算问过，对不上当没问", () => {
    const seq = started.hand?.view.events.length ?? -1;
    const asked = (hint: PokerTableView["hint"]) => ({ ...started, hint });
    expect(hintStage({ ...started, hint: null })).toBe("idle");
    expect(hintStage(asked({ seq, status: "waiting", messageId: null }))).toBe("waiting");
    expect(hintStage(asked({ seq, status: "done", messageId: null }))).toBe("done");
    expect(hintStage(asked({ seq, status: "failed", messageId: null }))).toBe("failed");
    expect(hintStage(asked({ seq: seq + 1, status: "done", messageId: null })), "上一个决策点的提示").toBe("idle");
    expect(hintStage({ ...started, hand: null }), "没有进行中的手").toBe("none");
    expect(hintStage(withView(started, { street: "complete" })), "手打完了").toBe("none");
  });

  it("建议正文按 messageId 从消息里找，找不到是 null", () => {
    const message = said(started, "host", "加注", "2030-01-01T00:00:01.000Z", "msg_hint");
    const table: PokerTableView = { ...started, hint: { seq: 0, status: "done", messageId: message.id } };
    expect(hintText([message], table)).toBe("加注");
    expect(hintText([], table)).toBeNull();
    expect(hintText([message], { ...table, hint: null })).toBeNull();
  });
});

describe("handResult", () => {
  const finished = (net: number): PokerTableView => {
    const me = mineOf(started);
    const events: PokerEvent[] = [{ kind: "blind", seatId: me, amount: 100 }];
    const awards = net + 100 > 0 ? [{ seatId: net > -100 ? me : "s1", amount: Math.abs(net + 100), pot: 0 }] : [];
    return withView(started, {
      street: "complete",
      events,
      awards: net === -100 ? [{ seatId: "s1", amount: 100, pot: 0 }] : awards,
    });
  };

  it("手还在打时没有结果", () => {
    expect(handResult(started)).toBeNull();
  });

  it("赢、输、平各一句，数额带千分位", () => {
    expect(handResult(finished(1980))?.headline).toBe("你赢了 1,980 筹码");
    expect(handResult(finished(-100))).toMatchObject({ tone: "lose", headline: "你输了 100 筹码" });
    expect(handResult(finished(0))).toMatchObject({ tone: "even", headline: "这手不输不赢" });
  });

  it("摊过牌：写底池归谁和赢家的牌型", () => {
    const me = mineOf(started);
    const view = started.hand?.view;
    if (view === undefined) throw new Error("夹具里应该有一手牌");
    const result = handResult(
      withView(started, {
        street: "complete",
        board: ["Ks", "9h", "4c", "2d", "7s"],
        seats: view.seats.map((seat) =>
          seat.seatId === me
            ? { ...seat, shown: view.hole }
            : seat.seatId === "s1"
              ? { ...seat, shown: ["Kh", "Qc"] }
              : seat,
        ),
        events: [],
        awards: [{ seatId: me, amount: 800, pot: 0 }],
      }),
    );
    expect(result?.detail).toBe("底池 800 归你（一对 K）");
  });

  it("结算里的座位 id 对回座位名，认不出的写对手；没摊牌说明别人都弃了", () => {
    const me = mineOf(started);
    const result = handResult(
      withView(started, {
        street: "complete",
        events: [],
        awards: [
          { seatId: me, amount: 50, pot: 0 },
          { seatId: "s1", amount: 30, pot: 1 },
          { seatId: "x", amount: 20, pot: 2 },
        ],
      }),
    );
    expect(result?.detail).toBe(`底池 50 归你，30 归${bot(started, 1).name}，20 归对手，其他人都弃了牌`);
  });
});
