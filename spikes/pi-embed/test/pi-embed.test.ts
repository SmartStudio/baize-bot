import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentToControl } from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApprovalGate, startApprovalGate } from "../src/approval.js";
import { type BotSession, createBotSession } from "../src/bot-session.js";
import { type Gateway, resolveUpstream, startGateway } from "../src/gateway.js";
import { GATEWAY_MODEL_ID } from "../src/bot-session.js";
import { type ChatCompletionRequest, isFollowUpTurn, type ScriptedTurn, scriptedUpstream } from "../src/openai-sse.js";
import { recordRun } from "../src/reporter.js";

const KEY_A = "key-bot-a";
const KEY_B = "key-bot-b";

const SCRIPT: Record<string, { first: ScriptedTurn; follow: ScriptedTurn }> = {
  [KEY_A]: {
    first: {
      textChunks: ["小陈，", "这就给客户发邮件。"],
      toolCall: {
        id: "call-a-1",
        name: "send_email",
        args: { to: "kehu@example.com", subject: "报价", body: "见附件" },
      },
      usage: { input: 1200, output: 64 },
    },
    follow: { textChunks: [], usage: { input: 1500, output: 12 } },
  },
  [KEY_B]: {
    first: {
      textChunks: ["先看看目录。"],
      toolCall: { id: "call-b-1", name: "list_files", args: { dir: "/work" } },
      usage: { input: 800, output: 40 },
    },
    follow: { textChunks: [], usage: { input: 900, output: 8 } },
  },
};

const script = (req: ChatCompletionRequest, key: string): ScriptedTurn => {
  const entry = SCRIPT[key];
  if (!entry) throw new Error(`假上游没有这个 key 的脚本：${key}`);
  return isFollowUpTurn(req) ? entry.follow : entry.first;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 外部审批人：等 send_email 挂起，然后通过 HTTP 拒绝它。 */
async function rejectSendEmail(gate: ApprovalGate): Promise<string> {
  for (let i = 0; i < 400; i++) {
    const pending = (await (await fetch(`${gate.baseUrl}/approvals`)).json()) as Array<{
      callId: string;
      tool: string;
    }>;
    const target = pending.find((p) => p.tool === "send_email");
    if (target) {
      await fetch(`${gate.baseUrl}/approvals/${encodeURIComponent(target.callId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approved: false, reason: "这封邮件先别发" }),
      });
      return target.callId;
    }
    await sleep(25);
  }
  throw new Error("没有等到 send_email 的审批请求");
}

const headerOf = (file: string): { type: string; cwd?: string } =>
  JSON.parse((readFileSync(file, "utf8").split("\n")[0] ?? "").trim()) as { type: string; cwd?: string };

const doneOf = (report: AgentToControl[]): { inputTokens: number; outputTokens: number } => {
  const done = report.at(-1);
  if (done?.type !== "run_done") throw new Error("最后一条不是 run_done");
  return { inputTokens: done.inputTokens, outputTokens: done.outputTokens };
};

describe("Pi SDK 嵌入验证", () => {
  let root: string;
  let gateway: Gateway;
  let approvals: ApprovalGate;
  let botA: BotSession;
  let botB: BotSession;
  let sideEffectsA: string[];
  let sideEffectsB: string[];
  let reportA: AgentToControl[];
  let reportB: AgentToControl[];
  let rejectedCallId: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "baize-pi-embed-"));
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;

    gateway = await startGateway({
      upstream: resolveUpstream(scriptedUpstream(script)),
      models: [{ id: GATEWAY_MODEL_ID }],
    });
    approvals = await startApprovalGate();

    sideEffectsA = [];
    sideEffectsB = [];
    const make = async (botId: string, key: string, sideEffects: string[]): Promise<BotSession> => {
      const cwd = join(root, botId, "work");
      const sessionDir = join(root, botId, "sessions");
      mkdirSync(cwd, { recursive: true });
      mkdirSync(sessionDir, { recursive: true });
      return createBotSession({
        botId,
        cwd,
        sessionDir,
        agentDir,
        gatewayBaseUrl: gateway.baseUrl,
        gatewayApiKey: key,
        approvals,
        needsApproval: (tool) => tool === "send_email",
        sideEffects,
      });
    };
    botA = await make("bot-a", KEY_A, sideEffectsA);
    botB = await make("bot-b", KEY_B, sideEffectsB);

    const runA = recordRun(
      botA.session,
      { runId: "run-a", botId: "bot-a", groupId: "group-a", messageId: "msg-a" },
      approvals.blockedCallIds,
    );
    const runB = recordRun(
      botB.session,
      { runId: "run-b", botId: "bot-b", groupId: "group-b", messageId: "msg-b" },
      approvals.blockedCallIds,
    );

    const [, , callId] = await Promise.all([
      botA.session.prompt("给客户发报价邮件"),
      botB.session.prompt("看看工作目录里有什么"),
      rejectSendEmail(approvals),
    ]);
    rejectedCallId = callId;
    runA.unsubscribe();
    runB.unsubscribe();
    reportA = runA.messages;
    reportB = runB.messages;
  });

  afterAll(async () => {
    botA?.dispose();
    botB?.dispose();
    await gateway?.close();
    await approvals?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("a. 两个 AgentSession 同时跑，cwd 和会话文件各自独立", () => {
    expect(botA.session.sessionManager.getCwd()).not.toBe(botB.session.sessionManager.getCwd());
    expect(botA.session.sessionManager.getCwd()).toBe(join(root, "bot-a", "work"));
    expect(botB.session.sessionManager.getCwd()).toBe(join(root, "bot-b", "work"));

    const fileA = botA.session.sessionManager.getSessionFile();
    const fileB = botB.session.sessionManager.getSessionFile();
    expect(fileA).toBeDefined();
    expect(fileB).toBeDefined();
    expect(fileA).not.toBe(fileB);
    expect(fileA?.startsWith(join(root, "bot-a", "sessions"))).toBe(true);
    expect(fileB?.startsWith(join(root, "bot-b", "sessions"))).toBe(true);
    expect(existsSync(fileA as string)).toBe(true);
    expect(existsSync(fileB as string)).toBe(true);

    expect(headerOf(fileA as string).cwd).toBe(join(root, "bot-a", "work"));
    expect(headerOf(fileB as string).cwd).toBe(join(root, "bot-b", "work"));
    expect(readFileSync(fileA as string, "utf8").includes("send_email")).toBe(true);
    expect(readFileSync(fileB as string, "utf8").includes("list_files")).toBe(true);
  });

  it("b. send_email 被 HTTP 拒绝后 block，函数体没执行；同时 list_files 正常完成", () => {
    expect(approvals.blockedCallIds.has(rejectedCallId)).toBe(true);
    expect(sideEffectsA).toEqual([]);
    expect(sideEffectsB).toEqual(["list_files:/work"]);

    const blocked = reportA.filter((m) => m.type === "bot_tool_call" && m.status === "blocked");
    expect(blocked).toHaveLength(1);
    const okCalls = reportB.filter((m) => m.type === "bot_tool_call" && m.status === "ok");
    expect(okCalls).toHaveLength(1);

    const refusal = botA.session.state.messages.find(
      (m): m is typeof m & { role: "toolResult" } => m.role === "toolResult" && m.toolCallId === rejectedCallId,
    );
    expect(refusal?.isError).toBe(true);
    expect(JSON.stringify(refusal?.content)).toContain("这封邮件先别发");
  });

  it("c. 网关按会话分开记 token，数字和假上游 usage 一致", () => {
    expect(gateway.totalsFor(KEY_A)).toEqual({ inputTokens: 1200 + 1500, outputTokens: 64 + 12 });
    expect(gateway.totalsFor(KEY_B)).toEqual({ inputTokens: 800 + 900, outputTokens: 40 + 8 });
    expect(gateway.usage.filter((u) => u.key === KEY_A)).toHaveLength(2);
    expect(gateway.usage.filter((u) => u.key === KEY_B)).toHaveLength(2);
    expect(gateway.usage.every((u) => u.model === GATEWAY_MODEL_ID)).toBe(true);

    expect(doneOf(reportA)).toEqual(gateway.totalsFor(KEY_A));
    expect(doneOf(reportB)).toEqual(gateway.totalsFor(KEY_B));
  });

  it("d. 报文序列是 bot_text 若干、bot_tool_call running 与终态、run_done", () => {
    for (const message of [...reportA, ...reportB]) {
      expect(() => AgentToControl.parse(message)).not.toThrow();
    }

    expect(reportA.map((m) => m.type)).toEqual([
      "bot_text",
      "bot_text",
      "bot_text",
      "bot_tool_call",
      "bot_tool_call",
      "run_done",
    ]);
    expect(reportA.slice(0, 3).map((m) => (m.type === "bot_text" ? { delta: m.delta, done: m.done } : null))).toEqual([
      { delta: "小陈，", done: false },
      { delta: "这就给客户发邮件。", done: false },
      { delta: "", done: true },
    ]);
    expect(
      reportA.filter((m) => m.type === "bot_tool_call").map((m) => (m.type === "bot_tool_call" ? m.status : null)),
    ).toEqual(["running", "blocked"]);

    expect(reportB.map((m) => m.type)).toEqual(["bot_text", "bot_text", "bot_tool_call", "bot_tool_call", "run_done"]);
    expect(
      reportB.filter((m) => m.type === "bot_tool_call").map((m) => (m.type === "bot_tool_call" ? m.status : null)),
    ).toEqual(["running", "ok"]);

    const doneA = reportA.at(-1);
    expect(doneA?.type).toBe("run_done");
    if (doneA?.type === "run_done") {
      expect(doneA.steps).toBe(2);
      expect(doneA.inputTokens).toBeGreaterThan(0);
    }
  });
});

// 自动重试默认开着（settings-manager.js:582 的 enabled ?? true）。上游一次 503 会让 Pi 重跑
// 这一轮，agent_end 因此发两遍，只有 agent_settled 是一次 prompt 一次。
describe("Pi SDK 嵌入验证 · 上游重试", () => {
  let root: string;
  let gateway: Gateway;
  let approvals: ApprovalGate;
  let bot: BotSession;
  let report: AgentToControl[];
  let agentEndCount = 0;
  let settledCount = 0;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "baize-pi-retry-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "work");
    const sessionDir = join(root, "sessions");
    for (const d of [agentDir, cwd, sessionDir]) mkdirSync(d, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const turn: ScriptedTurn = { textChunks: ["重试之后才说的话。"], usage: { input: 300, output: 9 } };
    gateway = await startGateway({
      upstream: scriptedUpstream(() => turn),
      models: [{ id: GATEWAY_MODEL_ID }],
      failFirst: 1,
    });
    approvals = await startApprovalGate();

    bot = await createBotSession({
      botId: "bot-retry",
      cwd,
      sessionDir,
      agentDir,
      gatewayBaseUrl: gateway.baseUrl,
      gatewayApiKey: "key-bot-retry",
      approvals,
      needsApproval: () => false,
      sideEffects: [],
      // provider.maxRetries 不设成 0 的话，503 会被供应商 SDK 自己那层重试吞掉，冒不到 Pi 这里。
      settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 10, provider: { maxRetries: 0 } } },
    });

    const unsubscribeProbe = bot.session.subscribe((event) => {
      if (event.type === "agent_end") agentEndCount += 1;
      if (event.type === "agent_settled") settledCount += 1;
    });
    const run = recordRun(bot.session, { runId: "run-r", botId: "bot-retry", groupId: "group-r", messageId: "msg-r" }, approvals.blockedCallIds);
    await bot.session.prompt("说句话");
    run.unsubscribe();
    unsubscribeProbe();
    report = run.messages;
  });

  afterAll(async () => {
    bot?.dispose();
    await gateway?.close();
    await approvals?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("e. 上游 503 触发一次重试，agent_end 发两遍而 run_done 只发一遍", () => {
    expect(gateway.requestCount()).toBe(2);
    expect(agentEndCount).toBe(2);
    expect(settledCount).toBe(1);

    expect(report.filter((m) => m.type === "run_done")).toHaveLength(1);
    expect(report.at(-1)?.type).toBe("run_done");
    expect(report.some((m) => m.type === "bot_text" && m.delta === "重试之后才说的话。")).toBe(true);
  });
});
