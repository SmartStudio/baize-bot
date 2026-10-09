import { expect, it } from "vitest";
import { BotListResponse, MessageListResponse } from "@baize/shared";
import { startStack, type Stack } from "../src/stack.js";
import { startUpstream } from "../src/upstream.js";

const poll = { timeout: 10_000, interval: 25 };

it("电脑代理到控制面那一段断开期间 run 跑完：接上后补发 run_done，run 记真步骤和真 token，群里是费用卡不是断线", async () => {
  let reachedHold = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const upstream = await startUpstream(() => ({
    textChunks: [
      "先说半句，",
      async () => {
        reachedHold = true;
        await held;
      },
      "断开期间说完。",
    ],
    usage: { input: 20, output: 5 },
  }));
  let started: Stack | undefined;
  try {
    // 宽限设长：断开到接上之间只剩 hello 对账一处会收尾，看的是它放不放过待补发的 run。
    const stack = await startStack({
      upstreamBaseUrl: upstream.baseUrl,
      priceInputPerM: 3,
      priceOutputPerM: 15,
      disconnectGraceMs: 60_000,
      cuttableAgentLink: true,
    });
    started = stack;
    const bot = BotListResponse.parse(await stack.get("/api/bots")).items.find((item) => item.bot.name === "小服");
    if (bot === undefined) throw new Error("seed 没建出小服");
    const { groupId } = bot;
    await stack.post(`/api/groups/${groupId}/messages`, { text: "说两句话" });
    await expect.poll(() => reachedHold, poll).toBe(true);

    stack.cutAgentLink();
    await expect.poll(() => stack.agentLog().includes("后重连"), poll).toBe(true);
    release();
    await expect.poll(() => /run \S+ 的 run_done 留到重连后补发/.test(stack.agentLog()), poll).toBe(true);
    const [open] = await stack.sql<{ ended_at: Date | null }[]>`SELECT ended_at FROM runs WHERE group_id = ${groupId}`;
    expect(open?.ended_at, "前提：run 在代理那头跑完时控制面还没收到 run_done").toBeNull();

    stack.restoreAgentLink();
    const bodies = async () =>
      MessageListResponse.parse(await stack.get(`/api/groups/${groupId}/messages`)).messages.map(
        (message) => message.body,
      );
    await expect.poll(async () => (await bodies()).some((body) => body.kind === "cost"), poll).toBe(true);

    const [run] = await stack.sql<{ id: string; steps: number; input_tokens: number; output_tokens: number }[]>`
      SELECT id, steps, input_tokens, output_tokens FROM runs WHERE group_id = ${groupId}
    `;
    expect(run, stack.agentLog()).toMatchObject({ input_tokens: 20, output_tokens: 5 });
    expect(run?.steps).toBeGreaterThan(0);
    const settled = await bodies();
    expect(settled.filter((body) => body.kind === "cost" && body.runId === run?.id)).toHaveLength(1);
    expect(settled.filter((body) => body.kind === "system" && body.text.includes("断过线"))).toEqual([]);
  } finally {
    release();
    await started?.close();
    await upstream.close();
  }
});
