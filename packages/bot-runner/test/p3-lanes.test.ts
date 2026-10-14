import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  AgentToControl,
  BotId,
  ComputerId,
  GroupId,
  GrantId,
  MessageId,
  McpProxyCallRequest,
  RunId,
  DraftId,
  AccountId,
  PokerHandId,
  PokerSessionId,
  type ToolConnectionConfig,
} from "@baize/shared";
import { Client } from "@modelcontextprotocol/sdk/client";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRunner,
  publishDraft,
  type PromptMessage,
  type Runner,
  type RunnerConfig,
  type RunnerTool,
} from "../src/index.js";
import type { CdpConnection } from "../src/cdp.js";
import * as lanes from "../src/lane.js";
import { createLane, findLaneRun } from "../src/lane.js";
import { LaneFence } from "../src/lane-fence.js";
import { downloadAttachment } from "../src/attachments.js";
import { startAttachmentHub } from "./helpers/attachments.js";
import { acquireBotBrowserMutex, BrowserMutex } from "../src/browser-mutex.js";
import { startGateway } from "./fixtures/gateway.js";
import { isFollowUpTurn, scriptedUpstream, type ScriptedTurn, type Upstream } from "./fixtures/openai-sse.js";
import { startFakeMcp } from "./helpers/mcp.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const finish: ScriptedTurn = { textChunks: ["完成"], usage: { input: 10, output: 5 } };
const call = (name: string, args: Record<string, unknown> = {}): ScriptedTurn => ({
  textChunks: [],
  toolCall: { id: "same-call", name, args },
  usage: { input: 10, output: 5 },
});

const prompt = (runId: string, groupId = "group-a"): PromptMessage => ({
  type: "prompt",
  runId: RunId.parse(runId),
  botId: BotId.parse("bot-lanes"),
  groupId: GroupId.parse(groupId),
  lane: { epoch: 1, heads: {} },
  messageId: MessageId.parse(`message-${runId}`),
  text: runId,
  origin: { kind: "user" },
  reason: "solo",
  group: { id: GroupId.parse(groupId), title: groupId, number: "", kind: "solo" },
  context: [],
  members: [{ id: BotId.parse("bot-lanes"), name: "分道助理", tags: [], description: "", seat: "member" }],
  task: null,
  routine: null,
  table: null,
  purpose: "plan",
});

const connection = (url: string, name = "send_email", needsApproval = true): ToolConnectionConfig => ({
  id: "connection-lanes" as ToolConnectionConfig["id"],
  ownerId: "owner-lanes" as ToolConnectionConfig["ownerId"],
  name: "分道工具",
  url,
  authorization: null,
  localOnly: true,
  status: "ready",
  assignedBotIds: [BotId.parse("bot-lanes")],
  operations: [{ name, description: "测试工具", needsApproval, inputSchema: { type: "object" } }],
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  vi.restoreAllMocks();
});

async function harness(upstream: Upstream, overrides: Partial<RunnerConfig> = {}) {
  const gateway = await startGateway({ upstream, models: [{ id: "test-lanes" }] });
  const dataDir = mkdtempSync(join(tmpdir(), "baize-p3-lanes-"));
  const sent: AgentToControl[] = [];
  const waiters = new Set<{ matches: (message: AgentToControl) => boolean; resolve: () => void }>();
  const config: RunnerConfig = {
    computerId: ComputerId.parse("computer-lanes"),
    bots: [{ id: BotId.parse("bot-lanes"), name: "分道助理", role: "member", preset: null, tags: [], description: "" }],
    tools: [],
    accounts: [],
    grants: [],
    brand: null,
    preferences: [],
    modelGateway: { baseUrl: gateway.baseUrl, apiKey: "fake-lanes-key" },
    accountsProxy: { baseUrl: "http://127.0.0.1:9" },
    mcpProxy: { baseUrl: "http://127.0.0.1:9/mcp-proxy" },
    hub: { baseUrl: "http://127.0.0.1:9/hub/v1" },
    workAppend: async () => ({ kind: "ok" }),
    dataDir,
    ...overrides,
    send: (message) => {
      sent.push(AgentToControl.parse(message));
      for (const waiter of waiters) {
        if (!waiter.matches(message)) continue;
        waiters.delete(waiter);
        waiter.resolve();
      }
    },
  };
  const runner = createRunner(config);
  cleanups.push(async () => {
    await runner.stop();
    await gateway.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    runner,
    config,
    sent,
    gateway,
    dataDir,
    waitFor(matches: (message: AgentToControl) => boolean): Promise<void> {
      if (sent.some(matches)) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.add({ matches, resolve }));
    },
  };
}

const doneIds = (sent: readonly AgentToControl[]) =>
  sent.filter((message) => message.type === "run_done").map((message) => message.runId);

const publishMessage = {
  type: "publish_draft" as const,
  draftId: DraftId.parse("draft-approval-lock"),
  botId: BotId.parse("bot-lanes"),
  accountId: AccountId.parse("account-approval-lock"),
  platform: "xiaohongshu" as const,
  attempt: "2026-10-14T00:00:00.000Z",
  content: { kind: "post" as const, github: null, title: "锁", text: "锁", images: [] },
};

function fakeBrowser() {
  let url = "about:blank";
  const effects: string[] = [];
  const cdp: CdpConnection = {
    isOpen: () => true,
    onEvent: () => () => {},
    send: async (method, params) => {
      if (method === "Target.createTarget") return { targetId: "target" };
      if (method === "Target.attachToTarget") return { sessionId: "session" };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
      if (method === "Page.navigate") url = String(params?.url);
      if (method === "Runtime.evaluate") {
        const expression = String(params?.expression);
        const value =
          expression === "location.href"
            ? url
            : expression === "document.readyState"
              ? "complete"
              : expression.includes("getBoundingClientRect")
                ? { x: 10, y: 20 }
                : "测试页";
        return { result: { value } };
      }
      if (method.startsWith("Input.")) effects.push(method);
      return {};
    },
  };
  return { cdp, effects };
}

function fakePublishing(dataDir: string) {
  const bytes = Buffer.from("fake-publish-image");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const image = join(dataDir, "bot-lanes", "drafts", `${sha256}.png`);
  mkdirSync(join(dataDir, "bot-lanes", "drafts"), { recursive: true });
  writeFileSync(image, bytes);
  let url = "about:blank";
  let clicks = 0;
  const uploads: unknown[] = [];
  const cdp: CdpConnection = {
    isOpen: () => true,
    onEvent: () => () => {},
    send: async (method, params) => {
      if (method === "Target.createTarget") return { targetId: "publisher-target" };
      if (method === "Target.attachToTarget") return { sessionId: "publisher-session" };
      if (method === "Page.navigate") url = String(params?.url);
      if (method === "DOM.setFileInputFiles") uploads.push(params?.files);
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
        clicks += 1;
        if (clicks === 2) url = "https://creator.xiaohongshu.com/done";
      }
      if (method === "Runtime.evaluate") {
        const expression = String(params?.expression);
        if (params?.returnByValue === false) return { result: { objectId: "fake-upload-input" } };
        const value =
          expression === "location.href"
            ? url
            : expression.includes("getBoundingClientRect")
              ? { x: 10, y: 20 }
              : expression.includes("document.activeElement")
                ? true
                : expression.endsWith(".length")
                  ? 1
                  : [{ text: "锁", attribute: '{"noteId":"1234567890abcdef12345678"}', links: [] }];
        return { result: { value } };
      }
      return {};
    },
  };
  return {
    message: {
      ...publishMessage,
      content: { ...publishMessage.content, images: [{ kind: "path" as const, path: image, sha256 }] },
    },
    browser: { connection: async () => cdp },
    cdp,
    uploads,
  };
}

const sessionResults = (dataDir: string, groupId: string) => {
  const directory = join(dataDir, "bot-lanes", "sessions", groupId);
  return readdirSync(directory)
    .filter((file) => file.endsWith(".jsonl"))
    .flatMap((file) =>
      readFileSync(join(directory, file), "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              message?: { role?: string; isError?: boolean; content?: unknown };
            },
        ),
    )
    .filter((entry) => entry.message?.role === "toolResult")
    .map((entry) => entry.message);
};

describe("P3-9 群道", () => {
  it("同一个 Bot 的 A 群模型挂住时 B 群仍完成，各发一次 run_done", async () => {
    const started = deferred();
    const release = deferred();
    const upstream = scriptedUpstream(() => finish);
    const h = await harness(async function* (request, key) {
      if (JSON.stringify(request.messages).includes("run-a")) {
        started.resolve();
        await release.promise;
      }
      yield* upstream(request, key);
    });
    const a = h.runner.prompt(prompt("run-a"));
    try {
      await started.promise;
      await h.runner.prompt(prompt("run-b", "group-b"));
      expect(doneIds(h.sent)).toEqual(["run-b"]);
      expect(h.runner.activeRuns()).toEqual(["run-a"]);
    } finally {
      release.resolve();
    }
    await a;
    expect(doneIds(h.sent)).toEqual(["run-b", "run-a"]);
  });

  it("同一群的第二条模型请求在第一条 run_done 之后才发出", async () => {
    const started = deferred();
    const release = deferred();
    let runner: Runner;
    let sent: readonly AgentToControl[] = [];
    const requests: string[] = [];
    const upstream = scriptedUpstream(() => finish);
    const h = await harness(async function* (request, key) {
      const second = JSON.stringify(request.messages).includes("run-second");
      requests.push(second ? "second" : "first");
      if (second) expect(doneIds(sent)).toContain("run-first");
      else {
        started.resolve();
        await release.promise;
      }
      yield* upstream(request, key);
    });
    runner = h.runner;
    sent = h.sent;
    const first = runner.prompt(prompt("run-first"));
    await started.promise;
    const second = runner.prompt(prompt("run-second"));
    expect(requests).toEqual(["first"]);
    release.resolve();
    await Promise.all([first, second]);
    expect(requests).toEqual(["first", "second"]);
    expect(doneIds(h.sent)).toEqual(["run-first", "run-second"]);
  });

  it.each(["approved", "voided"] as const)("两条道使用相同 callId 的审批各自结算，%s 只影响对应道", async (outcome) => {
    const mcp = await startFakeMcp();
    cleanups.push(() => mcp.close());
    const h = await harness(
      scriptedUpstream((request) =>
        isFollowUpTurn(request) ? finish : call("send_email", { to: "客户", subject: "分道审批" }),
      ),
      { tools: [connection(mcp.url)] },
    );
    const a = h.runner.prompt(prompt("approval-a"));
    const b = h.runner.prompt(prompt("approval-b", "group-b"));
    await Promise.all([
      h.waitFor((message) => message.type === "approval_request" && message.runId === "approval-a"),
      h.waitFor((message) => message.type === "approval_request" && message.runId === "approval-b"),
    ]);
    const approvals = h.sent.filter((message) => message.type === "approval_request");
    expect(approvals.map((message) => message.callId)).toEqual(["same-call", "same-call"]);
    h.runner.approve(RunId.parse("approval-a"), "same-call", outcome);
    await a;
    expect(doneIds(h.sent)).toEqual(["approval-a"]);
    expect(mcp.calls).toHaveLength(outcome === "approved" ? 1 : 0);
    h.runner.approve(RunId.parse("approval-b"), "same-call", "rejected");
    await b;
    expect(mcp.calls).toHaveLength(outcome === "approved" ? 1 : 0);
    expect(h.sent.filter((message) => message.type === "bot_tool_call" && message.status !== "running")).toEqual([
      expect.objectContaining({ runId: "approval-a", status: outcome === "approved" ? "ok" : "blocked" }),
      expect.objectContaining({ runId: "approval-b", status: "blocked" }),
    ]);
  });

  it("config 不等道：旧 run 的撤销实时生效，新 run 移除工具，最后一个旧 run 后关闭 MCP", async () => {
    const mcp = await startFakeMcp();
    cleanups.push(() => mcp.close());
    const close = vi.spyOn(Client.prototype, "close");
    const started = { a: deferred(), b: deferred() };
    const release = { a: deferred(), b: deferred() };
    const seen: Array<{ run: string; tools: string[] }> = [];
    const scripted = scriptedUpstream((request) =>
      isFollowUpTurn(request) ? finish : call("lookup_stock", { sku: "SKU-LANES" }),
    );
    const h = await harness(
      async function* (request, key) {
        const body = JSON.stringify(request.messages);
        const tools = (request.tools ?? []).map((tool) => tool.function.name);
        if (body.includes("generation-new")) {
          seen.push({ run: "new", tools });
          yield* scriptedUpstream(() => finish)(request, key);
          return;
        }
        const lane = body.includes("generation-a") ? "a" : "b";
        const turns = request.messages.filter((message) => message.role === "tool").length;
        if (turns === 1) {
          seen.push({ run: lane, tools });
          started[lane].resolve();
          await release[lane].promise;
        }
        yield* (turns === 1 ? scriptedUpstream(() => call("lookup_stock", { sku: "SKU-WITHDRAWN" })) : scripted)(
          request,
          key,
        );
      },
      { tools: [connection(mcp.url, "lookup_stock", false)] },
    );
    const a = h.runner.prompt(prompt("generation-a"));
    const b = h.runner.prompt(prompt("generation-b", "group-b"));
    try {
      await Promise.all([started.a.promise, started.b.promise]);
      await h.runner.applyConfig({ ...h.config, tools: [] });
      expect(doneIds(h.sent)).toEqual([]);
      await h.runner.prompt(prompt("generation-new-c", "group-c"));
      expect(seen.find((entry) => entry.run === "new")?.tools).not.toContain("lookup_stock");
      expect(close).not.toHaveBeenCalled();
      release.a.resolve();
      await a;
      expect(mcp.calls).toHaveLength(2);
      expect(close).not.toHaveBeenCalled();
      await h.runner.prompt(prompt("generation-new-a"));
      expect(seen.filter((entry) => entry.run === "new").every((entry) => !entry.tools.includes("lookup_stock"))).toBe(
        true,
      );
      release.b.resolve();
      await b;
      expect(mcp.calls).toHaveLength(2);
      expect(mcp.connections).toBe(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(seen.filter((entry) => entry.run !== "new").every((entry) => entry.tools.includes("lookup_stock"))).toBe(
        true,
      );
      expect(new Set(doneIds(h.sent)).size).toBe(4);
    } finally {
      release.a.resolve();
      release.b.resolve();
      await Promise.all([a, b]);
    }
  });

  it("按 runId 查找同时识别正在跑的道和同道排队的 prompt，丢弃排队项不执行它", async () => {
    const lane = createLane(GroupId.parse("group-a"));
    const release = deferred();
    const first = lane.queue.enqueue(prompt("lookup-active"), () => release.promise);
    const executed = vi.fn(async () => {});
    const second = lane.queue.enqueue(prompt("lookup-queued"), executed);
    await Promise.resolve();
    expect(findLaneRun([lane], RunId.parse("lookup-active"))).toMatchObject({ lane, phase: "running" });
    expect(findLaneRun([lane], RunId.parse("lookup-queued"))).toMatchObject({ lane, phase: "queued" });
    lane.queue.discard((message) => message.runId === "lookup-queued");
    expect(findLaneRun([lane], RunId.parse("lookup-queued"))).toBeNull();
    release.resolve();
    await Promise.all([first, second]);
    expect(executed).not.toHaveBeenCalled();
  });

  it("暂停一停全停：两条道的下一次 tool_call 都等 resume，prompt 不重发", async () => {
    const arrived = { a: deferred(), b: deferred() };
    const release = deferred();
    const executed: string[] = [];
    const tool: RunnerTool = {
      name: "lane_work",
      label: "记录道",
      description: "记录测试工具的执行",
      parameters: Type.Object({ lane: Type.String() }),
      execute: async (_id, input) => {
        executed.push((input as { lane: string }).lane);
        return { content: [{ type: "text", text: "已记录" }], details: {} };
      },
    };
    let initialRequests = 0;
    const h = await harness(
      async function* (request, key) {
        const lane = JSON.stringify(request.messages).includes("pause-a") ? "a" : "b";
        const first = !isFollowUpTurn(request);
        if (first) {
          initialRequests += 1;
          arrived[lane].resolve();
          await release.promise;
        }
        yield* scriptedUpstream(() => (first ? call(tool.name, { lane }) : finish))(request, key);
      },
      { extensionTools: [tool] },
    );
    const a = h.runner.prompt(prompt("pause-a"));
    const b = h.runner.prompt(prompt("pause-b", "group-b"));
    try {
      await Promise.all([arrived.a.promise, arrived.b.promise]);
      await h.runner.pause(BotId.parse("bot-lanes"));
      release.resolve();
      await Promise.all(
        ["pause-a", "pause-b"].map((runId) =>
          h.waitFor(
            (message) => message.type === "bot_tool_call" && message.status === "running" && message.runId === runId,
          ),
        ),
      );
      expect(executed).toEqual([]);
      expect(doneIds(h.sent)).toEqual([]);
      await h.runner.resume(BotId.parse("bot-lanes"));
      await Promise.all([a, b]);
      expect(executed.toSorted()).toEqual(["a", "b"]);
      expect(initialRequests).toBe(2);
      expect(doneIds(h.sent).toSorted()).toEqual(["pause-a", "pause-b"]);
    } finally {
      release.resolve();
      await h.runner.resume(BotId.parse("bot-lanes"));
      await Promise.all([a, b]);
    }
  });

  it("牌桌道和普通道共用暂停闸门，恢复后两边都完成", async () => {
    const arrived = { chat: deferred(), table: deferred() };
    const emitted = { chat: deferred(), table: deferred() };
    const release = deferred();
    const executed: string[] = [];
    const tool: RunnerTool = {
      name: "lane_work",
      label: "记录道",
      description: "测试普通道",
      parameters: Type.Object({}),
      execute: async () => {
        executed.push("chat");
        return { content: [{ type: "text", text: "完成" }], details: {} };
      },
    };
    let initialRequests = 0;
    const h = await harness(
      async function* (request, key) {
        const lane = request.tools?.some((registered) => registered.function.name === "poker_review")
          ? "table"
          : "chat";
        const first = !isFollowUpTurn(request);
        if (first) {
          initialRequests += 1;
          arrived[lane].resolve();
          await release.promise;
        }
        yield* scriptedUpstream(() =>
          first ? call(lane === "table" ? "poker_review" : tool.name, lane === "table" ? { hands: [] } : {}) : finish,
        )(request, key);
        emitted[lane].resolve();
      },
      { extensionTools: [tool] },
    );
    const table = h.runner.prompt({
      ...prompt("pause-table", "group-table"),
      origin: { kind: "table" },
      table: {
        role: "reviewer",
        sessionId: PokerSessionId.parse("session-pause"),
        handId: PokerHandId.parse("hand-pause"),
        seq: 0,
        view: null,
        publicLog: [],
        question: null,
        review: [],
      },
    });
    const chat = h.runner.prompt(prompt("pause-chat"));
    try {
      await Promise.all([arrived.chat.promise, arrived.table.promise]);
      await h.runner.pause(BotId.parse("bot-lanes"));
      release.resolve();
      await Promise.all([emitted.chat.promise, emitted.table.promise]);
      await h.waitFor((message) => message.type === "bot_tool_call" && message.status === "running");
      expect(executed).toEqual([]);
      expect(h.sent.filter((message) => message.type === "poker_review")).toEqual([]);
      expect(doneIds(h.sent)).toEqual([]);
      await h.runner.resume(BotId.parse("bot-lanes"));
      await Promise.all([chat, table]);
      expect(executed).toEqual(["chat"]);
      expect(h.sent.filter((message) => message.type === "poker_review")).toHaveLength(1);
      expect(doneIds(h.sent).toSorted()).toEqual(["pause-chat", "pause-table"]);
      expect(initialRequests).toBe(2);
    } finally {
      release.resolve();
      await h.runner.resume(BotId.parse("bot-lanes"));
      await Promise.all([chat, table]);
    }
  });

  it("两条道的浏览器工具互斥，发布器也等同一个 Bot 的浏览器操作结束", async () => {
    const started = deferred();
    const release = deferred();
    const events: string[] = [];
    let url = "about:blank";
    const cdp: CdpConnection = {
      isOpen: () => true,
      onEvent: () => () => {},
      send: async (method, params) => {
        if (method === "Target.createTarget") return { targetId: "target" };
        if (method === "Target.attachToTarget") return { sessionId: "session" };
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
        if (method === "Page.navigate") {
          url = String(params?.url);
          events.push(`start:${url}`);
          if (url.endsWith("/a")) {
            started.resolve();
            await release.promise;
          }
        }
        if (method === "Runtime.evaluate") {
          if (params?.expression === "location.href") return { result: { value: url } };
          if (params?.expression === "document.title") {
            events.push(`end:${url}`);
            return { result: { value: "测试页" } };
          }
        }
        return {};
      },
    };
    const h = await harness(
      scriptedUpstream((request) => {
        const body = JSON.stringify(request.messages);
        if (body.includes("browser-barrier") || isFollowUpTurn(request)) return finish;
        return call("browser_open", {
          url: body.includes("browser-a") ? "https://example.com/a" : "https://example.com/b",
        });
      }),
      { browser: { profileDir: join(tmpdir(), "baize-lane-browser-profile"), connection: async () => cdp } },
    );
    const a = h.runner.prompt(prompt("browser-a"));
    try {
      await started.promise;
      const b = h.runner.prompt(prompt("browser-b", "group-b"));
      await h.waitFor((message) => message.type === "bot_tool_call" && message.runId === "browser-b");
      let published = false;
      const publishing = publishDraft(
        {
          type: "publish_draft",
          draftId: DraftId.parse("draft-mutex"),
          botId: BotId.parse("bot-lanes"),
          accountId: AccountId.parse("account-mutex"),
          platform: "xiaohongshu",
          attempt: "2026-10-14T00:00:00.000Z",
          content: { kind: "post", github: null, title: "锁", text: "锁", images: [] },
        },
        { dataDir: h.config.dataDir, browser: h.config.browser! },
      ).then((result) => {
        published = true;
        return result;
      });
      await h.runner.prompt(prompt("browser-barrier", "group-c"));
      expect(events).toEqual(["start:https://example.com/a"]);
      expect(published).toBe(false);
      release.resolve();
      await Promise.all([a, b]);
      expect((await publishing).result.status).toBe("failed");
      expect(events).toEqual([
        "start:https://example.com/a",
        "end:https://example.com/a",
        "start:https://example.com/b",
        "end:https://example.com/b",
      ]);
    } finally {
      release.resolve();
      await a;
    }
  });

  it.each(["delete", "stop"] as const)("%s 停道先作废审批再收尾 run，排队 prompt 不再运行", async (action) => {
    const mcp = await startFakeMcp();
    cleanups.push(() => mcp.close());
    let requests = 0;
    const h = await harness(
      scriptedUpstream((request) => {
        requests += 1;
        return isFollowUpTurn(request) ? finish : call("send_email", { to: "客户", subject: "停道" });
      }),
      { tools: [connection(mcp.url)] },
    );
    const disposedAfterDrop: boolean[] = [];
    const dispose = AgentSession.prototype.dispose;
    vi.spyOn(AgentSession.prototype, "dispose").mockImplementation(function (this: AgentSession) {
      disposedAfterDrop.push(doneIds(h.sent).includes(RunId.parse("stop-queued")));
      return dispose.call(this);
    });
    const running = h.runner.prompt(prompt("stop-running"));
    await h.waitFor((message) => message.type === "approval_request");
    const queued = h.runner.prompt(prompt("stop-queued"));
    if (action === "delete") await h.runner.applyConfig({ ...h.config, bots: [] });
    else await h.runner.stop();
    await Promise.all([running, queued]);
    const expired = h.sent.findIndex(
      (message) => message.type === "approval_abandoned" && message.runId === "stop-running",
    );
    const done = h.sent.findIndex((message) => message.type === "run_done" && message.runId === "stop-running");
    expect(expired).toBeGreaterThanOrEqual(0);
    expect(done).toBeGreaterThan(expired);
    expect(doneIds(h.sent)).toEqual(["stop-running", "stop-queued"]);
    expect(h.sent.find((message) => message.type === "run_done" && message.runId === "stop-queued")).toMatchObject({
      prompt: "dropped",
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(requests).toBe(1);
    expect(mcp.calls).toEqual([]);
    expect(h.runner.activeRuns()).toEqual([]);
    await h.runner.stop();
    expect(disposedAfterDrop).toEqual([true]);
  });

  it("另一条道切页期间点击先等浏览器锁，再按新域名送审批", async () => {
    const navigating = deferred();
    const release = deferred();
    let url = "about:blank";
    const effects: string[] = [];
    const cdp: CdpConnection = {
      isOpen: () => true,
      onEvent: () => () => {},
      send: async (method, params) => {
        if (method === "Target.createTarget") return { targetId: "target" };
        if (method === "Target.attachToTarget") return { sessionId: "session" };
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
        if (method === "Page.navigate") {
          url = String(params?.url);
          if (url.includes("new.example")) {
            navigating.resolve();
            await release.promise;
          }
        }
        if (method === "Runtime.evaluate")
          return { result: { value: params?.expression === "location.href" ? url : "测试页" } };
        if (method.startsWith("Input.")) effects.push(method);
        return {};
      },
    };
    const h = await harness(
      scriptedUpstream((request) => {
        if (isFollowUpTurn(request)) return finish;
        const body = JSON.stringify(request.messages);
        if (body.includes("host-click")) return call("browser_click", { ref: 1 });
        return call("browser_open", {
          url: body.includes("host-warm") ? "https://old.example" : "https://new.example",
        });
      }),
      {
        browser: { profileDir: join(tmpdir(), "baize-lane-host-profile"), connection: async () => cdp },
        grants: [
          {
            id: GrantId.parse("grant-old-host"),
            scope: "forever",
            action: "engage",
            target: { kind: "domain", domain: "old.example" },
            createdAt: "2026-10-14T00:00:00.000Z",
          },
        ],
      },
    );
    await h.runner.prompt(prompt("host-warm", "group-warm"));
    const a = h.runner.prompt(prompt("host-open"));
    try {
      await navigating.promise;
      const b = h.runner.prompt(prompt("host-click", "group-b"));
      await h.waitFor((message) => message.type === "bot_tool_call" && message.runId === "host-click");
      expect(h.sent.filter((message) => message.type === "approval_request")).toEqual([]);
      release.resolve();
      await h.waitFor((message) => message.type === "approval_request");
      const approval = h.sent.find((message) => message.type === "approval_request");
      expect(approval).toMatchObject({ runId: "host-click", target: { kind: "domain", domain: "new.example" } });
      expect(effects).toEqual([]);
      h.runner.approve(RunId.parse("host-click"), "same-call", "rejected");
      await Promise.all([a, b]);
      expect(effects).toEqual([]);
    } finally {
      release.resolve();
      await h.runner.stop();
      await a;
    }
  });
  it.each(["same", "changed"] as const)(
    "审批等待不占浏览器锁，批准后页面 %s 时重新判断",
    async (page) => {
      const browser = fakeBrowser();
      const h = await harness(
        scriptedUpstream((request) => {
          if (isFollowUpTurn(request)) return finish;
          const body = JSON.stringify(request.messages);
          if (body.includes("approval-click")) return call("browser_click", { ref: 1 });
          return call("browser_open", {
            url: body.includes("approval-warm") || page === "same" ? "https://old.example/" : "https://new.example/",
          });
        }),
        { browser: { profileDir: join(tmpdir(), "baize-approval-profile"), connection: async () => browser.cdp } },
      );
      await h.runner.prompt(prompt("approval-warm", "group-warm"));
      const a = h.runner.prompt(prompt("approval-click"));
      try {
        await h.waitFor((message) => message.type === "approval_request");
        const publishing = fakePublishing(h.config.dataDir);
        const before = Date.now();
        await Promise.all([
          h.runner.prompt(prompt("approval-open", "group-b")),
          publishDraft(publishing.message, { dataDir: h.config.dataDir, browser: publishing.browser }).then(
            (result) => {
              expect(result.result).toMatchObject({ status: "ok", externalId: "1234567890abcdef12345678" });
              expect(publishing.uploads).toHaveLength(1);
            },
          ),
        ]);
        expect(Date.now() - before).toBeLessThan(1000);
        expect(doneIds(h.sent)).toContain("approval-open");
        expect(doneIds(h.sent)).not.toContain("approval-click");
        expect(browser.effects).toEqual([]);
        h.runner.approve(RunId.parse("approval-click"), "same-call", "approved");
        await a;
        const results = sessionResults(h.config.dataDir, "group-a");
        if (page === "changed") {
          expect(JSON.stringify(results)).toContain("页面已经变了，刚才的批准不适用，请重新操作");
          expect(results.some((result) => result?.isError === true)).toBe(true);
          expect(browser.effects).toEqual([]);
        } else {
          expect(browser.effects).toEqual([
            "Input.dispatchMouseEvent",
            "Input.dispatchMouseEvent",
            "Input.dispatchMouseEvent",
          ]);
          expect(results.some((result) => result?.isError === true)).toBe(false);
        }
      } finally {
        await h.runner.stop();
        await a;
      }
    },
    5000,
  );

  it.each(["尚未建会话", "已建会话"] as const)(
    "%s 的 Bot 暂停时收到 publish_draft 立即失败，恢复不会补发",
    async (phase) => {
      const browser = fakeBrowser();
      const h = await harness(
        scriptedUpstream(() => finish),
        {
          browser: { profileDir: join(tmpdir(), "baize-publish-pause"), connection: async () => browser.cdp },
        },
      );
      if (phase === "已建会话") await h.runner.prompt(prompt("publisher-warm"));
      const publishing = fakePublishing(h.config.dataDir);
      const connect = vi.spyOn(publishing.browser, "connection");
      const send = vi.spyOn(publishing.cdp, "send");
      await h.runner.pause(BotId.parse("bot-lanes"));
      const pending = publishDraft(publishing.message, { dataDir: h.config.dataDir, browser: publishing.browser });
      try {
        // 下一轮事件循环是屏障：入场拒绝只走微任务，不应等待 resume 或浏览器。
        const result = await Promise.race([pending, nextTurn().then(() => null)]);
        expect(result?.result).toEqual({
          status: "failed",
          reason: "error",
          detail: "Bot 已暂停，这条没发出去，请让 Bot 再起一稿。",
        });
        expect(connect).toHaveBeenCalledTimes(0);
        expect(send).toHaveBeenCalledTimes(0);
        await h.runner.resume(BotId.parse("bot-lanes"));
        expect((await pending).result).toEqual(result?.result);
        expect(connect).toHaveBeenCalledTimes(0);
        expect(send).toHaveBeenCalledTimes(0);
      } finally {
        await h.runner.stop();
        await pending;
      }
    },
  );

  it("Bot 未暂停时 publish_draft 照常发布", async () => {
    const browser = fakeBrowser();
    const h = await harness(
      scriptedUpstream(() => finish),
      {
        browser: { profileDir: join(tmpdir(), "baize-publish-running"), connection: async () => browser.cdp },
      },
    );
    const publishing = fakePublishing(h.config.dataDir);
    const result = await publishDraft(publishing.message, { dataDir: h.config.dataDir, browser: publishing.browser });
    expect(result.result).toEqual({
      status: "ok",
      url: "https://www.xiaohongshu.com/explore/1234567890abcdef12345678",
      externalId: "1234567890abcdef12345678",
    });
    expect(publishing.uploads).toHaveLength(1);
  });

  it("撤下 Bot 后在资源对账开始前加回，后续浏览器工具仍能执行", async () => {
    const browser = fakeBrowser();
    const h = await harness(
      scriptedUpstream((request) =>
        isFollowUpTurn(request) ? finish : call("browser_open", { url: "https://restored.example" }),
      ),
      { browser: { profileDir: join(tmpdir(), "baize-browser-restored"), connection: async () => browser.cdp } },
    );
    await h.runner.prompt(prompt("restored-warm"));
    const deleting = h.runner.applyConfig({ ...h.config, bots: [] });
    const restoring = h.runner.applyConfig(h.config);
    await Promise.all([deleting, restoring]);
    await h.runner.prompt(prompt("restored-open", "group-restored"));
    expect(h.sent).toContainEqual(
      expect.objectContaining({ type: "bot_tool_call", runId: "restored-open", status: "ok" }),
    );
    expect(doneIds(h.sent)).toEqual(["restored-warm", "restored-open"]);
  });

  it.each(["pause", "stop", "delete"] as const)(
    "发布器 B 已排在不可中止的发布器 A 后，%s 时不会开始 B 的发布",
    async (action) => {
      const browser = fakeBrowser();
      const h = await harness(
        scriptedUpstream(() => finish),
        {
          browser: { profileDir: join(tmpdir(), "baize-publish-queued"), connection: async () => browser.cdp },
        },
      );
      const started = deferred();
      const release = deferred();
      const queued = deferred();
      const acquire = BrowserMutex.prototype.acquire;
      let acquisitions = 0;
      vi.spyOn(BrowserMutex.prototype, "acquire").mockImplementation(function (this: BrowserMutex, signal) {
        const pending = acquire.call(this, signal);
        if (++acquisitions === 2) queued.resolve();
        return pending;
      });
      const first = fakePublishing(h.config.dataDir);
      const second = fakePublishing(h.config.dataDir);
      const send = first.cdp.send;
      let navigations = 0;
      first.cdp.send = async (method, params, sessionId) => {
        if (method === "Page.navigate" && ++navigations === 1) {
          started.resolve();
          await release.promise;
        }
        return send(method, params, sessionId);
      };
      const secondConnect = vi.spyOn(second.browser, "connection");
      const secondSend = vi.spyOn(second.cdp, "send");
      let firstSettled = false;
      const a = publishDraft(first.message, { dataDir: h.config.dataDir, browser: first.browser }).then((result) => {
        firstSettled = true;
        return result;
      });
      await started.promise;
      const b = publishDraft(second.message, { dataDir: h.config.dataDir, browser: second.browser });
      try {
        await queued.promise;
        expect(acquisitions).toBe(2);
        if (action === "pause") {
          await h.runner.pause(BotId.parse("bot-lanes"));
          release.resolve();
          expect((await a).result.status).toBe("ok");
        } else if (action === "stop") await h.runner.stop();
        else await h.runner.applyConfig({ ...h.config, bots: [] });
        const result = await Promise.race([b, nextTurn().then(() => null)]);
        expect(result?.result).toEqual({
          status: "failed",
          reason: "error",
          detail: action === "pause" ? "Bot 已暂停，这条没发出去，请让 Bot 再起一稿。" : "这次浏览器操作被中止了",
        });
        if (action !== "pause") expect(firstSettled).toBe(false);
        expect(secondConnect).toHaveBeenCalledTimes(0);
        expect(secondSend).toHaveBeenCalledTimes(0);
      } finally {
        release.resolve();
        await h.runner.stop();
        await Promise.all([a, b]);
      }
    },
    5000,
  );

  it.each(["connection", "operation", "assignment"] as const)(
    "run 进行中撤下 %s，下一次调用返回 WITHDRAWN 且不审批不执行",
    async (withdraw) => {
      const mcp = await startFakeMcp();
      cleanups.push(() => mcp.close());
      const arrived = deferred();
      const release = deferred();
      const conn = connection(mcp.url, "lookup_stock", false);
      const h = await harness(
        async function* (request, key) {
          if (!isFollowUpTurn(request)) {
            arrived.resolve();
            await release.promise;
          }
          yield* scriptedUpstream(() =>
            isFollowUpTurn(request) ? finish : call("lookup_stock", { sku: "WITHDRAWN" }),
          )(request, key);
        },
        { tools: [conn] },
      );
      const running = h.runner.prompt(prompt("withdraw-run"));
      try {
        await arrived.promise;
        await h.runner.applyConfig({
          ...h.config,
          tools:
            withdraw === "connection"
              ? []
              : [{ ...conn, ...(withdraw === "operation" ? { operations: [] } : { assignedBotIds: [] }) }],
        });
        release.resolve();
        await running;
        expect(JSON.stringify(sessionResults(h.config.dataDir, "group-a"))).toContain("已经不再提供这个操作");
        expect(mcp.calls).toEqual([]);
        expect(h.sent.filter((message) => message.type === "approval_request")).toEqual([]);
        expect(h.sent).toContainEqual(expect.objectContaining({ type: "bot_tool_call", status: "blocked" }));
      } finally {
        release.resolve();
        await running;
      }
    },
  );

  it("run 进行中操作改为要审批，按最新要求审批后才执行", async () => {
    const mcp = await startFakeMcp();
    cleanups.push(() => mcp.close());
    const arrived = deferred();
    const release = deferred();
    const conn = connection(mcp.url, "send_email", false);
    const h = await harness(
      async function* (request, key) {
        if (!isFollowUpTurn(request)) {
          arrived.resolve();
          await release.promise;
        }
        yield* scriptedUpstream(() =>
          isFollowUpTurn(request) ? finish : call("send_email", { to: "客户", subject: "收紧" }),
        )(request, key);
      },
      { tools: [conn] },
    );
    const running = h.runner.prompt(prompt("stricter-run"));
    try {
      await arrived.promise;
      await h.runner.applyConfig({ ...h.config, tools: [connection(mcp.url, "send_email", true)] });
      release.resolve();
      await h.waitFor((message) => message.type === "approval_request");
      expect(mcp.calls).toEqual([]);
      h.runner.approve(RunId.parse("stricter-run"), "same-call", "approved");
      await running;
      expect(mcp.calls).toHaveLength(1);
    } finally {
      release.resolve();
      await h.runner.stop();
      await running;
    }
  });

  it("等待审批期间撤下操作，批准也不执行已撤销操作", async () => {
    const mcp = await startFakeMcp();
    cleanups.push(() => mcp.close());
    const h = await harness(
      scriptedUpstream((request) =>
        isFollowUpTurn(request) ? finish : call("send_email", { to: "客户", subject: "撤销" }),
      ),
      { tools: [connection(mcp.url)] },
    );
    const running = h.runner.prompt(prompt("approval-withdrawn"));
    await h.waitFor((message) => message.type === "approval_request");
    await h.runner.applyConfig({ ...h.config, tools: [] });
    h.runner.approve(RunId.parse("approval-withdrawn"), "same-call", "approved");
    await running;
    expect(mcp.calls).toEqual([]);
    expect(JSON.stringify(sessionResults(h.config.dataDir, "group-a"))).toContain("已经不再提供这个操作");
    expect(h.sent.filter((message) => message.type === "approval_request")).toHaveLength(1);
  });

  it("取消排队 run 后立即从道队列丢弃，不等前面的 run 放行", async () => {
    const created = vi.spyOn(lanes, "createLane");
    const registered = vi.spyOn(LaneFence.prototype, "register");
    const started = deferred();
    const release = deferred();
    const h = await harness(async function* (request, key) {
      started.resolve();
      await release.promise;
      yield* scriptedUpstream(() => finish)(request, key);
    });
    let firstSettled = false;
    const first = h.runner.prompt(prompt("discard-first")).then(() => {
      firstSettled = true;
    });
    await started.promise;
    const cancelled = h.runner.prompt(prompt("discard-queued"));
    const lane = created.mock.results[0]?.value;
    try {
      expect(lane).toBeDefined();
      expect(findLaneRun([lane!], RunId.parse("discard-queued"))?.phase).toBe("queued");
      const fence = registered.mock.contexts[0] as LaneFence;
      expect(fence.headers(RunId.parse("discard-queued"))).toEqual({ "x-baize-lane": "bot-lanes/group-a/1" });
      h.runner.cancel(RunId.parse("discard-queued"));
      expect(fence.headers(RunId.parse("discard-queued"))).toEqual({});
      expect(
        fence.olderThan({ lane: { botId: BotId.parse("bot-lanes"), groupId: GroupId.parse("group-a") }, epoch: 2 }),
      ).not.toContain("discard-queued");
      expect(await fence.beforeEffect(RunId.parse("discard-queued"), "discard-probe", "external_write")).toBe(
        "和白泽断开了，这一步先不做",
      );
      fence.toolSettled(RunId.parse("discard-queued"), "discard-probe");
      expect(findLaneRun([lane!], RunId.parse("discard-queued"))?.phase).toBeUndefined();
      expect(firstSettled).toBe(false);
      expect(h.runner.activeRuns()).toEqual(["discard-first"]);
      expect(doneIds(h.sent)).toEqual([]);
      release.resolve();
      await Promise.all([first, cancelled]);
      expect(doneIds(h.sent)).toEqual(["discard-first"]);
    } finally {
      release.resolve();
      await Promise.all([first, cancelled]);
    }
  });

  it("取消同 Bot 一条道的审批只影响目标 run，其他道和同道后续 run 照常完成", async () => {
    const mcp = await startFakeMcp();
    cleanups.push(() => mcp.close());
    const h = await harness(
      scriptedUpstream((request) => {
        if (JSON.stringify(request.messages).includes("cancel-next") || isFollowUpTurn(request)) return finish;
        return call("send_email", {
          to: JSON.stringify(request.messages).includes("cancel-a") ? "甲" : "乙",
          subject: "取消",
        });
      }),
      { tools: [connection(mcp.url)] },
    );
    const a = h.runner.prompt(prompt("cancel-a"));
    const b = h.runner.prompt(prompt("cancel-b", "group-b"));
    await Promise.all(
      ["cancel-a", "cancel-b"].map((runId) =>
        h.waitFor((message) => message.type === "approval_request" && message.runId === runId),
      ),
    );
    const next = h.runner.prompt(prompt("cancel-next"));
    h.runner.cancel(RunId.parse("cancel-a"));
    h.runner.approve(RunId.parse("cancel-b"), "same-call", "approved");
    await Promise.all([a, b, next]);
    expect(doneIds(h.sent).toSorted()).toEqual(["cancel-b", "cancel-next"]);
    expect(h.sent.filter((message) => message.type === "approval_abandoned")).toEqual([]);
    expect(h.sent).toContainEqual(
      expect.objectContaining({ type: "run_done", runId: "cancel-next", prompt: "entered" }),
    );
    expect(mcp.calls.map((one) => one.args["to"])).toEqual(["乙"]);
    const results = sessionResults(h.config.dataDir, "group-a");
    expect(results).toContainEqual(expect.objectContaining({ isError: true }));
    expect(JSON.stringify(results)).toContain("这次运行已经结束，审批已过期，没执行。");
    expect(JSON.stringify(results)).not.toContain("Operation aborted");
    expect(h.runner.activeRuns()).toEqual([]);
  }, 5000);

  it("A 持浏览器锁时先暂停，B 入场在 A 放行前就返回暂停失败", async () => {
    const browser = fakeBrowser();
    const h = await harness(
      scriptedUpstream(() => finish),
      {
        browser: { profileDir: join(tmpdir(), "baize-publish-paused-entry"), connection: async () => browser.cdp },
      },
    );
    const lease = acquireBotBrowserMutex(h.config.dataDir, BotId.parse("bot-lanes"));
    const started = deferred();
    const release = deferred();
    let aSettled = false;
    const a = lease.run(async () => {
      started.resolve();
      await release.promise;
      aSettled = true;
    });
    const work = vi.fn(async () => {});
    let b: Promise<unknown> | undefined;
    try {
      await started.promise;
      await h.runner.pause(BotId.parse("bot-lanes"));
      b = lease.run(work).catch((error: unknown) => error);
      const result = await Promise.race([b, nextTurn().then(() => null)]);
      expect(result).toEqual(new Error("Bot 已暂停，这条没发出去，请让 Bot 再起一稿。"));
      expect(aSettled).toBe(false);
      expect(work).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await h.runner.resume(BotId.parse("bot-lanes"));
      await Promise.all([a, b]);
      lease.release();
    }
  });

  it("B 排在 A 的浏览器锁后，取得锁到返回调用方之间停机，B 不进入 work", async () => {
    const browser = fakeBrowser();
    const h = await harness(
      scriptedUpstream(() => finish),
      {
        browser: { profileDir: join(tmpdir(), "baize-publish-stop-after-lock"), connection: async () => browser.cdp },
      },
    );
    const lease = acquireBotBrowserMutex(h.config.dataDir, BotId.parse("bot-lanes"));
    const started = deferred();
    const release = deferred();
    const queued = deferred();
    const acquire = lease.mutex.acquire;
    let acquisitions = 0;
    let stopping: Promise<void> | undefined;
    vi.spyOn(lease.mutex, "acquire").mockImplementation(function (this: BrowserMutex, signal) {
      const second = ++acquisitions === 2;
      const pending = acquire.call(this, signal);
      if (second) queued.resolve();
      return pending.then((unlock) => {
        // 排队中 abort 会被 acquire 自己拒绝；把停机钉在已取锁、调用方尚未续跑的窄窗口。
        if (second) stopping = h.runner.stop();
        return unlock;
      });
    });
    const a = lease.run(async () => {
      started.resolve();
      await release.promise;
    });
    const work = vi.fn(async () => {});
    let b: Promise<unknown> | undefined;
    try {
      await started.promise;
      b = lease.run(work).catch((error: unknown) => error);
      await queued.promise;
      expect(work).not.toHaveBeenCalled();
      release.resolve();
      expect(await b).toEqual(new Error("这次浏览器操作被中止了"));
      expect(work).not.toHaveBeenCalled();
      await stopping;
    } finally {
      release.resolve();
      await Promise.all([a, b, stopping]);
      lease.release();
    }
  });

  it("B 取得浏览器锁后被暂停检查拒绝，恢复后同一 lease 仍能进入 work", async () => {
    const browser = fakeBrowser();
    const h = await harness(
      scriptedUpstream(() => finish),
      {
        browser: { profileDir: join(tmpdir(), "baize-publish-release-on-pause"), connection: async () => browser.cdp },
      },
    );
    const lease = acquireBotBrowserMutex(h.config.dataDir, BotId.parse("bot-lanes"));
    const started = deferred();
    const release = deferred();
    const queued = deferred();
    const acquire = lease.mutex.acquire;
    let acquisitions = 0;
    let unlockB: (() => void) | undefined;
    vi.spyOn(lease.mutex, "acquire").mockImplementation(function (this: BrowserMutex, signal) {
      const second = ++acquisitions === 2;
      const pending = acquire.call(this, signal);
      if (second) queued.resolve();
      return pending.then((unlock) => {
        if (second) unlockB = unlock;
        return unlock;
      });
    });
    const a = lease.run(async () => {
      started.resolve();
      await release.promise;
    });
    const rejectedWork = vi.fn(async () => {});
    const resumedWork = vi.fn(async () => {});
    let b: Promise<unknown> | undefined;
    let resumed: Promise<void> | undefined;
    try {
      await started.promise;
      b = lease.run(rejectedWork).catch((error: unknown) => error);
      await queued.promise;
      await h.runner.pause(BotId.parse("bot-lanes"));
      release.resolve();
      expect(await b).toEqual(new Error("Bot 已暂停，这条没发出去，请让 Bot 再起一稿。"));
      expect(rejectedWork).not.toHaveBeenCalled();
      await h.runner.resume(BotId.parse("bot-lanes"));
      resumed = lease.run(resumedWork);
      expect(await Promise.race([resumed.then(() => true), nextTurn().then(() => false)])).toBe(true);
      expect(resumedWork).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      // 变异若泄漏 B 的锁，也能在失败断言之后收干净，避免污染后面的用例。
      unlockB?.();
      await Promise.all([a, b, resumed]);
      lease.release();
    }
  });

  it.each(["stop", "delete", "queued-discard-then-stop", "cancel"] as const)(
    "%s 退出路径释放代际引用，Client.close 次数等于连接数",
    async (path) => {
      const mcp = await startFakeMcp();
      cleanups.push(() => mcp.close());
      const close = vi.spyOn(Client.prototype, "close");
      const held = deferred();
      const release = deferred();
      const h = await harness(
        async function* (request, key) {
          if (isFollowUpTurn(request)) {
            held.resolve();
            await release.promise;
          }
          yield* scriptedUpstream(() => (isFollowUpTurn(request) ? finish : call("lookup_stock", { sku: "PINNED" })))(
            request,
            key,
          );
        },
        { tools: [connection(mcp.url, "lookup_stock", false)] },
      );
      const running = h.runner.prompt(prompt("reference-running"));
      try {
        await held.promise;
        expect(mcp.connections).toBe(1);
        await h.runner.applyConfig({ ...h.config, tools: [] });
        expect(close).not.toHaveBeenCalled();
        const queued = path === "queued-discard-then-stop" ? h.runner.prompt(prompt("reference-queued")) : undefined;
        if (queued !== undefined) h.runner.cancel(RunId.parse("reference-queued"));
        if (path === "cancel") h.runner.cancel(RunId.parse("reference-running"));
        const closing =
          path === "delete"
            ? h.runner.applyConfig({ ...h.config, bots: [] })
            : path === "cancel"
              ? Promise.resolve()
              : h.runner.stop();
        release.resolve();
        await Promise.all([running, queued, closing]);
        await h.runner.stop();
        expect(close).toHaveBeenCalledTimes(mcp.connections);
        expect(mcp.connections).toBe(1);
        if (path === "cancel") expect(doneIds(h.sent)).toEqual([]);
        else expect(doneIds(h.sent)).toEqual(["reference-running"]);
        expect(h.runner.activeRuns()).toEqual([]);
      } finally {
        release.resolve();
        await running;
      }
    },
  );
});

describe("分道与租约合并", () => {
  it("同 Bot 两群的 Hub 附件请求继承调用方的道头", async () => {
    const hub = await startAttachmentHub();
    cleanups.push(() => hub.close());
    const arrived = { a: deferred(), b: deferred() };
    const release = deferred();
    const h = await harness(
      async function* (request, key) {
        const lane = JSON.stringify(request.messages).includes("hub-a") ? "a" : "b";
        if (!isFollowUpTurn(request)) {
          arrived[lane].resolve();
          await release.promise;
        }
        yield* scriptedUpstream(() =>
          isFollowUpTurn(request)
            ? finish
            : call("create_draft", {
                accountId: "account-hub",
                content: { kind: "post", title: lane, text: lane, images: [{ path: "cover.png" }] },
              }),
        )(request, key);
      },
      {
        hub: { baseUrl: hub.baseUrl },
        accounts: [
          {
            id: AccountId.parse("account-hub"),
            platform: "xiaohongshu",
            handle: "测试",
            login: "valid",
            tier: "confirm_publish",
          },
        ],
      },
    );
    const work = join(h.dataDir, "bot-lanes", "work");
    mkdirSync(work, { recursive: true });
    writeFileSync(
      join(work, "cover.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const a = h.runner.prompt({ ...prompt("hub-a"), lane: { epoch: 2, heads: {} } });
    const b = h.runner.prompt({ ...prompt("hub-b", "group-b"), lane: { epoch: 7, heads: {} } });
    try {
      await Promise.all([arrived.a.promise, arrived.b.promise]);
      release.resolve();
      await Promise.all([a, b]);
      expect(hub.uploads).toHaveLength(2);
      for (const [index, upload] of hub.uploads.entries()) {
        expect(hub.laneHeaders[index]).toBe(
          upload.groupId === "group-a" ? "bot-lanes/group-a/2" : "bot-lanes/group-b/7",
        );
      }
      const draft = h.sent.find((message) => message.type === "draft_create" && message.groupId === "group-a");
      if (draft?.type !== "draft_create" || draft.draft.content.kind !== "post") throw new Error("A 道未建附件草稿");
      const image = draft.draft.content.images[0];
      if (image?.kind !== "attachment") throw new Error("A 道未上传附件");
      await downloadAttachment(
        () => ({
          hub: h.config.hub,
          gateway: h.config.modelGateway,
          laneHeaders: { "x-baize-lane": "bot-lanes/group-a/2" },
        }),
        image.attachmentId,
      );
      expect(hub.laneHeaders.at(-1)).toBe("bot-lanes/group-a/2");
      expect(doneIds(h.sent).toSorted()).toEqual(["hub-a", "hub-b"]);
    } finally {
      release.resolve();
      await Promise.all([a, b]);
    }
  }, 5000);

  it("同 Bot 两群同时在跑时模型和 MCP 代执行各带调用方的道头", async () => {
    const modelArrived = { a: deferred(), b: deferred() };
    const releaseModels = deferred();
    const proxyArrived = { a: deferred(), b: deferred() };
    const releaseProxy = deferred();
    const proxyCalls: Array<{ lane: string; header: string | undefined }> = [];
    const proxy = createServer(async (request, response) => {
      const parts: Buffer[] = [];
      for await (const part of request) parts.push(Buffer.from(part as Uint8Array));
      const body = McpProxyCallRequest.parse(JSON.parse(Buffer.concat(parts).toString()));
      const lane = body.arguments["lane"] === "a" ? "a" : "b";
      const header = request.headers["x-baize-lane"];
      proxyCalls.push({ lane, header: Array.isArray(header) ? header.join(",") : header });
      proxyArrived[lane].resolve();
      await releaseProxy.promise;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ content: [{ type: "text", text: "已读取" }], isError: false }));
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (address === null || typeof address === "string") throw new Error("假 MCP 代理未监听");
    cleanups.push(async () => {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    });
    const h = await harness(
      async function* (request, key) {
        const lane = JSON.stringify(request.messages).includes("headers-a") ? "a" : "b";
        if (!isFollowUpTurn(request)) {
          modelArrived[lane].resolve();
          await releaseModels.promise;
        }
        yield* scriptedUpstream(() => (isFollowUpTurn(request) ? finish : call("lookup_lane", { lane })))(request, key);
      },
      {
        tools: [
          {
            ...connection("http://unused", "lookup_lane", false),
            localOnly: false,
            url: "http://unused",
          },
        ],
        mcpProxy: { baseUrl: `http://127.0.0.1:${address.port}/mcp-proxy` },
      },
    );
    const a = h.runner.prompt({ ...prompt("headers-a"), lane: { epoch: 3, heads: {} } });
    const b = h.runner.prompt({ ...prompt("headers-b", "group-b"), lane: { epoch: 8, heads: {} } });
    try {
      await Promise.all([modelArrived.a.promise, modelArrived.b.promise]);
      expect(h.runner.activeRuns().toSorted()).toEqual(["headers-a", "headers-b"]);
      releaseModels.resolve();
      await Promise.all([proxyArrived.a.promise, proxyArrived.b.promise]);
      expect(proxyCalls.toSorted((left, right) => left.lane.localeCompare(right.lane))).toEqual([
        { lane: "a", header: "bot-lanes/group-a/3" },
        { lane: "b", header: "bot-lanes/group-b/8" },
      ]);
      releaseProxy.resolve();
      await Promise.all([a, b]);
      expect(h.gateway.laneRequests).toHaveLength(4);
      for (const request of h.gateway.laneRequests) {
        expect(request.header).toBe(
          JSON.stringify(request.body.messages).includes("headers-a") ? "bot-lanes/group-a/3" : "bot-lanes/group-b/8",
        );
      }
      expect(doneIds(h.sent).toSorted()).toEqual(["headers-a", "headers-b"]);
    } finally {
      releaseModels.resolve();
      releaseProxy.resolve();
      await Promise.all([a, b]);
    }
  }, 5000);

  it("同道复用会话的两条 run，模型和 MCP 代执行各现取自己的代际", async () => {
    const proxyHeaders: Array<string | string[] | undefined> = [];
    const proxy = createServer(async (request, response) => {
      const parts: Buffer[] = [];
      for await (const part of request) parts.push(Buffer.from(part as Uint8Array));
      McpProxyCallRequest.parse(JSON.parse(Buffer.concat(parts).toString()));
      proxyHeaders.push(request.headers["x-baize-lane"]);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ content: [{ type: "text", text: "已读取" }], isError: false }));
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (address === null || typeof address === "string") throw new Error("假 MCP 代理未监听");
    cleanups.push(async () => {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    });
    const sessions = vi.spyOn(AgentSession.prototype, "prompt");
    const h = await harness(
      scriptedUpstream((request) => (request.messages.at(-1)?.role === "tool" ? finish : call("lookup_lane"))),
      {
        tools: [{ ...connection("http://unused", "lookup_lane", false), localOnly: false }],
        mcpProxy: { baseUrl: `http://127.0.0.1:${address.port}/mcp-proxy` },
      },
    );
    await h.runner.prompt({ ...prompt("reuse-old"), lane: { epoch: 3, heads: {} } });
    await h.runner.prompt({ ...prompt("reuse-new"), lane: { epoch: 8, heads: {} } });
    expect(sessions).toHaveBeenCalledTimes(2);
    expect(sessions.mock.contexts[1]).toBe(sessions.mock.contexts[0]);
    expect(proxyHeaders).toEqual(["bot-lanes/group-a/3", "bot-lanes/group-a/8"]);
    expect(h.gateway.laneHeaders).toEqual([
      "bot-lanes/group-a/3",
      "bot-lanes/group-a/3",
      "bot-lanes/group-a/8",
      "bot-lanes/group-a/8",
    ]);
    expect(doneIds(h.sent)).toEqual(["reuse-old", "reuse-new"]);
  });

  it("同群两个 Bot 在跑时 lane cancel 只取消目标 Bot，另一个正常完成", async () => {
    const probeArrived = { a: deferred(), b: deferred() };
    const releaseB = deferred();
    const mcp = await startFakeMcp();
    cleanups.push(() => mcp.close());
    const bots: RunnerConfig["bots"] = [
      { id: BotId.parse("bot-lanes"), name: "助理 A", role: "member", preset: null, tags: [], description: "" },
      { id: BotId.parse("bot-other"), name: "助理 B", role: "member", preset: null, tags: [], description: "" },
    ];
    const h = await harness(
      scriptedUpstream((request) =>
        isFollowUpTurn(request)
          ? finish
          : call("send_email", {
              to: JSON.stringify(request.messages).includes("same-group-a") ? "a" : "b",
              subject: "取消隔离",
            }),
      ),
      {
        bots,
        tools: [{ ...connection(mcp.url), assignedBotIds: bots.map((bot) => bot.id) }],
        workAppend: async (frame) => {
          const bot = frame.lane.botId === "bot-lanes" ? "a" : "b";
          probeArrived[bot].resolve();
          if (bot === "a") return await new Promise(() => {});
          await releaseB.promise;
          return { kind: "ok" };
        },
      },
    );
    const inGroup = (runId: string, botId: BotId): PromptMessage => ({
      ...prompt(runId),
      botId,
      group: { ...prompt(runId).group, kind: "team" },
      members: bots.map(({ id, name, tags, description }) => ({ id, name, tags, description, seat: "member" })),
    });
    const a = h.runner.prompt(inGroup("same-group-a", BotId.parse("bot-lanes")));
    const b = h.runner.prompt(inGroup("same-group-b", BotId.parse("bot-other")));
    try {
      await Promise.all(
        ["same-group-a", "same-group-b"].map((runId) =>
          h.waitFor((message) => message.type === "approval_request" && message.runId === runId),
        ),
      );
      h.runner.approve(RunId.parse("same-group-a"), "same-call", "approved");
      h.runner.approve(RunId.parse("same-group-b"), "same-call", "approved");
      await Promise.all([probeArrived.a.promise, probeArrived.b.promise]);
      h.runner.cancel({ lane: { botId: BotId.parse("bot-lanes"), groupId: GroupId.parse("group-a") }, epoch: 2 });
      expect(h.runner.activeRuns()).toEqual(["same-group-b"]);
      await a;
      releaseB.resolve();
      await b;
      expect(doneIds(h.sent)).toEqual(["same-group-b"]);
      expect(mcp.calls.map((one) => one.args["to"])).toEqual(["b"]);
      expect(h.sent.filter((message) => message.type === "bot_tool_call" && message.status === "blocked")).toEqual([
        expect.objectContaining({ runId: "same-group-a", botId: "bot-lanes", groupId: "group-a" }),
      ]);
      expect(h.sent).toContainEqual(
        expect.objectContaining({ type: "bot_tool_call", runId: "same-group-b", botId: "bot-other", status: "ok" }),
      );
    } finally {
      releaseB.resolve();
      await h.runner.stop();
      await Promise.all([a, b]);
    }
  }, 5000);

  it("A 道探针被接管取消时只落 A 的 blocked，B 在跑与 A 的同代际、新代际继续完成", async () => {
    const probeArrived = { a: deferred(), b: deferred() };
    const releaseB = deferred();
    const probes: string[] = [];
    const mcp = await startFakeMcp();
    cleanups.push(() => mcp.close());
    const h = await harness(
      scriptedUpstream((request) => {
        const body = JSON.stringify(request.messages);
        if (isFollowUpTurn(request) || body.includes("epoch-same") || body.includes("epoch-new")) return finish;
        return call("send_email", { to: body.includes("epoch-a") ? "a" : "b", subject: "接管" });
      }),
      {
        tools: [connection(mcp.url)],
        workAppend: async (frame) => {
          probes.push(frame.runId ?? "no-run");
          const lane = frame.runId === "epoch-a" ? "a" : "b";
          probeArrived[lane].resolve();
          if (lane === "a") return await new Promise(() => {});
          await releaseB.promise;
          return { kind: "ok" };
        },
      },
    );
    const a = h.runner.prompt({ ...prompt("epoch-a"), lane: { epoch: 1, heads: {} } });
    const b = h.runner.prompt({ ...prompt("epoch-b", "group-b"), lane: { epoch: 1, heads: {} } });
    let queued: Promise<void>[] = [];
    try {
      await Promise.all(
        ["epoch-a", "epoch-b"].map((runId) =>
          h.waitFor((message) => message.type === "approval_request" && message.runId === runId),
        ),
      );
      h.runner.approve(RunId.parse("epoch-a"), "same-call", "approved");
      h.runner.approve(RunId.parse("epoch-b"), "same-call", "approved");
      await Promise.all([probeArrived.a.promise, probeArrived.b.promise]);
      queued = [
        h.runner.prompt({ ...prompt("epoch-old-queued"), lane: { epoch: 2, heads: {} } }),
        h.runner.prompt({ ...prompt("epoch-same"), lane: { epoch: 3, heads: {} } }),
        h.runner.prompt({ ...prompt("epoch-new"), lane: { epoch: 4, heads: {} } }),
      ];
      h.runner.cancel({ lane: { botId: BotId.parse("bot-lanes"), groupId: GroupId.parse("group-a") }, epoch: 3 });
      expect(h.runner.activeRuns().toSorted()).toEqual(["epoch-b", "epoch-new", "epoch-same"]);
      await a;
      expect(doneIds(h.sent)).not.toContain("epoch-b");
      releaseB.resolve();
      await Promise.all([b, ...queued]);
      expect(doneIds(h.sent).toSorted()).toEqual(["epoch-b", "epoch-new", "epoch-same"]);
      expect(mcp.calls.map((one) => one.args["to"])).toEqual(["b"]);
      expect(probes.toSorted()).toEqual(["epoch-a", "epoch-b"]);
      expect(h.sent).toContainEqual(
        expect.objectContaining({ type: "bot_tool_call", runId: "epoch-a", status: "blocked" }),
      );
      expect(JSON.stringify(sessionResults(h.dataDir, "group-a"))).toContain("和白泽断开了，这一步先不做");
      expect(JSON.stringify(sessionResults(h.dataDir, "group-a"))).not.toContain("Operation aborted");
      expect(h.runner.activeRuns()).toEqual([]);
    } finally {
      releaseB.resolve();
      await h.runner.stop();
      await Promise.all([a, b, ...queued]);
    }
  }, 5000);

  it("暂停期间取消 A 道审批不结算 B 道的暂停等待，恢复后 B 正常执行", async () => {
    const mcp = await startFakeMcp();
    cleanups.push(() => mcp.close());
    const h = await harness(
      scriptedUpstream((request) =>
        isFollowUpTurn(request)
          ? finish
          : call("send_email", {
              to: JSON.stringify(request.messages).includes("paused-a") ? "a" : "b",
              subject: "暂停隔离",
            }),
      ),
      { tools: [connection(mcp.url)] },
    );
    const a = h.runner.prompt(prompt("paused-a"));
    let bSettled = false;
    const b = h.runner.prompt(prompt("paused-b", "group-b")).then(() => {
      bSettled = true;
    });
    try {
      await Promise.all(
        ["paused-a", "paused-b"].map((runId) =>
          h.waitFor((message) => message.type === "approval_request" && message.runId === runId),
        ),
      );
      await h.runner.pause(BotId.parse("bot-lanes"));
      h.runner.approve(RunId.parse("paused-b"), "same-call", "approved");
      await nextTurn();
      h.runner.cancel(RunId.parse("paused-a"));
      await a;
      await nextTurn();
      expect(bSettled).toBe(false);
      expect(h.runner.activeRuns()).toEqual(["paused-b"]);
      expect(mcp.calls).toEqual([]);
      expect(doneIds(h.sent)).toEqual([]);
      await h.runner.resume(BotId.parse("bot-lanes"));
      await b;
      expect(mcp.calls.map((one) => one.args["to"])).toEqual(["b"]);
      expect(doneIds(h.sent)).toEqual(["paused-b"]);
    } finally {
      await h.runner.resume(BotId.parse("bot-lanes"));
      await h.runner.stop();
      await Promise.all([a, b]);
    }
  }, 5000);

  it.each(["非浏览器", "浏览器"] as const)(
    "%s审批后取锁返回的微任务窗口暂停，探针和副作用等恢复",
    async (kind) => {
      const browser = fakeBrowser();
      const paused = deferred();
      const probes: string[] = [];
      const mcp = await startFakeMcp();
      cleanups.push(() => mcp.close());
      const h = await harness(
        scriptedUpstream((request) =>
          isFollowUpTurn(request)
            ? finish
            : kind === "浏览器"
              ? call("browser_click", { ref: 1 })
              : call("send_email", { to: "pause-window", subject: "暂停窗口" }),
        ),
        {
          tools: kind === "非浏览器" ? [connection(mcp.url)] : [],
          ...(kind === "浏览器"
            ? { browser: { profileDir: join(tmpdir(), "baize-pause-window"), connection: async () => browser.cdp } }
            : {}),
          workAppend: async (frame) => {
            probes.push(frame.runId ?? "no-run");
            return { kind: "ok" };
          },
        },
      );
      const pause = () => {
        void h.runner.pause(BotId.parse("bot-lanes")).then(paused.resolve);
      };
      if (kind === "浏览器") {
        const acquire = BrowserMutex.prototype.acquire;
        let acquisitions = 0;
        vi.spyOn(BrowserMutex.prototype, "acquire").mockImplementation(function (this: BrowserMutex, signal) {
          const pending = acquire.call(this, signal);
          if (++acquisitions !== 2) return pending;
          return pending.then((release) => {
            // 让 acquire 内的暂停复验先通过，再在调用方恢复执行前暂停。
            queueMicrotask(() => queueMicrotask(pause));
            return release;
          });
        });
      }
      const running = h.runner.prompt(prompt("pause-window"));
      try {
        await h.waitFor((message) => message.type === "approval_request");
        h.runner.approve(RunId.parse("pause-window"), "same-call", "approved");
        if (kind === "非浏览器") {
          // 审批后暂停闸门先通过，下一次 await 是不取锁的 acquire。
          queueMicrotask(() => queueMicrotask(pause));
        }
        await paused.promise;
        await nextTurn();
        expect(probes).toEqual([]);
        expect(browser.effects).toEqual([]);
        expect(mcp.calls).toEqual([]);
        expect(doneIds(h.sent)).toEqual([]);
        await h.runner.resume(BotId.parse("bot-lanes"));
        await running;
        expect(probes).toEqual(["pause-window"]);
        if (kind === "浏览器") expect(browser.effects).toContain("Input.dispatchMouseEvent");
        else expect(mcp.calls.map((one) => one.args["to"])).toEqual(["pause-window"]);
        expect(doneIds(h.sent)).toEqual(["pause-window"]);
      } finally {
        await h.runner.resume(BotId.parse("bot-lanes"));
        await h.runner.stop();
        await running;
      }
    },
    5000,
  );

  it("浏览器批准后等重新取锁期间接管，取锁后才探针且零点击", async () => {
    const browser = fakeBrowser();
    const lockQueued = deferred();
    const originalAcquire = BrowserMutex.prototype.acquire;
    let acquisitions = 0;
    vi.spyOn(BrowserMutex.prototype, "acquire").mockImplementation(function (this: BrowserMutex, signal) {
      acquisitions += 1;
      if (acquisitions === 3) lockQueued.resolve();
      return originalAcquire.call(this, signal);
    });
    let takenOver = false;
    const probes: boolean[] = [];
    const h = await harness(
      scriptedUpstream((request) => (isFollowUpTurn(request) ? finish : call("browser_click", { ref: 1 }))),
      {
        browser: { profileDir: join(tmpdir(), "baize-probe-lock"), connection: async () => browser.cdp },
        workAppend: async () => {
          probes.push(takenOver);
          return { kind: takenOver ? "stale_epoch" : "ok" };
        },
      },
    );
    const running = h.runner.prompt(prompt("probe-lock"));
    const lease = acquireBotBrowserMutex(h.dataDir, BotId.parse("bot-lanes"));
    let release: (() => void) | undefined;
    try {
      await h.waitFor((message) => message.type === "approval_request");
      release = await lease.mutex.acquire(undefined);
      h.runner.approve(RunId.parse("probe-lock"), "same-call", "approved");
      await lockQueued.promise;
      expect(probes).toEqual([]);
      takenOver = true;
      release();
      release = undefined;
      await running;
      expect(probes).toEqual([true]);
      expect(browser.effects).toEqual([]);
      expect(JSON.stringify(sessionResults(h.dataDir, "group-a"))).toContain("这个群已经换到另一台电脑上了");
    } finally {
      release?.();
      lease.release();
      await h.runner.stop();
      await running;
    }
  }, 5000);
});
