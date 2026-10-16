import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BotListResponse, ComputerListResponse, ComputerTokenResponse, type ServerPush } from "@baize/shared";
import { createRunner, type PromptMessage } from "@baize/bot-runner";
import { startAgent, type AgentHandle } from "@baize/computer-agent";
import { startStack, type Stack } from "../src/stack.js";
import { type ChatRequest, startUpstream } from "../src/upstream.js";

const poll = { timeout: 10_000, interval: 25 };

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

const systemText = (request: ChatRequest): string => text(request.messages.find((m) => m.role === "system")?.content);

const requestFor = (requests: readonly ChatRequest[], message: string): ChatRequest => {
  const found = requests.findLast((request) =>
    text(request.messages.findLast((m) => m.role === "user")?.content).includes(message),
  );
  if (found === undefined) throw new Error(`「${message}」没有到达假上游`);
  return found;
};

/** 一次 prompt 只发给模型一轮，等到群里的 cost 消息就等于这一轮的请求已经到了假上游。 */
async function sendAndSettle(stack: Stack, groupId: string, message: string): Promise<void> {
  await stack.post(`/api/groups/${groupId}/messages`, { text: message });
  for (;;) {
    const push: ServerPush = await stack.nextPush();
    if (push.type === "message" && push.message.groupId === groupId && push.message.body.kind === "cost") return;
  }
}

it("Bot 在云电脑上时，上游请求的系统段写着这一轮在云电脑上；Mac 单机时没有这一段", async () => {
  const upstream = await startUpstream(() => ({ textChunks: ["收到"], usage: { input: 20, output: 5 } }));
  const dataDir = mkdtempSync(join(tmpdir(), "e2e-computer-section-"));
  let stack: Stack | undefined;
  let remoteAgent: AgentHandle | undefined;
  let remoteLog = "";
  try {
    stack = await startStack({ upstreamBaseUrl: upstream.baseUrl, priceInputPerM: 3, priceOutputPerM: 15 });
    const service = BotListResponse.parse(await stack.get("/api/bots")).items.find((item) => item.bot.name === "小服");
    if (service === undefined) throw new Error("seed 没建出小服");

    await sendAndSettle(stack, service.groupId, "只有一台电脑时问一句");
    expect(systemText(requestFor(upstream.requests(), "只有一台电脑时问一句")), "Mac 单机用户没有电脑段").not.toContain(
      "## 电脑",
    );

    const remote = ComputerTokenResponse.parse(await stack.post("/api/computers/remote", {}));
    const remotePrompts: PromptMessage[] = [];
    let remoteConfigs = 0;
    remoteAgent = startAgent({
      ...remote,
      url: `ws://127.0.0.1:${stack.port}/agent`,
      version: "0.1.0-e2e-remote",
      dataDir,
      makeChrome: () => ({
        kind: "local",
        profileDir: join(dataDir, "chrome"),
        connection: () => Promise.reject(new Error("电脑段用例不使用 Chrome")),
        onExit: () => () => {},
        reveal: async () => {},
        conceal: async () => {},
        pid: () => null,
        stop: async () => {},
      }),
      makeRunner: (config) => {
        const runner = createRunner(config);
        remoteConfigs += 1;
        return {
          ...runner,
          prompt: (message) => {
            remotePrompts.push(message);
            return runner.prompt(message);
          },
        };
      },
      log: (line) => {
        remoteLog += `${line}\n`;
      },
    });
    await expect.poll(() => remoteConfigs, { ...poll, message: remoteLog }).toBeGreaterThan(0);
    await expect
      .poll(
        async () =>
          ComputerListResponse.parse(await stack!.get("/api/computers")).computers.find(
            (computer) => computer.id === remote.computerId,
          )?.dispatchable,
        poll,
      )
      .toBe(true);

    await stack.put(`/api/groups/${service.groupId}/bots/${service.bot.id}/computer`, { kind: "remote" });
    await sendAndSettle(stack, service.groupId, "换到云电脑以后再问一句");

    expect(
      remotePrompts.map((prompt) => prompt.text),
      "这一条派到了云电脑",
    ).toContain("换到云电脑以后再问一句");
    const system = systemText(requestFor(upstream.requests(), "换到云电脑以后再问一句"));
    expect(system, remoteLog).toContain("## 电脑\n这一轮你在云电脑上：一台 Linux 服务器，不是主人的电脑。");
    expect(system, "主人的电脑还连着").toContain(
      "另一台是主人的电脑，在线。需要换过去就调用 switch_computer（kind 填 local），这一轮会在那边接着做，不用让主人自己去点。",
    );
    expect(system, "基础系统提示不改").toContain("你是白泽 Bot，在主人的电脑上替主人干活。");
  } finally {
    await remoteAgent?.stop();
    await stack?.close();
    await upstream.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
