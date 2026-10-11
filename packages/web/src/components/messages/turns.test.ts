import { describe, expect, it } from "vitest";
import { Message } from "@baize/shared";
import { turnsOf, type Turn } from "./turns.js";

let nextMessageId = 0;

const message = (body: unknown, createdAt = "2026-09-19T12:00:00.000Z") =>
  Message.parse({
    id: `message-${String(nextMessageId++).padStart(4, "0")}`,
    groupId: "group-1",
    body,
    createdAt,
    revision: 0,
    visibleTo: null,
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
const cost = () => message({ kind: "cost", runId: "run-1", steps: 1, amount: 0.8 });

const botTurnAt = (turns: Turn[], index: number) => {
  const turn = turns[index];
  if (turn?.kind !== "bot") throw new Error(`expected bot turn at index ${index}`);
  return turn;
};

describe("turnsOf", () => {
  it("空消息返回空回合", () => {
    expect(turnsOf([])).toEqual([]);
  });

  it("按 createdAt 排，到达顺序颠倒也是你那句在前、系统回应在后", () => {
    const reply = bot("bot-a", "late", "2026-09-19T12:00:02.000Z");
    const said = user("early");
    expect(turnsOf([reply, said])).toEqual([
      { kind: "user", message: said },
      { kind: "bot", botId: "bot-a", items: [reply] },
    ]);
  });

  it("同一毫秒的保留输入次序，不按 id 重排", () => {
    const at = "2026-09-19T12:00:00.000Z";
    const said = Message.parse({
      id: "message-z",
      groupId: "group-1",
      body: { kind: "user", text: "z" },
      createdAt: at,
      revision: 0,
      visibleTo: null,
    });
    const reply = Message.parse({
      id: "message-a",
      groupId: "group-1",
      body: { kind: "bot", botId: "bot-a", text: "a", streaming: false },
      createdAt: at,
      revision: 0,
      visibleTo: null,
    });
    expect(turnsOf([said, reply])).toEqual([
      { kind: "user", message: said },
      { kind: "bot", botId: "bot-a", items: [reply] },
    ]);
  });

  it("只把相邻且同 Bot 的正文、工具和技能合成一轮", () => {
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

  it("把审批和交接收进正在进行的 Bot 回合", () => {
    const messages = [bot("bot-a"), approval(), handoff(), toolCall("bot-a")];
    expect(botTurnAt(turnsOf(messages), 0).items.map((item) => item.body.kind)).toEqual([
      "bot",
      "approval",
      "handoff",
      "tool_call",
    ]);
  });

  it("没有 Bot 回合时审批和交接各自成为系统回合", () => {
    const approvalMessage = approval();
    const handoffMessage = handoff();
    expect(turnsOf([approvalMessage, handoffMessage])).toEqual([
      { kind: "system", message: approvalMessage },
      { kind: "system", message: handoffMessage },
    ]);
  });

  it("花费消息不产出回合", () => {
    const botMessage = bot("bot-a");
    expect(turnsOf([botMessage, cost()])).toEqual([{ kind: "bot", botId: "bot-a", items: [botMessage] }]);
    expect(turnsOf([cost()])).toEqual([]);
  });
});
