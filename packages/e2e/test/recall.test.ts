import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { BotListResponse, CreateGroupResponse, recallPlaceholder, type WorkAppend } from "@baize/shared";
import { type PromptMessage } from "@baize/bot-runner";
import { describe, expect, it } from "vitest";
import { startStack, type Stack } from "../src/stack.js";
import { startUpstream, type ChatRequest, type ScriptedTurn } from "../src/upstream.js";

const SOURCE = "采购备忘：飞书接入的时间定在下周五，先支持消息推送。";
const RECALL_PROMPT = "查一下以前的采购安排";
const NEXT_PROMPT = "开始下一件事，不查以前的记录";
const usage = { input: 30, output: 8 };
const textOf = (content: unknown): string => (typeof content === "string" ? content : JSON.stringify(content));

function script(request: ChatRequest): ScriptedTurn {
  const lastUser = request.messages.findLastIndex((message) => message.role === "user");
  const current = textOf(request.messages[lastUser]?.content);
  if (current.includes(RECALL_PROMPT)) {
    if (request.messages.slice(lastUser + 1).some((message) => message.role === "tool"))
      return { textChunks: ["已查到采购备忘。"], usage };
    return { textChunks: [], toolCall: { id: "recall-e2e", name: "recall_memory", args: { query: "飞书" } }, usage };
  }
  return { textChunks: ["收到，这一轮完成。"], usage };
}

async function sendAndSettle(stack: Stack, groupId: string, text: string): Promise<PromptMessage> {
  await stack.post(`/api/groups/${groupId}/messages`, { text });
  for (;;) {
    const push = await stack.nextPush();
    if (push.type === "message" && push.message.groupId === groupId && push.message.body.kind === "cost") break;
  }
  const prompt = stack.prompts().findLast((message) => message.groupId === groupId);
  if (prompt === undefined) throw new Error("群消息没有派给真运行器");
  return prompt;
}

async function sessionLines(stack: Stack, prompt: PromptMessage): Promise<string[]> {
  const directory = join(stack.dataDir, prompt.botId, "sessions", prompt.groupId);
  const files = await readdir(directory, { recursive: true });
  const file = files.map(String).find((name) => name.endsWith(".jsonl"));
  if (file === undefined) throw new Error(`找不到真实 Pi 会话：${directory}`);
  const raw = await readFile(join(directory, file), "utf8");
  return raw
    .trim()
    .split("\n")
    .filter((line) => (JSON.parse(line) as { type: string }).type !== "session");
}

describe("端到端：跨群 recall", () => {
  it("A群的真实会话经可靠工作记录通道落库，B群召回带A群标题且下一run不带摘录", async () => {
    const upstream = await startUpstream(script);
    const frames: WorkAppend[] = [];
    const stack = await startStack({
      upstreamBaseUrl: upstream.baseUrl,
      priceInputPerM: 0,
      priceOutputPerM: 0,
      beforeReliableSend: (frame) => {
        if (frame.body.type === "work_append") frames.push(frame.body);
      },
    });
    try {
      const items = BotListResponse.parse(await stack.get("/api/bots")).items;
      const first = items.find((item) => item.bot.name === "小服");
      const peer = items.find((item) => item.bot.name === "小采");
      if (first === undefined || peer === undefined) throw new Error("seed 缺少小服或小采");
      const { group } = CreateGroupResponse.parse(
        await stack.post("/api/groups", { title: "飞书采购备忘", botIds: [first.bot.id, peer.bot.id] }),
      );
      const sourcePrompt = await sendAndSettle(stack, group.id, `@小服 ${SOURCE}`);
      const sourceLines = await sessionLines(stack, sourcePrompt);
      expect(sourceLines.join("\n")).toContain(SOURCE);
      const storedSource = await stack.sql<
        { line: string }[]
      >`SELECT line FROM work_entries WHERE bot_id = ${first.bot.id} AND group_id = ${group.id} ORDER BY seq`;
      expect(storedSource.map((row) => row.line)).toEqual(sourceLines);

      const beforeRecall = upstream.requests().length;
      const recalled = await sendAndSettle(stack, first.groupId, RECALL_PROMPT);
      const requests = upstream.requests().slice(beforeRecall);
      expect(requests).toHaveLength(2);
      const recalledTool = requests[1]?.messages.find((message) => message.role === "tool");
      expect(textOf(recalledTool?.content)).toContain(SOURCE);
      expect(textOf(recalledTool?.content)).toContain("飞书采购备忘");
      expect(textOf(recalledTool?.content)).toContain(group.id);
      const recallLines = await sessionLines(stack, recalled);
      expect(recallLines.join("\n")).toContain(recallPlaceholder(1));
      expect(recallLines.join("\n")).not.toContain(SOURCE);
      const recallUploaded = frames.filter((frame) => frame.runId === recalled.runId).flatMap((frame) => frame.lines);
      expect(recallUploaded).toEqual(recallLines);
      expect(recallUploaded.join("\n")).not.toContain(SOURCE);
      const storedRecall = await stack.sql<
        { line: string; search_text: string }[]
      >`SELECT line, search_text FROM work_entries WHERE bot_id = ${first.bot.id} AND group_id = ${first.groupId} ORDER BY seq`;
      expect(storedRecall.map((row) => row.line)).toEqual(recallLines);
      expect(storedRecall.map((row) => row.line).join("\n")).toContain(recallPlaceholder(1));
      expect(JSON.stringify(storedRecall)).not.toContain(SOURCE);

      const beforeNext = upstream.requests().length;
      await sendAndSettle(stack, first.groupId, NEXT_PROMPT);
      const next = upstream.requests().slice(beforeNext);
      expect(next).toHaveLength(1);
      expect(JSON.stringify(next)).not.toContain(SOURCE);
      expect(JSON.stringify(next)).toContain(recallPlaceholder(1));
    } finally {
      await stack.close();
      await upstream.close();
    }
  });
});
