import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BotListResponse, MessageListResponse, type ServerPush } from "@baize/shared";
import { botDirs } from "@baize/bot-runner";
import { startStack } from "../src/stack.js";
import { type ChatRequest, isFollowUpTurn, type ScriptedTurn, startUpstream } from "../src/upstream.js";

const PROMPT = "看看电脑里有哪些文件";
const PLANTED_FILE = "quarterly-report.md";
const PRICE_INPUT_PER_M = 3;
const PRICE_OUTPUT_PER_M = 15;

type RunRow = {
  readonly ended_at: Date | null;
  readonly steps: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly amount: string;
};

/**
 * 剧本两轮。第一轮只点工具不说话，第二轮才说话，
 * 群里才会是 tool_call 在前、bot 在后；第一轮就吐字的话 Bot 消息会先建出来。
 */
function script(req: ChatRequest): ScriptedTurn {
  if (!isFollowUpTurn(req)) {
    return {
      textChunks: [],
      toolCall: { id: "call-1", name: "bash", args: { command: "ls" } },
      usage: { input: 1200, output: 30 },
    };
  }
  // 把 ls 的真实输出念回去。这段字要一路回到群里，中间任何一环断了都对不上。
  const listing = req.messages
    .filter((m) => m.role === "tool")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join(" ")
    .split(/\s+/)
    .filter((word) => word.endsWith(".md"))
    .join("、");
  return { textChunks: ["电脑里有 ", `${listing}。`], usage: { input: 1500, output: 24 } };
}

describe("端到端：一句话走完控制面、电脑代理、模型网关", () => {
  it("群里依次出现 tool_call、bot、cost，runs 表多一行", async () => {
    const upstream = await startUpstream(script);
    const stack = await startStack({
      upstreamBaseUrl: upstream.baseUrl,
      priceInputPerM: PRICE_INPUT_PER_M,
      priceOutputPerM: PRICE_OUTPUT_PER_M,
    });

    try {
      const bots = BotListResponse.parse(await stack.get("/api/bots"));
      const first = bots.items[0];
      if (first === undefined) throw new Error("seed 没建出 Bot");
      const { groupId, bot } = first;

      // 摆一个文件进这个 Bot 的 work 目录，ls 才有话可说。
      const { workDir } = botDirs(stack.dataDir, bot.id);
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, PLANTED_FILE), "第三季度\n");

      const runsBefore = await stack.sql<RunRow[]>`SELECT * FROM runs`;

      const sentAt = performance.now();
      await stack.post(`/api/groups/${groupId}/messages`, { text: PROMPT });

      const pushes: ServerPush[] = [];
      let firstDeltaMs: number | null = null;
      for (;;) {
        const push = await stack.nextPush();
        pushes.push(push);
        if (push.type === "message_delta" && firstDeltaMs === null) firstDeltaMs = performance.now() - sentAt;
        if (push.type === "message" && push.message.body.kind === "cost") break;
      }
      const trace = `电脑代理日志：\n${stack.agentLog()}`;

      const messages = pushes.flatMap((p) => (p.type === "message" ? [p.message] : []));
      expect(
        messages.map((m) => m.body.kind),
        trace,
      ).toEqual(["user", "bot", "tool_call", "tool_call", "cost"]);

      const toolCalls = messages.flatMap((m) => (m.body.kind === "tool_call" ? [m.body] : []));
      expect(toolCalls.map((b) => b.status)).toEqual(["running", "ok"]);
      expect(toolCalls[0]?.tool, "点的是 Pi 自带的 bash").toBe("bash");
      expect(toolCalls[0]?.view).toMatchObject({ kind: "bash", command: expect.stringContaining("ls") });
      // 同一张卡改状态，不是两张卡。
      expect(messages[2]?.id).toBe(messages[3]?.id);

      const stored = MessageListResponse.parse(await stack.get(`/api/groups/${groupId}/messages`));
      const tail = stored.messages.slice(-4);
      expect(tail.map((m) => m.body.kind)).toEqual(["user", "bot", "tool_call", "cost"]);
      const answer = tail[1]?.body;
      expect(answer?.kind === "bot" && answer.streaming, "run 结束时 Bot 消息不该还在流").toBe(false);
      expect(answer?.kind === "bot" && answer.text, `ls 的真实输出要一路回到群里。${trace}`).toContain(PLANTED_FILE);

      const runs = await stack.sql<RunRow[]>`SELECT * FROM runs`;
      expect(runs.length).toBe(runsBefore.length + 1);
      const [run] = await stack.sql<RunRow[]>`SELECT * FROM runs WHERE group_id = ${groupId}`;
      expect(run?.ended_at, "run 要结束").not.toBeNull();
      expect(run?.steps).toBeGreaterThan(0);
      expect(run?.input_tokens).toBeGreaterThan(0);
      expect(run?.output_tokens).toBeGreaterThan(0);
      expect(Number(run?.amount)).toBeCloseTo(
        ((run?.input_tokens ?? 0) / 1e6) * PRICE_INPUT_PER_M + ((run?.output_tokens ?? 0) / 1e6) * PRICE_OUTPUT_PER_M,
        6,
      );

      const cost = messages[4]?.body;
      expect(cost?.kind === "cost" && cost.amount).toBeCloseTo(Number(run?.amount), 6);

      expect(upstream.requests().length, "一次工具调用加一次说话，至少两轮").toBeGreaterThanOrEqual(2);
      expect(firstDeltaMs).not.toBeNull();
      console.log(`基线：POST 到第一条 message_delta ${Math.round(firstDeltaMs ?? 0)}ms`);
    } finally {
      await stack.close();
      await upstream.close();
    }
  });
});
