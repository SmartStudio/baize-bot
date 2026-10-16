import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  BotListResponse,
  ComputerChoices,
  ComputerListResponse,
  ComputerTokenResponse,
  type ComputerId,
  type ServerPush,
} from "@baize/shared";
import { createRunner, type PromptMessage } from "@baize/bot-runner";
import { startAgent, type AgentHandle } from "@baize/computer-agent";
import { startStack, type Stack } from "../src/stack.js";
import { type ChatMessage, type ChatRequest, isFollowUpTurn, startUpstream } from "../src/upstream.js";

const poll = { timeout: 10_000, interval: 25 };
const SWITCH_MESSAGE = "用云电脑把这份清单整理完";
const CONTINUATION_TEXT =
  "刚才你请求换电脑，现在已经换到云电脑上了。接着刚才没做完的事做，之前对话里的内容都在，不要重新问主人，也不要把前面做过的再做一遍。";
const SWITCHED_RESULT = "已换到云电脑，这一轮到此结束，换好后会在云电脑上接着做，不用再说什么。";

type ToolCallMessage = ChatMessage & {
  readonly tool_calls?: readonly { readonly id: string; readonly function: { name: string; arguments: string } }[];
};

/** Pi 把内容发成 `[{ type: "text", text }]` 片段数组，把文本片段原样拼起来。 */
const text = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
        ? part.text
        : JSON.stringify(part),
    )
    .join("");
};

const lastUserText = (request: ChatRequest): string =>
  text(request.messages.findLast((message) => message.role === "user")?.content);

function startComputer(
  stack: Stack,
  credentials: { readonly computerId: ComputerId; readonly token: string },
  dataDir: string,
  prompts: PromptMessage[],
  onConfigured: () => void,
  log: (line: string) => void,
): AgentHandle {
  return startAgent({
    url: `ws://127.0.0.1:${stack.port}/agent`,
    ...credentials,
    version: "0.1.0-e2e-switch-computer",
    dataDir,
    backoff: { initialMs: 50, maxMs: 100, factor: 1 },
    makeChrome: () => ({
      kind: "local",
      profileDir: join(dataDir, "chrome"),
      connection: () => Promise.reject(new Error("换电脑用例不使用 Chrome")),
      onExit: () => () => {},
      reveal: async () => {},
      conceal: async () => {},
      pid: () => null,
      stop: async () => {},
    }),
    makeRunner: (config) => {
      const runner = createRunner(config);
      onConfigured();
      return {
        ...runner,
        prompt: (message) => {
          prompts.push(message);
          return runner.prompt(message);
        },
      };
    },
    log,
  });
}

async function waitForDispatchable(stack: Stack, computerId: ComputerId): Promise<void> {
  await expect
    .poll(
      async () =>
        ComputerListResponse.parse(await stack.get("/api/computers")).computers.find((item) => item.id === computerId)
          ?.dispatchable,
      poll,
    )
    .toBe(true);
}

async function waitForCost(stack: Stack, groupId: string, runId: string): Promise<void> {
  for (;;) {
    const push: ServerPush = await stack.nextPush();
    if (
      push.type === "message" &&
      push.message.groupId === groupId &&
      push.message.body.kind === "cost" &&
      push.message.body.runId === runId
    )
      return;
  }
}

it("Bot 在本机调用 switch_computer 换到云电脑，这一轮在云电脑上带着工具调用和结果接着做", async () => {
  const upstream = await startUpstream((request) => {
    if (lastUserText(request).includes(SWITCH_MESSAGE) && !isFollowUpTurn(request)) {
      return {
        textChunks: ["这个在云电脑上做更合适，我换过去。"],
        toolCall: { id: "call-switch", name: "switch_computer", args: { kind: "remote" } },
        usage: { input: 20, output: 8 },
      };
    }
    return { textChunks: ["清单整理完了。"], usage: { input: 30, output: 6 } };
  });
  const dataDir = mkdtempSync(join(tmpdir(), "e2e-switch-computer-"));
  let stack: Stack | undefined;
  let localAgent: AgentHandle | undefined;
  let remoteAgent: AgentHandle | undefined;
  const localPrompts: PromptMessage[] = [];
  const remotePrompts: PromptMessage[] = [];
  let localConfigured = 0;
  let remoteConfigured = 0;
  let log = "";
  const logLine = (line: string) => {
    log += `${line}\n`;
  };
  try {
    stack = await startStack({
      upstreamBaseUrl: upstream.baseUrl,
      priceInputPerM: 3,
      priceOutputPerM: 15,
      startComputer: false,
      disconnectGraceMs: 100,
      leaseRenewalIntervalMs: 25,
    });
    const local = ComputerTokenResponse.parse(await stack.post("/api/computers/local", { confirmDisplace: true }));
    const remote = ComputerTokenResponse.parse(await stack.post("/api/computers/remote", {}));
    const service = BotListResponse.parse(await stack.get("/api/bots")).items.find((item) => item.bot.name === "小服");
    if (service === undefined) throw new Error("seed 没建出小服");
    const { bot, groupId } = service;

    localAgent = startComputer(
      stack,
      local,
      join(dataDir, "local"),
      localPrompts,
      () => (localConfigured += 1),
      logLine,
    );
    remoteAgent = startComputer(
      stack,
      remote,
      join(dataDir, "remote"),
      remotePrompts,
      () => (remoteConfigured += 1),
      logLine,
    );
    await expect.poll(() => localConfigured, { ...poll, message: log }).toBeGreaterThan(0);
    await expect.poll(() => remoteConfigured, { ...poll, message: log }).toBeGreaterThan(0);
    await waitForDispatchable(stack, local.computerId);
    await waitForDispatchable(stack, remote.computerId);

    await stack.post(`/api/groups/${groupId}/messages`, { text: SWITCH_MESSAGE });
    await expect.poll(() => remotePrompts.length, { ...poll, message: log }).toBe(1);
    const first = localPrompts.find((prompt) => prompt.text === SWITCH_MESSAGE);
    if (first === undefined) throw new Error(`本机没有收到触发消息的 prompt\n${log}`);
    const next = remotePrompts[0];
    if (next === undefined) throw new Error("云电脑没有收到接续的 prompt");
    expect(next, "接续只带一句接着做的话，不带群历史、任务卡和成员").toMatchObject({
      reason: "continuation",
      text: CONTINUATION_TEXT,
      context: [],
      task: null,
      members: [],
      botId: bot.id,
      groupId,
    });
    expect(next.runId).not.toBe(first.runId);
    expect(next.lane.epoch, "道换到云电脑，代际往前走一代").toBe(first.lane.epoch + 1);
    expect(
      remotePrompts.map((prompt) => prompt.text),
      "触发消息本身没有再派到云电脑",
    ).not.toContain(SWITCH_MESSAGE);
    await waitForCost(stack, groupId, next.runId);

    const resumed = upstream.requests().findLast((request) => lastUserText(request) === CONTINUATION_TEXT);
    if (resumed === undefined) throw new Error(`假上游没有收到云电脑上的接续请求\n${log}`);
    const messages = resumed.messages as readonly ToolCallMessage[];
    const call = messages.find((message) => message.role === "assistant" && message.tool_calls !== undefined);
    expect(call?.tool_calls, "云电脑上的会话里有本机那一次换电脑的调用").toEqual([
      expect.objectContaining({ function: { name: "switch_computer", arguments: JSON.stringify({ kind: "remote" }) } }),
    ]);
    const callId = call?.tool_calls?.[0]?.id;
    const result = messages.find((message) => message.role === "tool" && message.tool_call_id === callId);
    expect(text(result?.content), "换电脑的工具结果也在").toBe(SWITCHED_RESULT);
    expect(text(messages.find((message) => message.role === "user")?.content)).toContain(SWITCH_MESSAGE);
    expect(text(messages.find((message) => message.role === "system")?.content)).toContain(
      "## 电脑\n这一轮你在云电脑上：一台 Linux 服务器，不是主人的电脑。",
    );
    expect(
      upstream.requests().filter((request) => lastUserText(request).includes(SWITCH_MESSAGE)),
      "本机那一轮在工具结果之后没有再问模型",
    ).toHaveLength(1);

    expect(ComputerChoices.parse(await stack.get(`/api/groups/${groupId}/computer-choices`))).toEqual([
      { botId: bot.id, kind: "remote", runningOn: null },
    ]);
    const [continued] = await stack.sql<{ continues_run_id: string | null; computer_id: string }[]>`
      SELECT continues_run_id, computer_id FROM runs WHERE id = ${next.runId}
    `;
    expect(continued).toEqual({ continues_run_id: first.runId, computer_id: remote.computerId });
  } finally {
    await localAgent?.stop();
    await remoteAgent?.stop();
    await stack?.close();
    await upstream.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
