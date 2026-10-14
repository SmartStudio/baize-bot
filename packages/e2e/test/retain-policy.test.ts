import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  BotListResponse,
  CreateGroupResponse,
  EMPTY_WORK_HEAD,
  MessageListResponse,
  RecallResponse,
  ToolResponse,
  advanceWorkHead,
  type WorkAppend,
} from "@baize/shared";
import { describe, expect, it, vi } from "vitest";
import { startTestMcp } from "../src/mcp.js";
import { startStack, type Stack } from "../src/stack.js";
import { startUpstream, type ChatRequest, type ScriptedTurn } from "../src/upstream.js";

const POLL = { timeout: 30_000, interval: 25 };
const USAGE = { input: 120, output: 20 };
const SOURCE = "X3 库存 120";
const LOOKUP_PROMPT = "留存策略验收：查 X3 库存";
const RECALL_BEFORE_PROMPT = "留存策略验收：召回库存原文";
const RECALL_QUERY = "120";

const textOf = (content: unknown): string => (typeof content === "string" ? content : JSON.stringify(content));

function lastUserText(request: ChatRequest): string {
  const lastUser = request.messages.findLast((message) => message.role === "user");
  return lastUser === undefined ? "" : textOf(lastUser.content);
}

function hasToolAfterLastUser(request: ChatRequest): boolean {
  const lastUser = request.messages.findLastIndex((message) => message.role === "user");
  return request.messages.slice(lastUser + 1).some((message) => message.role === "tool");
}

function script(request: ChatRequest): ScriptedTurn {
  const prompt = lastUserText(request);
  if (prompt.includes(LOOKUP_PROMPT) && !hasToolAfterLastUser(request)) {
    return {
      textChunks: [],
      toolCall: { id: "retain-lookup", name: "lookup_stock", args: { sku: "X3" } },
      usage: USAGE,
    };
  }
  if (prompt.includes(RECALL_BEFORE_PROMPT) && !hasToolAfterLastUser(request)) {
    return {
      textChunks: [],
      toolCall: {
        id: `retain-recall-${request.messages.length}`,
        name: "recall_memory",
        args: { query: RECALL_QUERY },
      },
      usage: USAGE,
    };
  }
  return { textChunks: ["已处理。"], usage: USAGE };
}

async function sendAndSettle(stack: Stack, groupId: string, text: string): Promise<void> {
  await stack.post(`/api/groups/${groupId}/messages`, { text });
  for (;;) {
    const push = await stack.nextPush();
    if (push.type === "message" && push.message.groupId === groupId && push.message.body.kind === "cost") return;
  }
}

async function recallToolResult(requests: readonly ChatRequest[], prompt: string): Promise<string> {
  const matching = requests.filter((request) => lastUserText(request).includes(prompt));
  expect(matching.length).toBeGreaterThanOrEqual(2);
  const followUp = matching.findLast((request) => request.messages.some((message) => message.role === "tool"));
  if (followUp === undefined) throw new Error(`没有收到「${prompt}」对应的 recall_memory 结果`);
  const result = followUp.messages.findLast((message) => message.role === "tool");
  return result === undefined ? "" : textOf(result.content);
}

async function sessionFile(stack: Stack, botId: string, groupId: string): Promise<{ path: string; text: string }> {
  const directory = join(stack.dataDir, botId, "sessions", groupId);
  const metadata = JSON.parse(await readFile(join(directory, "lane.json"), "utf8")) as {
    streams: { chat?: { sessionFile: string | null } };
  };
  const path = metadata.streams.chat?.sessionFile;
  if (path === undefined || path === null) throw new Error(`lane.json 没有 chat sessionFile：${directory}`);
  return { path, text: await readFile(path, "utf8") };
}

async function createRecallGroup(stack: Stack, botId: string, peerId: string, title: string): Promise<string> {
  return CreateGroupResponse.parse(await stack.post("/api/groups", { title, botIds: [botId, peerId] })).group.id;
}

describe("端到端：本机工具留存策略更新后收敛服务器工作记录", () => {
  it("更新 localOnly 后先回退不合规尾部，再由真运行器续传脱敏历史且保留本机会话", async () => {
    const mcp = await startTestMcp();
    const upstream = await startUpstream(script);
    const sentFrames: WorkAppend[] = [];
    let stack: Stack | undefined;
    try {
      stack = await startStack({
        upstreamBaseUrl: upstream.baseUrl,
        priceInputPerM: 0,
        priceOutputPerM: 0,
        beforeReliableSend: (frame) => {
          if (frame.body.type === "work_append") sentFrames.push(frame.body);
        },
      });
      const bots = BotListResponse.parse(await stack.get("/api/bots")).items;
      const service = bots.find((item) => item.bot.name === "小服");
      const peer = bots.find((item) => item.bot.name === "小采");
      if (service === undefined || peer === undefined) throw new Error("seed 缺少小服或小采");

      const tool = ToolResponse.parse(
        await stack.post("/api/tools", {
          name: "库存查询",
          url: mcp.baseUrl,
          authorization: "Bearer e2e-token",
          localOnly: false,
        }),
      ).tool;
      const assigned = ToolResponse.parse(
        await stack.patch(`/api/tools/${tool.id}`, { assignedBotIds: [service.bot.id] }),
      ).tool;
      expect(assigned.localOnly).toBe(false);

      const sourceGroup = service.groupId;
      await sendAndSettle(stack, sourceGroup, LOOKUP_PROMPT);
      await expect.poll(() => mcp.calls().length, POLL).toBe(1);
      const sourcePrompt = stack.prompts().findLast((prompt) => prompt.groupId === sourceGroup);
      if (sourcePrompt === undefined) throw new Error("真实运行器没有收到库存查询任务");
      const localBefore = await sessionFile(stack, service.bot.id, sourceGroup);
      expect(localBefore.text).toContain(SOURCE);
      const staleDir = join(stack.dataDir, service.bot.id, "sessions", sourceGroup, ".stale");
      const staleFilesBeforePolicy = await readdir(staleDir).catch(() => []);

      const beforeRows = await stack.sql<{ seq: number; line: string; search_text: string }[]>`
        SELECT seq, line, search_text FROM work_entries
        WHERE bot_id = ${service.bot.id} AND group_id = ${sourceGroup} AND stream = 'chat'
        ORDER BY seq
      `;
      expect(JSON.stringify(beforeRows)).toContain(SOURCE);
      expect(
        sentFrames.some(
          (frame) =>
            frame.lane.botId === service.bot.id &&
            frame.lane.groupId === sourceGroup &&
            frame.lines.join("\n").includes(SOURCE),
        ),
      ).toBe(true);

      const beforeGroup = await createRecallGroup(stack, service.bot.id, peer.bot.id, "留存策略更新前召回");
      const beforeRequestCount = upstream.requests().length;
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      let gatewayKey: string | undefined;
      try {
        await sendAndSettle(stack, beforeGroup, `@小服 ${RECALL_BEFORE_PROMPT}`);
        const beforeRecall = await recallToolResult(
          upstream.requests().slice(beforeRequestCount),
          RECALL_BEFORE_PROMPT,
        );
        expect(beforeRecall).toContain(SOURCE);
        const recallFetch = fetchSpy.mock.calls.findLast(([input]) => {
          const url = input instanceof Request ? input.url : String(input);
          return new URL(url).pathname === "/hub/v1/recall";
        });
        if (recallFetch === undefined) throw new Error("真实 recall_memory 没有调用 Hub recall");
        const recallAuthorization = new Headers(recallFetch[1]?.headers).get("authorization");
        if (recallAuthorization === null || !recallAuthorization.startsWith("Bearer "))
          throw new Error("真实 recall_memory 没有携带网关 key");
        gatewayKey = recallAuthorization.slice("Bearer ".length);
      } finally {
        fetchSpy.mockRestore();
      }
      if (gatewayKey === undefined) throw new Error("没能取得当前真实连接的网关 key");

      const changed = ToolResponse.parse(await stack.patch(`/api/tools/${tool.id}`, { localOnly: true })).tool;
      expect(changed.localOnly).toBe(true);

      const afterPolicyRows = await stack.sql<{ line: string; search_text: string }[]>`
        SELECT line, search_text FROM work_entries
        WHERE bot_id = ${service.bot.id} AND group_id = ${sourceGroup} AND stream = 'chat'
        ORDER BY seq
      `;
      expect(JSON.stringify(afterPolicyRows)).not.toContain(SOURCE);
      expect(afterPolicyRows.map((row) => row.line).join("\n")).not.toContain("[本机工具结果，原文未上传");
      const readerPrompt = stack.prompts().findLast((prompt) => prompt.groupId === beforeGroup);
      if (readerPrompt === undefined) throw new Error("真实运行器没有收到召回群任务");
      const directRecall = await fetch(`http://127.0.0.1:${stack.port}/hub/v1/recall`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${gatewayKey}`,
          "content-type": "application/json",
          "x-baize-lane": `${service.bot.id}/${beforeGroup}/${readerPrompt.lane.epoch}`,
        },
        body: JSON.stringify({ query: RECALL_QUERY }),
      });
      expect(directRecall.status).toBe(200);
      expect(RecallResponse.parse(await directRecall.json())).toEqual([]);

      const localOnlyBeforeNext = await sessionFile(stack, service.bot.id, sourceGroup);
      const frameCountBeforeNext = sentFrames.length;
      await sendAndSettle(stack, sourceGroup, "继续处理，不要再查库存");
      const localAfterNext = await sessionFile(stack, service.bot.id, sourceGroup);
      expect(localOnlyBeforeNext.path).toBe(localBefore.path);
      expect(localAfterNext.path).toBe(localBefore.path);
      expect(localAfterNext.text).toContain(SOURCE);
      expect(await readdir(staleDir).catch(() => [])).toEqual(staleFilesBeforePolicy);

      const resumedFrames = sentFrames
        .slice(frameCountBeforeNext)
        .filter((frame) => frame.lane.botId === service.bot.id && frame.lane.groupId === sourceGroup);
      expect(resumedFrames.length).toBeGreaterThan(0);
      expect(resumedFrames.map((frame) => frame.lines.join("\n")).join("\n")).toContain(
        "[本机工具结果，原文未上传 tool=lookup_stock",
      );
      expect(resumedFrames.map((frame) => frame.lines.join("\n")).join("\n")).not.toContain(SOURCE);

      const finalRows = await stack.sql<{ seq: number; line: string; search_text: string }[]>`
        SELECT seq, line, search_text FROM work_entries
        WHERE bot_id = ${service.bot.id} AND group_id = ${sourceGroup} AND stream = 'chat'
        ORDER BY seq
      `;
      expect(JSON.stringify(finalRows)).not.toContain(SOURCE);
      expect(finalRows.map((row) => row.seq)).toEqual(finalRows.map((_, index) => index));
      const [stream] = await stack.sql<{ next_seq: number; head: string }[]>`
        SELECT next_seq, head FROM work_streams
        WHERE bot_id = ${service.bot.id} AND group_id = ${sourceGroup} AND stream = 'chat'
      `;
      if (stream === undefined) throw new Error("真运行器上传后 work_streams 不存在");
      const lines = finalRows.map((row) => row.line);
      expect(stream.next_seq).toBe(lines.length);
      expect(stream.head).toBe(await advanceWorkHead(EMPTY_WORK_HEAD, lines));

      const sourceMessages = MessageListResponse.parse(await stack.get(`/api/groups/${sourceGroup}/messages`));
      expect(
        sourceMessages.messages.some(
          (message) => message.body.kind === "system" && message.body.text.includes("这台电脑读不了之前的记录"),
        ),
      ).toBe(false);
    } finally {
      await stack?.close();
      await upstream.close();
      await mcp.close();
    }
  });
});
