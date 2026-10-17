import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentToControl,
  advanceWorkHead,
  BotId,
  ComputerId,
  EMPTY_WORK_HEAD,
  GroupId,
  MessageId,
  recallPlaceholder,
  type RecallEntry,
  RunId,
  type WorkAppend,
} from "@baize/shared";
import { createRetainer } from "@baize/shared/work-record";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunner, type PromptMessage, type RunnerConfig, type RunnerTool } from "../src/index.js";
import type { Recalls } from "../src/recall.js";
import { startGateway } from "./fixtures/gateway.js";
import { scriptedUpstream, type ChatCompletionRequest, type ScriptedTurn } from "./fixtures/openai-sse.js";

const probe = vi.hoisted(() => ({ sessions: [] as AgentSession[], recalls: [] as Recalls[] }));
vi.mock("../src/bot-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/bot-session.js")>();
  return {
    ...actual,
    async createBotSession(options: Parameters<typeof actual.createBotSession>[0]) {
      const created = await actual.createBotSession(options);
      probe.sessions.push(created.session);
      probe.recalls.push(options.recalls);
      return created;
    },
  };
});

const entry = (excerpt: string, suffix = "a"): RecallEntry => ({
  groupId: GroupId.parse(`source-${suffix}`),
  groupTitle: `原来的群${suffix}`,
  at: "2026-10-13T02:04:06.000Z",
  kind: "assistant",
  excerpt,
});
const firstEntry = entry("上次约定每周三上午核对库存，暗号霜叶。", "a");
const secondEntry = entry("昨天把发票寄到乙客户，暗号青松。", "b");
const done = (): ScriptedTurn => ({ textChunks: ["已查阅。"], usage: { input: 800, output: 2 } });
const call = (query: string, id = "call-recall"): ScriptedTurn => ({
  textChunks: [],
  toolCall: { id, name: "recall_memory", args: { query } },
  usage: { input: 800, output: 30 },
});
const prompt = (runId: string, text: string, groupId = "group-1"): PromptMessage => ({
  type: "prompt",
  computer: null,
  runId: RunId.parse(runId),
  botId: BotId.parse("bot-1"),
  groupId: GroupId.parse(groupId),
  lane: { epoch: 3, heads: {} },
  messageId: MessageId.parse(`message-${runId}`),
  text,
  origin: { kind: "user" },
  reason: "solo",
  group: { id: GroupId.parse(groupId), number: "", title: groupId, kind: "solo" },
  context: [],
  purpose: "plan",
  routine: null,
  table: null,
  task: null,
  members: [{ id: BotId.parse("bot-1"), name: "小白", tags: [], description: "", seat: "member" }],
});
const messageBody = (request: ChatCompletionRequest): string => JSON.stringify(request.messages);
const tools = (request: ChatCompletionRequest) => request.messages.filter((message) => message.role === "tool");

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
  probe.sessions.splice(0);
  probe.recalls.splice(0);
});

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function harness(options: {
  readonly script: (req: ChatCompletionRequest, index: number) => ScriptedTurn;
  readonly recall?: (body: unknown, req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
  readonly settings?: RunnerConfig["settings"];
  readonly extensionTools?: readonly RunnerTool[];
}) {
  const requests: ChatCompletionRequest[] = [];
  const queries: Array<{ body: unknown; authorization: string | undefined; lane: string | undefined }> = [];
  const gateway = await startGateway({
    models: [{ id: "test-model" }],
    upstream: scriptedUpstream((req) => {
      requests.push(req);
      return options.script(req, requests.length - 1);
    }),
  });
  const server = createServer((req, res) => {
    void (async () => {
      const body = await bodyOf(req);
      if (req.method === "POST" && req.url === "/hub/v1/recall") {
        const parsed: unknown = JSON.parse(body);
        const lane = req.headers["x-baize-lane"];
        queries.push({
          body: parsed,
          authorization: req.headers.authorization,
          lane: typeof lane === "string" ? lane : undefined,
        });
        if (options.recall !== undefined) await options.recall(parsed, req, res);
        else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([firstEntry]));
        return;
      }
      if (req.method !== "POST" || req.url !== "/gateway/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      const response = await fetch(`${gateway.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: req.headers.authorization ?? "", "content-type": "application/json" },
        body,
      });
      res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" });
      const reader = response.body?.getReader();
      if (reader !== undefined) {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            res.write(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      res.end();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dataDir = mkdtempSync(join(tmpdir(), "baize-recall-"));
  const sent: AgentToControl[] = [];
  const appends: WorkAppend[] = [];
  const config: RunnerConfig = {
    computerId: ComputerId.parse("computer-1"),
    computerKind: "local",
    bots: [{ id: BotId.parse("bot-1"), role: "member", name: "小白", tags: [], description: "", preset: null }],
    tools: [],
    grants: [],
    accounts: [],
    brand: null,
    preferences: [],
    modelGateway: { baseUrl: `${base}/gateway/v1`, apiKey: "recall-test-key" },
    accountsProxy: { baseUrl: `${base}/accounts-proxy` },
    mcpProxy: { baseUrl: `${base}/mcp-proxy` },
    hub: { baseUrl: `${base}/hub/v1` },
    dataDir,
    send: (message) => sent.push(AgentToControl.parse(message)),
    workAppend: async (frame) => {
      appends.push(frame);
      return { kind: "ok" };
    },
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.extensionTools === undefined ? {} : { extensionTools: options.extensionTools }),
  };
  const runner = createRunner(config);
  cleanup.push(async () => {
    await runner.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    await gateway.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { runner, config, requests, queries, sent, appends, dataDir };
}

describe("recall_memory 现查现用", () => {
  it("本轮上游看见带出处的摘录，下一轮没有；JSONL和P3-11差分接入模拟上传只保留固定句", async () => {
    const h = await harness({ script: (_req, index) => (index === 0 ? call("  库存  ") : done()) });
    await h.runner.prompt(prompt("run-1", "查以前的库存安排"));
    await h.runner.prompt(prompt("run-2", "接着聊"));

    expect(h.queries).toEqual([
      { body: { query: "库存" }, authorization: "Bearer recall-test-key", lane: "bot-1/group-1/3" },
    ]);
    expect(h.requests).toHaveLength(3);
    for (const value of Object.values(firstEntry)) expect(messageBody(h.requests[1]!)).toContain(value);
    expect(messageBody(h.requests[2]!)).not.toContain(firstEntry.excerpt);
    expect(messageBody(h.requests[2]!)).not.toContain(firstEntry.groupTitle);
    expect(messageBody(h.requests[2]!)).toContain(recallPlaceholder(1));

    const session = probe.sessions[0]!;
    const file = readFileSync(session.sessionManager.getSessionFile()!, "utf8");
    expect(file).not.toContain(firstEntry.excerpt);
    expect(file).not.toContain(firstEntry.groupTitle);
    const recallResults = session.sessionManager
      .getEntries()
      .filter(
        (item) =>
          item.type === "message" && item.message.role === "toolResult" && item.message.toolName === "recall_memory",
      );
    expect(recallResults).toHaveLength(1);
    expect(recallResults[0]).toMatchObject({
      message: { content: [{ type: "text", text: recallPlaceholder(1) }], details: {} },
    });

    const retainer = createRetainer({ localOnlyToolNames: new Set() });
    const lines = session.sessionManager.getEntries().map((item) => {
      const raw = JSON.stringify(item);
      const retained = retainer.retain(raw);
      expect(retained.status).toBe("retained");
      if (retained.status !== "retained") throw new Error("会话行被留存规则拒收");
      expect(retained.line).toBe(raw);
      return retained.line;
    });
    const frame: WorkAppend = {
      type: "work_append",
      lane: { botId: BotId.parse("bot-1"), groupId: GroupId.parse("group-1"), epoch: 3, stream: "chat" },
      runId: RunId.parse("run-2"),
      fromSeq: 0,
      lines,
      head: await advanceWorkHead(EMPTY_WORK_HEAD, lines),
      cause: "settled",
    };
    await h.config.workAppend!(frame);
    expect(h.appends.at(-1)?.lines).toEqual(lines);
    expect(JSON.stringify(h.appends)).toContain(recallPlaceholder(1));
    expect(JSON.stringify(h.appends)).not.toContain(firstEntry.excerpt);
  });

  it("同轮两次召回条数相同也按callId分别展开，普通工具的同字占位不展开", async () => {
    const echo: RunnerTool = {
      name: "echo",
      label: "回占位",
      description: "测试普通工具",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: recallPlaceholder(1) }], details: {} }),
    };
    const h = await harness({
      extensionTools: [echo],
      script: (_req, index) =>
        index === 0
          ? call("甲", "call-a")
          : index === 1
            ? call("乙", "call-b")
            : index === 2
              ? { ...done(), textChunks: [], toolCall: { id: "call-echo", name: "echo", args: {} } }
              : done(),
      recall: (body, _req, res) => {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify([(body as { query: string }).query === "甲" ? firstEntry : secondEntry]));
      },
    });
    await h.runner.prompt(prompt("run-1", "分别查两条"));
    const results = tools(h.requests.at(-1)!);
    expect(results).toHaveLength(3);
    expect(JSON.stringify(results[0])).toContain(firstEntry.excerpt);
    expect(JSON.stringify(results[0])).not.toContain(secondEntry.excerpt);
    expect(JSON.stringify(results[1])).toContain(secondEntry.excerpt);
    expect(JSON.stringify(results[1])).not.toContain(firstEntry.excerpt);
    expect(JSON.stringify(results[2])).toContain(recallPlaceholder(1));
    expect(JSON.stringify(results[2])).not.toContain(firstEntry.excerpt);
  });

  it("下一轮复用callId只展开新结果，旧结果仍是固定句", async () => {
    const h = await harness({
      script: (_req, index) => (index === 0 ? call("甲") : index === 2 ? call("乙") : done()),
      recall: (body, _req, res) => {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify([(body as { query: string }).query === "甲" ? firstEntry : secondEntry]));
      },
    });
    await h.runner.prompt(prompt("run-1", "第一次"));
    await h.runner.prompt(prompt("run-2", "第二次"));
    const results = tools(h.requests.at(-1)!);
    expect(results).toHaveLength(2);
    expect(JSON.stringify(results[0])).toContain(recallPlaceholder(1));
    expect(JSON.stringify(results[0])).not.toContain(secondEntry.excerpt);
    expect(JSON.stringify(results[1])).toContain(secondEntry.excerpt);
    expect(messageBody(h.requests.at(-1)!)).not.toContain(firstEntry.excerpt);
  });

  it("同Bot的两个Lane并行召回、callId相同，结果不串群", async () => {
    const h = await harness({
      script: (req) =>
        req.messages.at(-1)?.role === "tool" ? done() : call(messageBody(req).includes("查甲") ? "甲" : "乙"),
      recall: (body, _req, res) => {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify([(body as { query: string }).query === "甲" ? firstEntry : secondEntry]));
      },
    });
    await Promise.all([
      h.runner.prompt(prompt("run-a", "查甲", "group-a")),
      h.runner.prompt(prompt("run-b", "查乙", "group-b")),
    ]);
    const follow = h.requests.filter((req) => req.messages.at(-1)?.role === "tool");
    expect(follow).toHaveLength(2);
    const a = follow.find((req) => messageBody(req).includes("查甲"))!;
    const b = follow.find((req) => messageBody(req).includes("查乙"))!;
    expect(messageBody(a)).toContain(firstEntry.excerpt);
    expect(messageBody(a)).not.toContain(secondEntry.excerpt);
    expect(messageBody(b)).toContain(secondEntry.excerpt);
    expect(messageBody(b)).not.toContain(firstEntry.excerpt);
    expect(h.queries.map((request) => request.lane).toSorted()).toEqual(["bot-1/group-a/3", "bot-1/group-b/3"]);
  });

  it("只读例行照常召回，不送审批", async () => {
    const h = await harness({ script: (_req, index) => (index === 0 ? call("库存") : done()) });
    const message = prompt("run-1", "只读核对");
    await h.runner.prompt({
      ...message,
      routine: { routineId: "routine-1" as NonNullable<PromptMessage["routine"]>["routineId"], boundary: "read_only" },
    });
    expect(h.queries).toHaveLength(1);
    expect(messageBody(h.requests[1]!)).toContain(firstEntry.excerpt);
    expect(h.sent.filter((frame) => frame.type === "approval_request")).toEqual([]);
  });

  it.each(["空查询", "错误响应", "HTTP拒绝"])("%s不会把结果留进下一轮", async (scenario) => {
    const h = await harness({
      script: (_req, index) => (index === 0 ? call(scenario === "空查询" ? "   " : "库存") : done()),
      recall: (_body, _req, res) => {
        res
          .writeHead(scenario === "HTTP拒绝" ? 403 : 200, { "content-type": "application/json" })
          .end(JSON.stringify({ excerpt: firstEntry.excerpt }));
      },
    });
    await h.runner.prompt(prompt("run-1", "试查询"));
    await h.runner.prompt(prompt("run-2", "接着聊"));
    expect(h.queries).toHaveLength(scenario === "空查询" ? 0 : 1);
    expect(messageBody(h.requests.at(-1)!)).not.toContain(firstEntry.excerpt);
    expect(readFileSync(probe.sessions[0]!.sessionManager.getSessionFile()!, "utf8")).not.toContain(firstEntry.excerpt);
    expect(JSON.stringify(tools(h.requests[1]!))).toMatch(/查询词不能为空|召回结果格式不对|拒绝了这次召回/);
  });

  it.each(["取消", "停机"])("%s清空已召回的Lane结果，不继续请求模型", async (action) => {
    let entered!: () => void;
    const holding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold: RunnerTool = {
      name: "hold",
      label: "等待取消",
      description: "测试取消清理",
      parameters: Type.Object({}),
      execute: async (_callId, _raw, signal) => {
        entered();
        if (signal === undefined) throw new Error("工具没有取消信号");
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("工具被取消");
      },
    };
    const h = await harness({
      extensionTools: [hold],
      script: (_req, index) =>
        index === 0
          ? call("库存")
          : index === 1
            ? { ...done(), textChunks: [], toolCall: { id: "call-hold", name: "hold", args: {} } }
            : done(),
    });
    const running = h.runner.prompt(prompt("run-1", "查库存再等待"));
    await holding;
    expect(probe.recalls[0]?.size, "工具已经查成功，确实存在要清理的摘录").toBe(1);
    expect(messageBody(h.requests[1]!)).toContain(firstEntry.excerpt);
    if (action === "取消") h.runner.cancel(RunId.parse("run-1"));
    else await h.runner.stop();
    await running;
    expect(probe.recalls[0]?.size).toBe(0);
    expect(h.requests).toHaveLength(2);
    if (action === "取消") {
      await h.runner.prompt(prompt("run-2", "下一轮"));
      expect(messageBody(h.requests.at(-1)!)).not.toContain(firstEntry.excerpt);
    }
  });

  it("recall请求被取消后不接受迟到响应，下一轮没有摘录", async () => {
    let reached!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await harness({
      script: (_req, index) => (index === 0 ? call("库存") : done()),
      recall: async (_body, _req, res) => {
        reached();
        await delayed;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([firstEntry]));
      },
    });
    const running = h.runner.prompt(prompt("run-1", "查询尚未返回"));
    await arrived;
    h.runner.cancel(RunId.parse("run-1"));
    await running;
    release();
    await h.runner.prompt(prompt("run-2", "下一轮"));
    expect(probe.recalls[0]?.size).toBe(0);
    expect(messageBody(h.requests.at(-1)!)).not.toContain(firstEntry.excerpt);
    expect(readFileSync(probe.sessions[0]!.sessionManager.getSessionFile()!, "utf8")).not.toContain(firstEntry.excerpt);
  });

  it("recall后同run触发Pi原生自动压缩，真实压缩请求只有占位没有摘录", async () => {
    const h = await harness({
      settings: { compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 1 } },
      script: (_req, index) =>
        index === 0 ? call("库存") : index === 1 ? { ...done(), usage: { input: 120000, output: 2 } } : done(),
    });
    await h.runner.prompt(prompt("run-1", "查库存再压缩"));
    const session = probe.sessions[0]!;
    expect(
      session.sessionManager.getBranch().some((item) => item.type === "compaction"),
      "确实由Pi响应后的用量触发压缩",
    ).toBe(true);
    expect(messageBody(h.requests[1]!)).toContain(firstEntry.excerpt);
    const compression = h.requests.slice(2).filter((req) => messageBody(req).includes(recallPlaceholder(1)));
    expect(compression.length, "真正压缩的上游请求带会话里的固定句").toBeGreaterThan(0);
    for (const req of h.requests.slice(2)) {
      expect(messageBody(req)).not.toContain(firstEntry.excerpt);
      expect(messageBody(req)).not.toContain(firstEntry.groupTitle);
    }
    expect(readFileSync(session.sessionManager.getSessionFile()!, "utf8")).not.toContain(firstEntry.excerpt);
  });
});
