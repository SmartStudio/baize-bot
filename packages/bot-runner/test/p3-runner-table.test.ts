import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentToControl,
  BotId,
  ComputerId,
  GroupId,
  MessageId,
  PokerHandId,
  PokerSeatView,
  PokerSessionId,
  type PokerPersona,
  RunId,
  type TablePrompt,
  TaskId,
} from "@baize/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunner, type PromptMessage, type Runner, type RunnerConfig } from "../src/index.js";
import { composeTablePrompt, createPokerResults } from "../src/table.js";
import { tablePersona } from "../src/persona.js";
import { startGateway, type Gateway } from "./fixtures/gateway.js";
import { scriptedUpstream, type ChatCompletionRequest, type ScriptedTurn } from "./fixtures/openai-sse.js";

const view = (): PokerSeatView =>
  PokerSeatView.parse({
    seatId: "seat-1",
    position: "button",
    hole: ["8c", "7d"],
    stack: 1900,
    summary: "控制面给出的牌力摘要",
    street: "flop",
    board: ["2s", "3h", "4d"],
    pot: 320,
    blinds: { small: 10, big: 20 },
    seats: [{ seatId: "seat-4", position: "big_blind", stack: 1820, committed: 80, status: "active", shown: null }],
    legal: {
      kind: "your_turn",
      street: "flop",
      toCall: 40,
      options: [
        { kind: "fold" },
        { kind: "call", amount: 40 },
        { kind: "raise", min: 120, max: 1900 },
        { kind: "all_in", amount: 1900 },
      ],
    },
    awards: null,
    events: [
      { kind: "blind", seatId: "seat-4", amount: 20 },
      { kind: "street", street: "flop", cards: ["2s", "3h", "4d"] },
    ],
  });

const prompt = (role: TablePrompt["role"] = "player", overrides: Partial<PromptMessage> = {}): PromptMessage => ({
  type: "prompt",
  runId: RunId.parse("run-table"),
  botId: BotId.parse("bot-table"),
  groupId: GroupId.parse("group-table"),
  messageId: MessageId.parse("message-table"),
  text: "不该进入牌桌的当前群消息",
  origin: { kind: "table" },
  reason: "solo",
  group: { id: GroupId.parse("group-table"), number: "", title: "牌桌", kind: "team" },
  context: [
    { messageId: MessageId.parse("history-secret"), from: "历史秘密成员", text: "群历史秘密牌 As Kd", settled: true },
  ],
  task: {
    id: TaskId.parse("task-secret"),
    groupId: GroupId.parse("group-table"),
    number: "T-secret",
    title: "秘密任务卡",
    summary: "秘密",
    dueAt: null,
    checklist: [],
    currentBotId: null,
    handled: [],
    status: "active",
    cadence: "",
    goal: null,
    metricSource: null,
    metric: null,
  },
  members: [{ id: BotId.parse("member-secret"), name: "秘密成员名单", tags: [], description: "秘密", seat: "member" }],
  purpose: role === "player" ? "fast" : "plan",
  routine: null,
  table: {
    role,
    sessionId: PokerSessionId.parse("session-from-control"),
    handId: PokerHandId.parse("hand-from-control"),
    seq: 7,
    view: view(),
    publicLog: ["用户跟注 40"],
    question: null,
    review: null,
  },
  ...overrides,
});

const finish: ScriptedTurn = { textChunks: ["内部推理秘密底牌"], usage: { input: 10, output: 5 } };
const call = (id: string, name: string, args: Record<string, unknown>): ScriptedTurn => ({
  ...finish,
  toolCall: { id, name, args },
});
const toolNames = (req: ChatCompletionRequest): string[] =>
  (req.tools ?? []).map((tool) => tool.function.name).toSorted();

const actionMessage = (runId: string) => ({
  type: "poker_act" as const,
  runId: RunId.parse(runId),
  callId: "same-call",
  handId: PokerHandId.parse("hand"),
  seq: 0,
  action: { kind: "fold" as const },
});

const resources: Array<{ runner: Runner; gateway: Gateway; dataDir: string }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const resource of resources.splice(0)) {
    await resource.runner.stop();
    await resource.gateway.close();
    rmSync(resource.dataDir, { recursive: true, force: true });
  }
});

async function harness(
  script: (request: ChatCompletionRequest) => ScriptedTurn = () => finish,
  onSend: (message: AgentToControl, runner: Runner) => void = () => {},
  overrides: Partial<RunnerConfig> = {},
) {
  const requests: ChatCompletionRequest[] = [];
  const sent: AgentToControl[] = [];
  const gateway = await startGateway({
    models: [{ id: "test-model" }],
    upstream: scriptedUpstream((request) => {
      requests.push(request);
      return script(request);
    }),
  });
  const dataDir = mkdtempSync(join(tmpdir(), "baize-p3-runner-table-"));
  const runner = createRunner({
    computerId: ComputerId.parse("computer-table"),
    bots: [{ id: BotId.parse("bot-table"), role: "player", preset: "old_k", name: "老K", tags: [], description: "" }],
    tools: [],
    accounts: [],
    grants: [],
    brand: null,
    preferences: [],
    modelGateway: { baseUrl: gateway.baseUrl, apiKey: "fake-table-key" },
    accountsProxy: { baseUrl: "http://127.0.0.1:9" },
    dataDir,
    ...overrides,
    send: (message) => {
      sent.push(AgentToControl.parse(message));
      onSend(message, runner);
    },
  });
  resources.push({ runner, gateway, dataDir });
  return { runner, requests, sent, dataDir };
}

describe("p3-runner-table 验收", () => {
  it("player 的 prompt 里有自己的底牌和合法动作，没有任务卡、成员名单和群历史", () => {
    const text = composeTablePrompt(prompt());
    for (const value of [
      "8c",
      "7d",
      "控制面给出的牌力摘要",
      "40",
      "120",
      "1900",
      "320",
      "1820",
      "80",
      "庄位",
      "弃牌",
      "跟注",
      "加注",
      "用户跟注 40",
    ])
      expect(text).toContain(value);
    for (const value of ["秘密任务卡", "秘密成员名单", "群历史秘密", "不该进入牌桌"]) expect(text).not.toContain(value);
  });

  it("prompt 里出现的牌面都来自给定的视图", () => {
    const message = prompt();
    message.table!.view = { ...view(), seats: [{ ...view().seats[0]!, shown: ["Qc", "Jc"] }] };
    const text = composeTablePrompt(message);
    expect(text).toContain("Qc");
    expect(text).toContain("Jc");
    const cards = text.match(/\b[2-9TJQKA][shdc]\b/g) ?? [];
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((card) => ["8c", "7d", "2s", "3h", "4d", "Qc", "Jc"].includes(card))).toBe(true);
    expect(text).not.toMatch(/As|Kd/);
  });

  it("poker_act 发出带 runId 和 callId 的上行并等结果", async () => {
    let received!: (message: Extract<AgentToControl, { type: "poker_act" }>) => void;
    const action = new Promise<Extract<AgentToControl, { type: "poker_act" }>>((resolve) => {
      received = resolve;
    });
    const h = await harness(
      (request) =>
        request.messages.some((m) => m.role === "tool") || !toolNames(request).includes("poker_act")
          ? finish
          : call("act-1", "poker_act", { action: "raise", amount: 120, say: "加一点。" }),
      (message) => {
        if (message.type === "poker_act") received(message);
      },
    );
    const running = h.runner.prompt(prompt());
    const outgoing = await Promise.race([action, running.then(() => null)]);
    expect(outgoing).toEqual({
      type: "poker_act",
      runId: "run-table",
      callId: "act-1",
      handId: "hand-from-control",
      seq: 7,
      action: { kind: "raise", amount: 120 },
      say: "加一点。",
    });
    expect(h.sent.some((m) => m.type === "run_done")).toBe(false);
    h.runner.pokerResult(RunId.parse("wrong-run"), "act-1", { ok: true });
    h.runner.pokerResult(RunId.parse("run-table"), "wrong-call", { ok: true });
    expect(h.sent.some((m) => m.type === "run_done")).toBe(false);
    h.runner.pokerResult(RunId.parse("run-table"), "act-1", { ok: true });
    await running;
    expect(h.sent.filter((m) => m.type === "run_done")).toHaveLength(1);
    expect(h.sent.filter((m) => m.type === "bot_text" || m.type === "bot_tool_call")).toEqual([]);
  });

  it("引擎拒绝时工具抛中文错误且同一次运行里可以再调一次", async () => {
    const h = await harness(
      (request) => {
        const results = request.messages.filter((m) => m.role === "tool");
        return !toolNames(request).includes("poker_act") || results.length >= 2
          ? finish
          : call(`retry-${results.length}`, "poker_act", { action: "call" });
      },
      (message, runner) => {
        if (message.type === "poker_act")
          runner.pokerResult(
            message.runId,
            message.callId,
            message.callId === "retry-0" ? { ok: false, error: "加注额不足，请至少加到 120。" } : { ok: true },
          );
      },
    );
    await h.runner.prompt(prompt());
    expect(h.sent.filter((m) => m.type === "poker_act").map((m) => m.runId)).toEqual(["run-table", "run-table"]);
    expect(JSON.stringify(h.requests[1]?.messages.filter((m) => m.role === "tool"))).toContain(
      "加注额不足，请至少加到 120。",
    );
  });

  it("player 的会话里没有 bash、浏览器、account_read", async () => {
    const h = await harness(undefined, undefined, {
      browser: {
        profileDir: "/tmp/p3-runner-table-fake-profile",
        connection: async () => {
          throw new Error("牌桌不应连接浏览器");
        },
      },
      tools: [
        {
          id: "mcp-table" as RunnerConfig["tools"][number]["id"],
          ownerId: "owner" as RunnerConfig["tools"][number]["ownerId"],
          name: "秘密 MCP",
          url: "http://127.0.0.1:9/mcp",
          authorization: null,
          status: "ready",
          assignedBotIds: [BotId.parse("bot-table")],
          operations: [{ name: "secret_mcp", description: "", inputSchema: {}, needsApproval: false }],
        },
      ],
    });
    await h.runner.prompt(prompt());
    expect(h.sent.filter((message) => message.type === "agent_error")).toEqual([]);
    expect(toolNames(h.requests[0]!)).toEqual(["poker_act"]);
    expect(JSON.stringify(h.requests[0]?.messages)).toContain("紧凶");
    expect(JSON.stringify(h.requests[0]?.messages)).toContain("不自行计算牌力");
  });

  it("advisor 的会话里没有 poker_act", async () => {
    const h = await harness();
    await h.runner.prompt(prompt("advisor"));
    expect(toolNames(h.requests[0]!)).toEqual([]);
    const text = JSON.stringify(h.requests[0]?.messages);
    expect(text).toContain("用户问：这手怎么打");
    expect(text).toContain("120 字");
    expect(h.sent.some((m) => m.type === "bot_text")).toBe(true);
  });

  it("reviewer 只有 poker_review", async () => {
    const h = await harness((request) =>
      request.messages.some((m) => m.role === "tool") || !toolNames(request).includes("poker_review")
        ? finish
        : call("review-1", "poker_review", { hands: [{ number: 3, title: "转牌决策", text: "根据公开下注复盘。" }] }),
    );
    const message = prompt("reviewer");
    message.table!.view = null;
    message.table!.review = [{ number: 3, title: "关键手", view: view(), userDelta: -80 }];
    await h.runner.prompt(message);
    expect(toolNames(h.requests[0]!)).toEqual(["poker_review"]);
    expect(h.sent.find((m) => m.type === "poker_review")).toEqual({
      type: "poker_review",
      runId: "run-table",
      sessionId: "session-from-control",
      hands: [{ number: 3, title: "转牌决策", text: "根据公开下注复盘。" }],
    });
    expect(JSON.stringify(h.requests[0]?.messages)).toContain("-80");
    expect(JSON.stringify(h.requests[0]?.messages)).toContain("poker_review 一次");
  });

  it("say 超 40 字时工具报中文错误", async () => {
    const h = await harness((request) =>
      request.messages.some((m) => m.role === "tool") || !toolNames(request).includes("poker_act")
        ? finish
        : call("long-say", "poker_act", { action: "fold", say: "长".repeat(41) }),
    );
    await h.runner.prompt(prompt());
    expect(h.sent.filter((m) => m.type === "poker_act")).toEqual([]);
    expect(JSON.stringify(h.requests[1]?.messages.filter((m) => m.role === "tool"))).toContain("台词最多 40 字");
  });

  it("牌友跨手续同一份会话，跨桌不共享，角色切换后只有对应工具", async () => {
    const h = await harness();
    await h.runner.prompt(prompt());
    await h.runner.prompt(prompt("player", { runId: RunId.parse("run-second"), messageId: MessageId.parse("second") }));
    expect(h.requests[1]?.messages.filter((m) => m.role === "user")).toHaveLength(2);
    await h.runner.prompt(
      prompt("advisor", { runId: RunId.parse("run-advisor"), messageId: MessageId.parse("advisor") }),
    );
    expect(toolNames(h.requests[2]!)).toEqual([]);
    await h.runner.prompt(
      prompt("player", {
        runId: RunId.parse("run-other"),
        groupId: GroupId.parse("other-table"),
        messageId: MessageId.parse("other"),
      }),
    );
    expect(h.requests[3]?.messages.filter((m) => m.role === "user")).toHaveLength(1);
    const directory = join(h.dataDir, "bot-table", "sessions", "group-table", "table");
    const files = readdirSync(directory).filter((file) => file.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(directory, files[0]!), "utf8")).toContain("hand-from-control");
  });

  it("等待出牌回执时停机能收尾", async () => {
    let received!: () => void;
    const action = new Promise<void>((resolve) => {
      received = resolve;
    });
    const h = await harness(
      (request) =>
        !toolNames(request).includes("poker_act") ? finish : call("stop-act", "poker_act", { action: "fold" }),
      (message) => {
        if (message.type === "poker_act") received();
      },
    );
    const running = h.runner.prompt(prompt());
    expect(await Promise.race([action.then(() => true), running.then(() => false)])).toBe(true);
    await h.runner.stop();
    await running;
    expect(h.runner.activeRuns()).toEqual([]);
    expect(h.sent.filter((m) => m.type === "run_done")).toHaveLength(1);
  });

  it("普通群会话的秘密不会被牌桌会话续入", async () => {
    const h = await harness();
    await h.runner.prompt(prompt("player", { table: null, origin: { kind: "user" }, text: "普通群独有秘密 As Kd" }));
    await h.runner.prompt(
      prompt("player", { runId: RunId.parse("run-after-chat"), messageId: MessageId.parse("after-chat") }),
    );
    const text = JSON.stringify(h.requests[1]?.messages);
    expect(text).toContain("8c");
    for (const secret of ["普通群独有秘密", "秘密任务卡", "秘密成员名单", "群历史秘密"])
      expect(text).not.toContain(secret);
    expect(toolNames(h.requests[1]!)).toEqual(["poker_act"]);
  });

  it("reviewer 不能增加关键手，修正后可交，交完不能再交", async () => {
    const h = await harness((request) => {
      const count = request.messages.filter((m) => m.role === "tool").length;
      return count >= 3
        ? finish
        : call(`review-${count}`, "poker_review", {
            hands: [{ number: count === 0 ? 99 : 3, title: "复盘", text: "公开信息" }],
          });
    });
    const message = prompt("reviewer");
    message.table!.review = [{ number: 3, title: "关键手", view: view(), userDelta: 80 }];
    await h.runner.prompt(message);
    expect(h.sent.filter((m) => m.type === "poker_review")).toHaveLength(1);
    expect(JSON.stringify(h.requests[1]?.messages)).toContain("不得遗漏或增加手序号");
    expect(JSON.stringify(h.requests[3]?.messages)).toContain("本次复盘已经提交");
  });

  it.each(["fold", "check", "call", "all_in"])("poker_act 的 %s 不附带加注金额，40 字台词通过", async (action) => {
    const h = await harness(
      (request) =>
        request.messages.some((m) => m.role === "tool")
          ? finish
          : call("act-boundary", "poker_act", { action, say: "短".repeat(40) }),
      (message, runner) => {
        if (message.type === "poker_act") runner.pokerResult(message.runId, message.callId, { ok: true });
      },
    );
    await h.runner.prompt(prompt());
    expect(h.sent.find((m) => m.type === "poker_act")).toMatchObject({
      action: { kind: action },
      say: "短".repeat(40),
    });
    expect(h.requests).toHaveLength(2);
  });

  it.each<[PokerPersona, string]>([
    ["leopard", "爱加注"],
    ["old_k", "紧凶"],
    ["jasmine", "爱诈唬"],
    ["dalu", "松弱"],
    ["xiaoqi", "新手"],
    ["laobai", "解说"],
  ])("%s 人设只影响风格，牌力来自给定视图", (preset, style) => {
    const text = tablePersona(preset);
    expect(text).toContain(style);
    expect(text).toContain("不自行计算牌力");
    expect(text).not.toMatch(/\b[2-9TJQKA][shdc]\b/);
  });

  it("回执忽略错 run、错 call，并区分跨 run 重复的 callId", async () => {
    const results = createPokerResults(() => {});
    const states: string[] = [];
    const first = results.ask(actionMessage("run-a"), BotId.parse("bot-a"), undefined).then(() => states.push("a"));
    const second = results.ask(actionMessage("run-b"), BotId.parse("bot-b"), undefined).then(() => states.push("b"));
    results.settle(RunId.parse("wrong"), "same-call", { ok: true });
    results.settle(RunId.parse("run-a"), "wrong-call", { ok: true });
    await Promise.resolve();
    expect(states).toEqual([]);
    results.settle(RunId.parse("run-a"), "same-call", { ok: true });
    await first;
    expect(states).toEqual(["a"]);
    results.settle(RunId.parse("run-b"), "same-call", { ok: true });
    await second;
    expect(states).toEqual(["a", "b"]);
  });
});

it("运行器等回执超时后同一 Bot 的下一个 prompt 能照常执行", async () => {
  const actualSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, timeout, ...args) =>
    actualSetTimeout(handler, timeout === 65_000 ? 10 : timeout, ...args),
  );
  const h = await harness((request) =>
    request.messages.some((message) => message.role === "tool")
      ? finish
      : call("timeout-call", "poker_act", { action: "call" }),
  );
  const first = h.runner.prompt(prompt());
  const second = h.runner.prompt(
    prompt("player", { runId: RunId.parse("run-after-timeout"), messageId: MessageId.parse("after-timeout") }),
  );
  await Promise.all([first, second]);
  expect(h.sent.filter((message) => message.type === "run_done").map((message) => message.runId)).toEqual([
    "run-table",
    "run-after-timeout",
  ]);
  expect(
    JSON.stringify(h.requests.flatMap((request) => request.messages.filter((message) => message.role === "tool"))),
  ).toContain("出牌确认超时");
}, 10_000);
it("出牌回执超时清理等待，晚到的同 call 回执不串到另一 run", async () => {
  vi.useFakeTimers();
  const results = createPokerResults(() => {});
  const first = results.ask(actionMessage("expired"), BotId.parse("bot-a"), undefined);
  const rejected = expect(first).rejects.toThrow("出牌确认超时");
  await vi.advanceTimersByTimeAsync(65_000);
  await rejected;
  const second = results.ask(actionMessage("next"), BotId.parse("bot-a"), undefined);
  results.settle(RunId.parse("expired"), "same-call", { ok: true });
  expect(vi.getTimerCount()).toBe(1);
  results.settle(RunId.parse("next"), "same-call", { ok: true });
  await second;
  expect(vi.getTimerCount()).toBe(0);
}, 10_000);
