import { describe, expect, it } from "vitest";
import { BotListResponse } from "@baize/shared";
import { startStack } from "../src/stack.js";
import { isFollowUpTurn, startUpstream } from "../src/upstream.js";

describe("Bot 的 bash 环境变量隔离", () => {
  it("bash 的工具结果里没有以 AGENT_TOKEN= 开头的行", async () => {
    let bashToolOutput = "";

    const upstream = await startUpstream((req) => {
      if (isFollowUpTurn(req)) {
        const toolMsg = req.messages.find((m) => m.role === "tool");
        if (toolMsg !== undefined) {
          bashToolOutput = typeof toolMsg.content === "string" ? toolMsg.content : JSON.stringify(toolMsg.content);
        }
        return { textChunks: ["环境变量已读取"], usage: { input: 100, output: 10 } };
      }
      return {
        textChunks: [],
        toolCall: { id: "call-env", name: "bash", args: { command: "env" } },
        usage: { input: 100, output: 10 },
      };
    });

    const stack = await startStack({
      upstreamBaseUrl: upstream.baseUrl,
      priceInputPerM: 3,
      priceOutputPerM: 15,
      agentProcess: true,
    });

    try {
      const bots = BotListResponse.parse(await stack.get("/api/bots"));
      const first = bots.items[0];
      if (first === undefined) throw new Error("seed 没建出 Bot");
      const { groupId } = first;

      await stack.post(`/api/groups/${groupId}/messages`, { text: "运行 env 检查环境" });

      await expect
        .poll(
          async () => {
            const runs = await stack.sql<{ id: string; ended_at: Date | null }[]>`
              SELECT id, ended_at FROM runs WHERE group_id = ${groupId}
            `;
            return runs.length > 0 && runs.every((r) => r.ended_at !== null);
          },
          { timeout: 30_000, interval: 50 },
        )
        .toBe(true);

      const tokenLines = bashToolOutput
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("AGENT_TOKEN="));

      expect(bashToolOutput, "bash 真的跑了 env，不然下面的断言空过").toMatch(/^PATH=/m);
      expect(tokenLines, "bash 的工具结果里不得出现以 AGENT_TOKEN= 开头的行").toEqual([]);
    } finally {
      await stack.close();
      await upstream.close();
    }
  });
});
