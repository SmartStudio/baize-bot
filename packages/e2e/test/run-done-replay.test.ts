import { expect, it } from "vitest";
import { BotListResponse, MessageListResponse } from "@baize/shared";
import { startStack, type Stack } from "../src/stack.js";
import { startUpstream } from "../src/upstream.js";

const poll = { timeout: 10_000, interval: 25 };

it("电脑代理到控制面那一段断开期间 run 跑完：接上后补发 run_done，run 记真步骤和真 token，群里是费用卡不是断线", async () => {
  let started: Stack | undefined;
  let injected!: () => void;
  const injection = new Promise<void>((resolve) => {
    injected = resolve;
  });
  let cut = false;
  const upstream = await startUpstream(() => ({
    textChunks: ["先说半句，", "断开期间说完。"],
    usage: { input: 20, output: 5 },
  }));
  try {
    const stack = await startStack({
      upstreamBaseUrl: upstream.baseUrl,
      priceInputPerM: 3,
      priceOutputPerM: 15,
      cuttableAgentLink: true,
      beforeReliableSend: (frame) => {
        if (!cut && frame.body.type === "run_done") {
          cut = true;
          stack?.cutAgentLink();
          injected();
        }
      },
    });
    started = stack;
    const bot = BotListResponse.parse(await stack.get("/api/bots")).items.find((item) => item.bot.name === "小服");
    if (bot === undefined) throw new Error("seed 没建出小服");
    const { groupId } = bot;
    await stack.post(`/api/groups/${groupId}/messages`, { text: "说两句话" });
    await injection;
    const [open] = await stack.sql<{ ended_at: Date | null }[]>`SELECT ended_at FROM runs WHERE group_id = ${groupId}`;
    expect(open?.ended_at, "run_done 已 fsync，但在发送前切断了连接").toBeNull();

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
    await started?.close();
    await upstream.close();
  }
});
