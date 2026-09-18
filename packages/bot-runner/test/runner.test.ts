import { describe, expect, it } from "vitest";
import { AgentToControl, BotId, GroupId, RunId } from "@baize/shared";
import { createRunner, PLACEHOLDER_REPLY, type PromptMessage, type RunnerConfig } from "../src/index.js";

function promptMessage(text: string): PromptMessage {
  return {
    type: "prompt",
    runId: RunId.parse("run-1"),
    botId: BotId.parse("bot-1"),
    groupId: GroupId.parse("group-1"),
    text,
    context: [],
  };
}

function runnerWithOutbox() {
  const sent: AgentToControl[] = [];
  const config: RunnerConfig = {
    bots: [],
    tools: [],
    modelGateway: { baseUrl: "http://localhost:3001/model", apiKey: "k", model: "m" },
    send: (message) => sent.push(message),
  };
  return { runner: createRunner(config), sent };
}

function botText(message: unknown) {
  const parsed = AgentToControl.parse(message);
  if (parsed.type !== "bot_text") throw new Error(`期望 bot_text，实际收到 ${parsed.type}`);
  return parsed;
}

describe("createRunner", () => {
  it("每条 prompt 回一条 done 的 bot_text，并带回 prompt 的三个 id", async () => {
    const { runner, sent } = runnerWithOutbox();

    await runner.prompt(promptMessage("查一下昨天的订单"));

    expect(sent).toHaveLength(1);
    const reply = botText(sent[0]);
    expect(reply.done).toBe(true);
    expect(reply.delta).toBe(PLACEHOLDER_REPLY);
    expect(reply.runId).toBe("run-1");
    expect(reply.botId).toBe("bot-1");
    expect(reply.groupId).toBe("group-1");
  });

  it("回复文本固定，两条不同 prompt 的 delta 一样，messageId 不一样", async () => {
    const { runner, sent } = runnerWithOutbox();

    await runner.prompt(promptMessage("第一问"));
    await runner.prompt(promptMessage("第二问"));

    expect(sent).toHaveLength(2);
    const [first, second] = [botText(sent[0]), botText(sent[1])];
    expect(second.delta).toBe(first.delta);
    expect(second.messageId).not.toBe(first.messageId);
  });

  it("stop 之后的 prompt 不再发报文", async () => {
    const { runner, sent } = runnerWithOutbox();

    await runner.stop();
    await runner.prompt(promptMessage("停了还问"));

    expect(sent).toEqual([]);
  });

  it("stop 可以重复调用", async () => {
    const { runner } = runnerWithOutbox();

    await runner.stop();
    await expect(runner.stop()).resolves.toBeUndefined();
  });
});
