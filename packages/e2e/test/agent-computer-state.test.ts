import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BotListResponse, ComputerTokenResponse, type UplinkFrame } from "@baize/shared";
import { startAgent, type AgentHandle } from "@baize/computer-agent";
import { createRunner } from "@baize/bot-runner";
import { startStack, type Stack } from "../src/stack.js";
import { startUpstream } from "../src/upstream.js";

it("同一 dataDir 先后连两台电脑记录，第二台最前面的下行全部应用", async () => {
  const upstream = await startUpstream(() => ({ textChunks: ["已完成"], usage: { input: 3, output: 2 } }));
  let stack: Stack | undefined;
  let agent: AgentHandle | undefined;
  const frames: UplinkFrame[] = [];
  const prompts: string[] = [];
  let configured = 0;
  try {
    stack = await startStack({
      upstreamBaseUrl: upstream.baseUrl,
      priceInputPerM: 3,
      priceOutputPerM: 15,
      startComputer: false,
    });
    const local = ComputerTokenResponse.parse(await stack.post("/api/computers/local", {}));
    const remote = ComputerTokenResponse.parse(await stack.post("/api/computers/remote", {}));
    expect(remote.computerId).not.toBe(local.computerId);
    const bot = BotListResponse.parse(await stack.get("/api/bots")).items.find((item) => item.bot.name === "小服");
    if (bot === undefined) throw new Error("seed 缺少小服");
    const connect = (computer: typeof local) =>
      startAgent({
        url: `ws://127.0.0.1:${stack!.port}/agent`,
        computerId: computer.computerId,
        token: computer.token,
        version: "computer-state-e2e",
        dataDir: stack!.dataDir,
        backoff: { initialMs: 50, maxMs: 100, factor: 1 },
        log: () => {},
        beforeReliableSend: (frame) => frames.push(frame),
        makeChrome: () => ({
          kind: "local",
          profileDir: join(stack!.dataDir, "fake-chrome"),
          connection: () => Promise.reject(new Error("验收不启动浏览器")),
          onExit: () => () => {},
          reveal: async () => {},
          conceal: async () => {},
          pid: () => null,
          stop: async () => {},
        }),
        makeRunner: (config) => {
          configured += 1;
          const runner = createRunner(config);
          return {
            ...runner,
            prompt: (message) => {
              prompts.push(message.text);
              return runner.prompt(message);
            },
          };
        },
      });
    agent = connect(local);
    await expect.poll(() => configured, { timeout: 10_000 }).toBe(1);
    await stack.post(`/api/groups/${bot.groupId}/messages`, { text: "第一台电脑" });
    await expect
      .poll(
        async () => {
          const state = JSON.parse(await readFile(join(stack!.dataDir, ".agent", "outbox", "state.json"), "utf8")) as {
            acked: number;
          };
          return state.acked;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    const oldStream = frames[0]?.stream;
    expect(oldStream).toBeDefined();
    // 工作记录也会得到 ACK，不能把第一个上行 ACK 当成 run 已结账。
    await expect
      .poll(
        async () => {
          const [run] = await stack!.sql<
            { done: boolean }[]
          >`SELECT charged_at IS NOT NULL AS done FROM runs WHERE group_id = ${bot.groupId}`;
          return run?.done;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    await agent.stop();
    agent = connect(remote);
    await expect.poll(() => configured, { timeout: 10_000 }).toBe(2);
    await stack.post(`/api/groups/${bot.groupId}/messages`, { text: "第二台第1条" });
    await stack.post(`/api/groups/${bot.groupId}/messages`, { text: "第二台第2条" });
    await expect.poll(() => prompts, { timeout: 30_000 }).toEqual(["第一台电脑", "第二台第1条", "第二台第2条"]);
    await expect
      .poll(() => frames.filter((frame) => frame.stream !== oldStream).length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    const fresh = frames.find((frame) => frame.stream !== oldStream);
    expect(fresh?.seq).toBe(1);
    const rows = await stack.sql<
      { up_stream: string | null; up_acked: number; down_applied: number; conn_gen: number }[]
    >`SELECT up_stream, up_acked, down_applied, conn_gen FROM computers WHERE id = ${remote.computerId}`;
    expect(rows[0]?.up_stream).toBe(fresh?.stream);
    expect(rows[0]?.conn_gen, "第二台电脑第一次握手成功，不因 1011 重连").toBe(1);
    await expect
      .poll(
        async () => {
          const cursors = await stack!.sql<
            { down_applied: number }[]
          >`SELECT down_applied FROM computers WHERE id = ${remote.computerId}`;
          return cursors[0]?.down_applied;
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(2);
  } finally {
    await agent?.stop();
    await stack?.close();
    await upstream.close();
  }
});
