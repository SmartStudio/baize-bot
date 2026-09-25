import { describe, expect, it } from "vitest";
import { Message } from "@baize/shared";
import { turnsOf, type Turn } from "./turns.js";

let nextMessageId = 0;

const message = (body: unknown, createdAt = "2026-09-19T12:00:00.000Z") =>
  Message.parse({
    id: `message-${nextMessageId++}`,
    groupId: "group-1",
    body,
    createdAt,
  });

const user = (text = "hello") => message({ kind: "user", text });

const bot = (botId: string, text = "reply", createdAt?: string) =>
  message({ kind: "bot", botId, text, streaming: false }, createdAt);

const toolCall = (botId: string, tool = "read_task") =>
  message({
    kind: "tool_call",
    runId: "run-1",
    botId,
    tool,
    view: { kind: "mcp", server: "", tool, params: [] },
    status: "ok",
    durationMs: 100,
  });

const skillOffer = (botId: string) =>
  message({
    kind: "skill_offer",
    botId,
    name: "周报",
    steps: ["读取消息", "生成摘要"],
    status: "offered",
    skillId: null,
  });

const approval = () => message({ kind: "approval", approvalId: "approval-1" });
const handoff = () => message({ kind: "handoff", handoffId: "handoff-1" });

const system = (text = "提示", tone?: "info" | "error") =>
  message(tone === undefined ? { kind: "system", text } : { kind: "system", text, tone });

const cost = (amount = 0.8, botId?: string) =>
  message(
    botId === undefined
      ? { kind: "cost", runId: "run-1", steps: 1, amount }
      : { kind: "cost", runId: "run-1", botId, steps: 1, amount },
  );

const botTurnAt = (turns: Turn[], index: number) => {
  const turn = turns[index];
  if (turn?.kind !== "bot") throw new Error(`expected bot turn at index ${index}`);
  return turn;
};

const systemTurnAt = (turns: Turn[], index: number) => {
  const turn = turns[index];
  if (turn?.kind !== "system") throw new Error(`expected system turn at index ${index}`);
  return turn;
};

describe("turnsOf", () => {
  it("returns no turns for an empty message list", () => {
    expect(turnsOf([])).toEqual([]);
  });

  it("opens user turns and preserves the supplied message order", () => {
    const late = bot("bot-a", "late", "2026-09-19T12:10:00.000Z");
    const early = user("early");
    const turns = turnsOf([late, early]);

    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual({ kind: "bot", botId: "bot-a", items: [late], cost: null });
    expect(turns[1]).toEqual({ kind: "user", message: early });
  });

  it("folds bot, tool, and skill messages only while the previous bot turn has the same botId", () => {
    const firstBot = bot("bot-a");
    const firstTool = toolCall("bot-a");
    const firstOffer = skillOffer("bot-a");
    const secondBot = bot("bot-b");
    const laterBot = bot("bot-a", "new turn");

    const turns = turnsOf([firstBot, firstTool, firstOffer, secondBot, laterBot]);

    expect(turns).toHaveLength(3);
    expect(botTurnAt(turns, 0)).toMatchObject({ botId: "bot-a", items: [firstBot, firstTool, firstOffer] });
    expect(botTurnAt(turns, 1)).toMatchObject({ botId: "bot-b", items: [secondBot] });
    expect(botTurnAt(turns, 2)).toMatchObject({ botId: "bot-a", items: [laterBot] });
  });

  it("folds approval and handoff into the active bot turn", () => {
    const messages = [bot("bot-a"), approval(), handoff(), toolCall("bot-a")];
    const turns = turnsOf(messages);

    expect(turns).toHaveLength(1);
    expect(botTurnAt(turns, 0).items.map((item) => item.body.kind)).toEqual([
      "bot",
      "approval",
      "handoff",
      "tool_call",
    ]);
  });

  it("degrades approval and handoff to separate system turns without an active bot turn", () => {
    const approvalMessage = approval();
    const handoffMessage = handoff();
    const turns = turnsOf([approvalMessage, handoffMessage]);

    expect(turns).toEqual([
      { kind: "system", message: approvalMessage, cost: null },
      { kind: "system", message: handoffMessage, cost: null },
    ]);
  });

  it("opens a new system turn for every system message", () => {
    const info = system("info", "info");
    const error = system("error", "error");
    const turns = turnsOf([info, error]);

    expect(turns).toEqual([
      { kind: "system", message: info, cost: null },
      { kind: "system", message: error, cost: null },
    ]);
  });

  it("attaches an unqualified cost to the nearest bot turn", () => {
    const botMessage = bot("bot-a");
    const costMessage = cost();
    const turns = turnsOf([botMessage, costMessage]);

    expect(turns).toHaveLength(1);
    expect(botTurnAt(turns, 0).cost).toBe(costMessage);
  });

  it("uses a matching botId and can pass a newer turn for another bot", () => {
    const firstBot = bot("bot-a");
    const secondBot = bot("bot-b");
    const costMessage = cost(0.4, "bot-a");
    const turns = turnsOf([firstBot, secondBot, costMessage]);

    expect(botTurnAt(turns, 0).cost).toBe(costMessage);
    expect(botTurnAt(turns, 1).cost).toBeNull();
  });

  it("leaves a cost orphaned when no botId-matching turn exists", () => {
    const botMessage = bot("bot-a");
    const costMessage = cost(0.4, "bot-b");
    const turns = turnsOf([botMessage, costMessage]);

    expect(turns).toEqual([
      { kind: "bot", botId: "bot-a", items: [botMessage], cost: null },
      { kind: "cost", message: costMessage },
    ]);
  });

  it("stops cost lookup at a user turn", () => {
    const oldBot = bot("bot-a");
    const userMessage = user("new request");
    const costMessage = cost(0.4, "bot-a");
    const turns = turnsOf([oldBot, userMessage, costMessage]);

    expect(turns).toEqual([
      { kind: "bot", botId: "bot-a", items: [oldBot], cost: null },
      { kind: "user", message: userMessage },
      { kind: "cost", message: costMessage },
    ]);
  });

  it("leaves a second cost orphaned instead of attaching it to the same bot turn", () => {
    const botMessage = bot("bot-a");
    const firstCost = cost(0.4, "bot-a");
    const secondCost = cost(0.5, "bot-a");
    const turns = turnsOf([botMessage, firstCost, secondCost]);

    expect(turns).toEqual([
      { kind: "bot", botId: "bot-a", items: [botMessage], cost: firstCost },
      { kind: "cost", message: secondCost },
    ]);
  });

  it("attaches a cost to an immediately preceding error system turn when no bot turn is eligible", () => {
    const error = system("失败了", "error");
    const costMessage = cost();
    const turns = turnsOf([error, costMessage]);

    expect(turns).toHaveLength(1);
    expect(systemTurnAt(turns, 0)).toEqual({ kind: "system", message: error, cost: costMessage });
  });

  it("does not attach a cost to an ordinary system turn", () => {
    const info = system("说明", "info");
    const costMessage = cost();
    const turns = turnsOf([info, costMessage]);

    expect(turns).toEqual([
      { kind: "system", message: info, cost: null },
      { kind: "cost", message: costMessage },
    ]);
  });

  it("keeps the input messages unchanged", () => {
    const messages = [bot("bot-a"), cost(0.4, "bot-a")];
    const before = messages.slice();

    turnsOf(messages);

    expect(messages).toEqual(before);
  });
});
