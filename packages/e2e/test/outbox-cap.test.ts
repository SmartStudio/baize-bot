import { expect, it } from "vitest";
import { BotListResponse, MessageListResponse } from "@baize/shared";
import { startStack, type Stack } from "../src/stack.js";
import { startUpstream } from "../src/upstream.js";

const poll = { timeout: 15_000, interval: 25 };
const KiB = 1024;
const BACKLOG = "…（电脑离线太久，积压的输出太多，后面的已截掉）";

it("断线期间发件箱积压超过上限：重连后群里是收短的正文加原因，run 照常收尾记费用，不是报错", async () => {
  let started: Stack | undefined;
  let cut = false;
  const long = "长".repeat(100 * KiB);
  const upstream = await startUpstream(() => ({ textChunks: ["开头。", long], usage: { input: 20, output: 5 } }));
  try {
    const stack = await startStack({
      upstreamBaseUrl: upstream.baseUrl,
      priceInputPerM: 3,
      priceOutputPerM: 15,
      cuttableAgentLink: true,
      outboxLimits: { maxBytes: 128 * KiB, trimToBytes: 96 * KiB },
      beforeReliableSend: (frame) => {
        if (!cut && frame.body.type === "bot_text_done") {
          cut = true;
          stack?.cutAgentLink();
        }
      },
    });
    started = stack;
    const bot = BotListResponse.parse(await stack.get("/api/bots")).items.find((item) => item.bot.name === "小服");
    if (bot === undefined) throw new Error("seed 没建出小服");
    const { groupId } = bot;
    await stack.post(`/api/groups/${groupId}/messages`, { text: "说一大段" });
    await expect.poll(() => stack.agentLog(), poll).toMatch(/发件箱积压超过上限 131072 字节，收短了最早的 \d+ 帧/);

    stack.restoreAgentLink();
    const bodies = async () =>
      MessageListResponse.parse(await stack.get(`/api/groups/${groupId}/messages`)).messages.map(
        (message) => message.body,
      );
    await expect.poll(async () => (await bodies()).some((body) => body.kind === "cost"), poll).toBe(true);

    const settled = await bodies();
    const said = settled.flatMap((body) => (body.kind === "bot" ? [body.text] : []));
    expect(said, stack.agentLog()).toHaveLength(1);
    const [text = ""] = said;
    expect(text.endsWith(BACKLOG)).toBe(true);
    expect(`开头。${long}`.startsWith(text.slice(0, -BACKLOG.length))).toBe(true);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * KiB);
    const [run] = await stack.sql<{ input_tokens: number; output_tokens: number }[]>`
      SELECT input_tokens, output_tokens FROM runs WHERE group_id = ${groupId}
    `;
    expect(run).toMatchObject({ input_tokens: 20, output_tokens: 5 });
    const errors = settled.flatMap((body) => (body.kind === "system" ? [body.text] : []));
    expect(
      errors.filter((line) => !line.includes("工作记录停止上传")),
      "超限只让工作记录停流，正文和 run 都不报错",
    ).toEqual([]);
  } finally {
    await started?.close();
    await upstream.close();
  }
});
