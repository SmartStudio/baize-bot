import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { BotListResponse, ComputerListResponse, ComputerTokenResponse, type ComputerId } from "@baize/shared";
import { createRunner, type PromptMessage } from "@baize/bot-runner";
import { startAgent, type AgentHandle } from "@baize/computer-agent";
import { startStack, type Stack } from "../src/stack.js";
import { type ChatRequest, startUpstream } from "../src/upstream.js";

const poll = { timeout: 10_000, interval: 25 };
const PRICE_INPUT_PER_M = 3;
const PRICE_OUTPUT_PER_M = 15;

function startComputer(
  stack: Stack,
  credentials: { readonly computerId: ComputerId; readonly token: string },
  dataDir: string,
  prompts: PromptMessage[],
  onConfigured: () => void,
): AgentHandle {
  return startAgent({
    url: `ws://127.0.0.1:${stack.port}/agent`,
    ...credentials,
    version: "0.1.0-e2e-work-rebuild",
    dataDir,
    backoff: { initialMs: 50, maxMs: 100, factor: 1 },
    makeChrome: () => ({
      kind: "local",
      profileDir: join(dataDir, "chrome"),
      connection: () => Promise.reject(new Error("工作记录恢复用例不使用 Chrome")),
      login: async () => ({ login: "failed", reason: "window_failed" }),
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
  });
}

async function waitForComputer(stack: Stack, computerId: ComputerId, status: "online" | "sleeping"): Promise<void> {
  await expect
    .poll(
      async () =>
        ComputerListResponse.parse(await stack.get("/api/computers")).computers.find((item) => item.id === computerId)
          ?.status,
      poll,
    )
    .toBe(status);
}

async function waitForCost(stack: Stack, groupId: string): Promise<void> {
  for (;;) {
    const push = await stack.nextPush();
    if (push.type === "message" && push.message.groupId === groupId && push.message.body.kind === "cost") return;
  }
}

function requestText(request: ChatRequest): string {
  return request.messages
    .filter((message) => message.role === "user")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .join("\n");
}

it("新远程电脑从服务器重建本机完成两轮后的运行器历史", async () => {
  const upstream = await startUpstream((request) => {
    const prompt = requestText(request);
    const text = prompt.includes("恢复验收第三轮")
      ? "远程第三轮完成"
      : prompt.includes("恢复验收第二轮")
        ? "本机第二轮完成"
        : "本机第一轮完成";
    return { textChunks: [text], usage: { input: 25, output: 5 } };
  });
  const dataDir = mkdtempSync(join(tmpdir(), "e2e-work-rebuild-"));
  let stack: Stack | undefined;
  let localAgent: AgentHandle | undefined;
  let remoteAgent: AgentHandle | undefined;
  const localPrompts: PromptMessage[] = [];
  const remotePrompts: PromptMessage[] = [];
  let localConfigured = 0;
  let remoteConfigured = 0;

  try {
    stack = await startStack({
      upstreamBaseUrl: upstream.baseUrl,
      priceInputPerM: PRICE_INPUT_PER_M,
      priceOutputPerM: PRICE_OUTPUT_PER_M,
      startComputer: false,
      disconnectGraceMs: 100,
      leaseRenewalIntervalMs: 25,
    });
    const local = ComputerTokenResponse.parse(await stack.post("/api/computers/local", { confirmDisplace: true }));
    const remote = ComputerTokenResponse.parse(await stack.post("/api/computers/remote", {}));
    const target = BotListResponse.parse(await stack.get("/api/bots")).items[0];
    if (target === undefined) throw new Error("seed 没建出 Bot");
    const { groupId } = target;

    localAgent = startComputer(stack, local, join(dataDir, "local"), localPrompts, () => {
      localConfigured += 1;
    });
    await expect.poll(() => localConfigured, poll).toBeGreaterThan(0);
    await waitForComputer(stack, local.computerId, "online");

    for (const message of ["恢复验收第一轮", "恢复验收第二轮"]) {
      const before = localPrompts.length;
      await stack.post(`/api/groups/${groupId}/messages`, { text: message });
      await expect.poll(() => localPrompts.length, poll).toBe(before + 1);
      await waitForCost(stack, groupId);
    }

    await localAgent.stop();
    localAgent = undefined;
    await waitForComputer(stack, local.computerId, "sleeping");
    await expect
      .poll(async () => {
        const [computer] = await stack!.sql<{ expired: boolean }[]>`
            SELECT lease_until <= clock_timestamp() AS expired FROM computers WHERE id = ${local.computerId}
          `;
        return computer?.expired;
      }, poll)
      .toBe(true);

    remoteAgent = startComputer(stack, remote, join(dataDir, "remote"), remotePrompts, () => {
      remoteConfigured += 1;
    });
    await expect.poll(() => remoteConfigured, poll).toBeGreaterThan(0);
    await waitForComputer(stack, remote.computerId, "online");
    await stack.post(`/api/groups/${groupId}/messages`, { text: "恢复验收第三轮" });
    await expect.poll(() => remotePrompts.length, poll).toBe(1);
    await waitForCost(stack, groupId);

    const resumed = upstream.requests().findLast((request) => requestText(request).includes("恢复验收第三轮"));
    if (resumed === undefined) throw new Error("假上游没有收到远程第三轮请求");
    const assistantHistory = resumed.messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.content)
      .filter((content): content is string => typeof content === "string");
    expect(assistantHistory).toContain("本机第一轮完成");
    expect(assistantHistory).toContain("本机第二轮完成");
    expect(remotePrompts[0]?.text).toBe("恢复验收第三轮");
    expect(join(dataDir, "local")).not.toBe(join(dataDir, "remote"));
  } finally {
    await localAgent?.stop();
    await remoteAgent?.stop();
    await stack?.close();
    await upstream.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
