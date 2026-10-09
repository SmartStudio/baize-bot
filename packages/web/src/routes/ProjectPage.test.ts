import { describe, expect, it } from "vitest";
import { Message } from "@baize/shared";
import { latestTurnOf, weekChangesOf } from "./ProjectPage.js";

let nextMessageId = 0;

const at = (second: number) => new Date(Date.UTC(2026, 8, 26, 12, 0, second)).toISOString();
const message = (body: unknown, second: number) =>
  Message.parse({ id: `message-${nextMessageId++}`, groupId: "group-1", body, createdAt: at(second), revision: 0 });
const user = (text: string, second: number) => message({ kind: "user", text }, second);
const bot = (text: string, second: number, streaming = false) =>
  message({ kind: "bot", botId: "bot-a", text, streaming }, second);
const cost = (second: number) => message({ kind: "cost", runId: "run-1", steps: 1, amount: 0.8 }, second);
const texts = (turn: readonly Message[]) =>
  turn.map((item) => (item.body.kind === "user" || item.body.kind === "bot" ? item.body.text : item.body.kind));

describe("latestTurnOf", () => {
  it("你那句不在本地群历史里，最近一轮照样是服务端给的那一轮", () => {
    const said = user("开干", 1);
    const reply = bot("收到", 2);
    const { turn, older } = latestTurnOf({ said, replies: [reply] }, 3, [bot("别的", 3)]);
    expect(texts(turn), "本地窗口里只有之后的消息，服务端那句和回应都在，本地新来的也接上").toEqual([
      "开干",
      "收到",
      "别的",
    ]);
    expect(older).toBe(3);
  });

  it("同一条消息以本地这份为准，流式正文跟着长；推送来的新回应接在后面，cost 不算", () => {
    const said = user("开干", 1);
    const streaming = bot("收", 2, true);
    const grown = { ...streaming, body: { ...streaming.body, text: "收到，先读资料" } } as Message;
    const { turn } = latestTurnOf({ said, replies: [streaming] }, 0, [said, grown, bot("读完了", 5), cost(6)]);
    expect(texts(turn)).toEqual(["开干", "收到，先读资料", "读完了"]);
  });

  it("拉取之后你又说了一句，最近一轮从本地这句起，更早的轮数加一", () => {
    const said = user("第一句", 1);
    const reply = bot("回第一句", 2);
    const again = user("第二句", 3);
    const { turn, older } = latestTurnOf({ said, replies: [reply] }, 2, [said, reply, bot("回第二句", 4), again]);
    expect(texts(turn), "到达顺序颠倒也按时间排").toEqual(["第二句", "回第二句"]);
    expect(older).toBe(3);
  });

  it("两句新话到达顺序颠倒，按时间挑后说的那句", () => {
    const later = user("后说的", 6);
    const earlier = user("先说的", 5);
    const { turn, older } = latestTurnOf(null, 0, [later, earlier]);
    expect(texts(turn)).toEqual(["后说的"]);
    expect(older, "服务端还没见过你开口，本地两句就是两轮").toBe(1);
  });

  it("本地多出来、和你那句同一时刻的消息不算进来，留给重拉按落库顺序定", () => {
    const said = user("开干", 1);
    const { turn } = latestTurnOf({ said, replies: [] }, 0, [bot("上一轮的收尾", 1), said]);
    expect(texts(turn)).toEqual(["开干"]);
  });

  it("同一毫秒的两条回复保持服务端给的次序，id 顺序和它相反也不翻", () => {
    const said = user("开干", 1);
    const tied = (id: string, text: string) =>
      Message.parse({
        id,
        groupId: "group-1",
        body: { kind: "bot", botId: "bot-a", text, streaming: false },
        createdAt: at(2),
        revision: 0,
      });
    const first = tied("ffffffff-ffff-4fff-bfff-ffffffffffff", "服务端排第一");
    const second = tied("00000000-0000-4000-8000-000000000000", "服务端排第二");
    const { turn } = latestTurnOf({ said, replies: [first, second] }, 0, []);
    expect(texts(turn)).toEqual(["开干", "服务端排第一", "服务端排第二"]);
  });

  it("你一句都没说过：没有最近一轮，更早是零轮", () => {
    expect(latestTurnOf(null, 0, [bot("我先读资料", 1), cost(2)])).toEqual({ turn: [], older: 0 });
  });
});

describe("weekChangesOf", () => {
  it("本周勾掉的项排在发出的条数前面，两样都是零就一句不出", () => {
    expect(weekChangesOf({ weekChecked: 3, weekPublished: 2 })).toEqual(["本周勾掉 3 项", "本周发出 2 条"]);
    expect(weekChangesOf({ weekChecked: 1, weekPublished: 0 })).toEqual(["本周勾掉 1 项"]);
    expect(weekChangesOf({ weekChecked: 0, weekPublished: 4 })).toEqual(["本周发出 4 条"]);
    expect(weekChangesOf({ weekChecked: 0, weekPublished: 0 })).toEqual([]);
  });
});
