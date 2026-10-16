import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { AgentToControl, BotId, ComputerId, GroupId, MessageId, RunId } from "@baize/shared";
import { afterEach, expect, it } from "vitest";
import { createRunner, type PromptMessage, type RunnerConfig } from "../src/index.js";
import { startGateway } from "./fixtures/gateway.js";
import { scriptedUpstream } from "./fixtures/openai-sse.js";

const botId = BotId.parse("bot-order");
const groupId = GroupId.parse("group-order");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const prompt: PromptMessage = {
  type: "prompt",
  runId: RunId.parse("run-order"),
  botId,
  groupId,
  lane: { epoch: 1, heads: {} },
  messageId: MessageId.parse("message-order"),
  text: "收尾顺序",
  origin: { kind: "user" },
  reason: "solo",
  group: { id: groupId, title: "收尾", number: "", kind: "solo" },
  context: [],
  members: [{ id: botId, name: "收尾员", tags: [], description: "", seat: "member" }],
  task: null,
  routine: null,
  table: null,
  purpose: "plan",
};

it("run_done 排在最后一帧 settled 工作记录确认之后：该帧挂住时 run_done 不发，放开后才发", async () => {
  const gateway = await startGateway({
    upstream: scriptedUpstream(() => ({ textChunks: ["完成"], usage: { input: 10, output: 5 } })),
    models: [{ id: "fake" }],
  });
  const dataDir = mkdtempSync(join(tmpdir(), "baize-run-done-order-"));
  cleanups.push(async () => {
    await gateway.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived!: () => void;
  const heldFrame = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const config: RunnerConfig = {
    computerId: ComputerId.parse("computer-order"),
    computerKind: "local",
    bots: [{ id: botId, name: "收尾员", role: "member", preset: null, tags: [], description: "" }],
    tools: [],
    accounts: [],
    grants: [],
    brand: null,
    preferences: [],
    modelGateway: { baseUrl: gateway.baseUrl, apiKey: "fake-key" },
    accountsProxy: { baseUrl: "http://127.0.0.1:9" },
    mcpProxy: { baseUrl: "http://127.0.0.1:9/mcp-proxy" },
    hub: { baseUrl: "http://127.0.0.1:9/hub/v1" },
    workAppend: async (frame) => {
      if (frame.cause !== "settled" || !frame.lines.some((line) => line.includes("baize.context-watermark")))
        return { kind: "ok" };
      events.push("最后一帧到达");
      arrived();
      await gate;
      events.push("最后一帧确认");
      return { kind: "ok" };
    },
    dataDir,
    send: (message) => {
      if (AgentToControl.parse(message).type === "run_done") events.push("run_done");
    },
  };
  const runner = createRunner(config);
  cleanups.push(async () => {
    release();
    await runner.stop();
  });

  const running = runner.prompt(prompt);
  await heldFrame;
  for (let turn = 0; turn < 20; turn += 1) await nextTurn();
  expect(events).toEqual(["最后一帧到达"]);

  release();
  await running;
  expect(events).toEqual(["最后一帧到达", "最后一帧确认", "run_done"]);
});
