import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { AgentToControl, type BotId, ComputerId, MessageId, RunId, Skill } from "@baize/shared";
import { startAgent, type AgentHandle, type RunnerFactory } from "../src/agent.js";
import { backoffDelay, type BackoffOptions } from "../src/backoff.js";

// 假运行器。电脑代理这一层只管把报文派到运行器的接口上，真跑 Pi 在 @baize/bot-runner 的测试里。
interface RunnerCalls {
  readonly approvals: Array<{ runId: RunId; callId: string; approved: boolean }>;
  readonly activeRuns: RunId[];
  readonly paused: BotId[];
  readonly resumed: BotId[];
  /** 每次建运行器时拿到的 config.skills，原样记下，undefined 也记。 */
  readonly configSkills: Array<readonly Skill[] | undefined>;
}

function fakeRunner(calls: RunnerCalls): RunnerFactory {
  return (config) => {
    calls.configSkills.push(config.skills);
    return runnerOf(config, calls);
  };
}

function runnerOf(config: Parameters<RunnerFactory>[0], calls: RunnerCalls): ReturnType<RunnerFactory> {
  return {
    async prompt(message) {
      config.send({
        type: "bot_text",
        runId: message.runId,
        botId: message.botId,
        groupId: message.groupId,
        messageId: MessageId.parse(`msg-${message.runId}`),
        delta: "假运行器的回复。",
        done: true,
      });
    },
    approve: (runId, callId, approved) => {
      calls.approvals.push({ runId, callId, approved });
    },
    pause: async (botId) => {
      calls.paused.push(botId);
    },
    resume: async (botId) => {
      calls.resumed.push(botId);
    },
    activeRuns: () => calls.activeRuns,
    stop: async () => {},
  };
}

const configMessage = {
  type: "config",
  bots: [{ id: "bot-1", name: "小服", tag: "", description: "客服 Bot" }],
  tools: [],
  modelGateway: { baseUrl: "http://localhost:3001/model", apiKey: "dev-key", model: "dev-model" },
};

const promptMessage = {
  type: "prompt",
  runId: "run-1",
  botId: "bot-1",
  groupId: "group-1",
  text: "查一下昨天的订单",
  origin: { kind: "user" },
  reason: "solo",
  group: { id: "group-1", number: "", title: "小服", kind: "solo" },
  context: [],
  task: null,
  members: [{ id: "bot-1", name: "小服", tag: "", description: "客服 Bot", role: "member" }],
};

async function poll<T>(get: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等了 ${timeoutMs}ms 还没等到${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function startControlPlane() {
  const server = new WebSocketServer({ port: 0 });
  const sockets: WebSocket[] = [];
  const messages: AgentToControl[] = [];
  const parseErrors: string[] = [];

  let onConnection: ((socket: WebSocket) => void) | null = null;

  server.on("connection", (socket) => {
    sockets.push(socket);
    onConnection?.(socket);
    socket.on("message", (data) => {
      const parsed = AgentToControl.safeParse(JSON.parse(data.toString()));
      if (parsed.success) messages.push(parsed.data);
      else parseErrors.push(`${data.toString()} -> ${parsed.error.message}`);
    });
  });

  const listening = poll(() => server.address() ?? undefined, 3000, "服务端监听");

  return {
    async url(): Promise<string> {
      const address = (await listening) as AddressInfo;
      return `ws://127.0.0.1:${address.port}/agent`;
    },
    sockets,
    messages,
    onConnection(hook: (socket: WebSocket) => void) {
      onConnection = hook;
    },
    async waitForMessage<T extends AgentToControl["type"]>(
      type: T,
      nth = 1,
      timeoutMs = 3000,
    ): Promise<Extract<AgentToControl, { type: T }>> {
      const found = await poll(
        () => {
          if (parseErrors.length > 0) throw new Error(`代理发来的报文不合 AgentToControl：${parseErrors[0]}`);
          const matches = messages.filter((message) => message.type === type);
          return matches[nth - 1];
        },
        timeoutMs,
        `第 ${nth} 条 ${type}`,
      );
      return found as Extract<AgentToControl, { type: T }>;
    },
    waitForSocket(nth: number, timeoutMs = 5000): Promise<WebSocket> {
      return poll(() => sockets[nth - 1], timeoutMs, `第 ${nth} 条连接`);
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

type ControlPlane = ReturnType<typeof startControlPlane>;

const agents: AgentHandle[] = [];
const servers: ControlPlane[] = [];
const runnerCallsLog: RunnerCalls[] = [];

/** 最近一个 spawnAgent 建出来的代理记下的运行器调用。 */
const runnerCalls = (): RunnerCalls => {
  const last = runnerCallsLog.at(-1);
  if (last === undefined) throw new Error("还没有 spawnAgent 过");
  return last;
};

function spawnAgent(url: string, tuning: { heartbeatMs?: number; backoff?: BackoffOptions } = {}): AgentHandle {
  const calls: RunnerCalls = { approvals: [], activeRuns: [], paused: [], resumed: [], configSkills: [] };
  runnerCallsLog.push(calls);
  const handle = startAgent({
    url,
    computerId: ComputerId.parse("computer-1"),
    token: "dev-token",
    version: "0.1.0",
    log: () => {},
    makeRunner: fakeRunner(calls),
    ...tuning,
  });
  agents.push(handle);
  return handle;
}

async function startPair(tuning: { heartbeatMs?: number; backoff?: BackoffOptions } = {}) {
  const server = startControlPlane();
  servers.push(server);
  spawnAgent(await server.url(), tuning);
  return server;
}

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.stop()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  runnerCallsLog.splice(0);
});

describe("电脑代理连控制面", () => {
  it("连上后 3 秒内发出 hello，且能 parse 通过 AgentToControl", async () => {
    const server = await startPair();

    const hello = await server.waitForMessage("hello", 1, 3000);

    expect(hello).toEqual({
      type: "hello",
      computerId: "computer-1",
      token: "dev-token",
      version: "0.1.0",
      activeRuns: [],
    });
  });

  it("重连 hello 报告运行器仍活着的 run", async () => {
    const server = await startPair();
    const first = await server.waitForSocket(1);
    await server.waitForMessage("hello", 1, 3000);

    first.send(JSON.stringify(configMessage));
    await poll(() => (runnerCalls().configSkills.length === 1 ? true : undefined), 3000, "运行器建好");
    runnerCalls().activeRuns.push(RunId.parse("run-1"));

    first.terminate();
    await server.waitForSocket(2, 5000);
    const hello = await server.waitForMessage("hello", 2, 5000);

    expect(hello.activeRuns).toEqual(["run-1"]);
  });

  it("旧运行器等待收尾时再次重连，hello 仍报告它的 run", async () => {
    const server = startControlPlane();
    servers.push(server);
    const calls: RunnerCalls = { approvals: [], activeRuns: [], paused: [], resumed: [], configSkills: [] };
    const runId = RunId.parse("run-1");
    let resolveStop: (() => void) | undefined;
    const stopGate = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    let created = 0;
    agents.push(
      startAgent({
        url: await server.url(),
        computerId: ComputerId.parse("computer-1"),
        token: "dev-token",
        version: "0.1.0",
        log: () => {},
        makeRunner: (config) => {
          created += 1;
          const fake = runnerOf(config, calls);
          return created === 1 ? { ...fake, activeRuns: () => [runId], stop: () => stopGate } : fake;
        },
      }),
    );

    try {
      const first = await server.waitForSocket(1);
      await server.waitForMessage("hello", 1);
      first.send(JSON.stringify(configMessage));
      await poll(() => (created === 1 ? true : undefined), 3000, "首个运行器建好");
      first.terminate();

      const second = await server.waitForSocket(2);
      expect((await server.waitForMessage("hello", 2)).activeRuns).toEqual([runId]);
      second.send(JSON.stringify(configMessage));
      await poll(() => (created === 2 ? true : undefined), 3000, "新运行器建好");
      second.terminate();

      await server.waitForSocket(3);
      expect((await server.waitForMessage("hello", 3)).activeRuns).toEqual([runId]);
    } finally {
      resolveStop?.();
    }
  });

  it("连上后按间隔发心跳", async () => {
    const server = await startPair({ heartbeatMs: 50 });

    const second = await server.waitForMessage("heartbeat", 2, 3000);

    expect(Date.parse(second.at)).not.toBeNaN();
  });

  it("收到 config 再收到 prompt，回一条 done 的 bot_text", async () => {
    const server = await startPair();
    const socket = await server.waitForSocket(1);

    socket.send(JSON.stringify(configMessage));
    socket.send(JSON.stringify(promptMessage));

    const reply = await server.waitForMessage("bot_text", 1, 3000);
    expect(reply.done).toBe(true);
    expect(reply.delta.length).toBeGreaterThan(0);
    expect(reply.runId).toBe("run-1");
    expect(reply.botId).toBe("bot-1");
    expect(reply.groupId).toBe("group-1");
  });

  it("config 里的 skills 原样交给运行器，没带就是 undefined", async () => {
    const server = await startPair();
    const socket = await server.waitForSocket(1);
    const skill = Skill.parse({
      id: "skill-globex",
      botId: "bot-1",
      name: "Globex 报价",
      steps: ["建报价单", "生成 PDF"],
      source: "chat",
      useCount: 0,
      createdAt: "2026-09-19T00:00:00.000Z",
    });

    socket.send(JSON.stringify({ ...configMessage, skills: [skill] }));
    socket.send(JSON.stringify(configMessage));
    socket.send(JSON.stringify(promptMessage));

    await server.waitForMessage("bot_text", 1, 3000);
    expect(runnerCalls().configSkills).toEqual([[skill], undefined]);
  });

  it("还没收到 config 的 prompt 被丢弃，只有 config 之后的那条回 bot_text", async () => {
    const server = await startPair();
    const socket = await server.waitForSocket(1);

    socket.send(JSON.stringify({ ...promptMessage, runId: "run-早了" }));
    socket.send(JSON.stringify(configMessage));
    socket.send(JSON.stringify(promptMessage));

    // 报文有序，所以第一条 bot_text 若来自被丢弃的那条 prompt，runId 就会对不上。
    const reply = await server.waitForMessage("bot_text", 1, 3000);
    expect(reply.runId).toBe("run-1");
    expect(server.messages.filter((message) => message.type === "bot_text")).toHaveLength(1);
  });

  it("坏报文只被丢弃，不拖垮连接", async () => {
    const server = await startPair();
    const socket = await server.waitForSocket(1);

    socket.send("这不是 JSON");
    socket.send(JSON.stringify({ type: "没这种报文" }));
    socket.send(JSON.stringify({ type: "prompt", runId: "run-1" }));
    socket.send(JSON.stringify(configMessage));
    socket.send(JSON.stringify(promptMessage));

    const reply = await server.waitForMessage("bot_text", 1, 3000);
    expect(reply.done).toBe(true);
  });

  it("approval_result 报文到达后调用运行器的 approve", async () => {
    const server = await startPair();
    const socket = await server.waitForSocket(1);

    socket.send(JSON.stringify(configMessage));
    socket.send(JSON.stringify({ type: "approval_result", runId: "run-1", callId: "call-1", approved: false }));
    socket.send(JSON.stringify(promptMessage));

    // 报文有序，等到 prompt 的回复就说明前面那条也处理完了。
    await server.waitForMessage("bot_text", 1, 3000);
    expect(runnerCalls().approvals).toEqual([{ runId: "run-1", callId: "call-1", approved: false }]);
  });

  it("prompt 等审批时仍派发后续 approval_result，让这次 run 收尾", async () => {
    const server = startControlPlane();
    servers.push(server);
    let started = false;
    let release: (() => void) | undefined;
    const decision = new Promise<void>((resolve) => {
      release = resolve;
    });
    const approvals: Array<{ runId: RunId; callId: string; approved: boolean }> = [];
    agents.push(
      startAgent({
        url: await server.url(),
        computerId: ComputerId.parse("computer-1"),
        token: "dev-token",
        version: "0.1.0",
        log: () => {},
        makeRunner: (config) => ({
          prompt: async (message) => {
            started = true;
            await decision;
            config.send({
              type: "run_done",
              runId: message.runId,
              botId: message.botId,
              groupId: message.groupId,
              steps: 1,
              inputTokens: 1,
              outputTokens: 1,
            });
          },
          approve: (runId, callId, approved) => {
            approvals.push({ runId, callId, approved });
            if (runId === "run-1" && callId === "call-1" && approved) release?.();
          },
          pause: async () => {},
          resume: async () => {},
          activeRuns: () => [],
          stop: async () => {},
        }),
      }),
    );

    try {
      const socket = await server.waitForSocket(1);
      socket.send(JSON.stringify(configMessage));
      socket.send(JSON.stringify(promptMessage));
      await poll(() => (started ? true : undefined), 3000, "运行器开始等待审批");
      socket.send(JSON.stringify({ type: "approval_result", runId: "run-1", callId: "call-1", approved: true }));

      const done = await server.waitForMessage("run_done", 1, 3000);
      expect(done.runId).toBe("run-1");
      expect(approvals).toEqual([{ runId: "run-1", callId: "call-1", approved: true }]);
    } finally {
      release?.();
    }
  });

  it("config 之前到的 approval_result 被丢弃，不会在建好运行器后补发", async () => {
    const server = await startPair();
    const socket = await server.waitForSocket(1);

    socket.send(JSON.stringify({ type: "approval_result", runId: "run-早了", callId: "call-1", approved: true }));
    socket.send(JSON.stringify(configMessage));
    socket.send(JSON.stringify(promptMessage));

    await server.waitForMessage("bot_text", 1, 3000);
    expect(runnerCalls().approvals).toEqual([]);
  });

  it("pause 和 resume 报文到达后按顺序调用运行器的 pause 和 resume", async () => {
    const server = await startPair();
    const socket = await server.waitForSocket(1);

    socket.send(JSON.stringify(configMessage));
    socket.send(JSON.stringify({ type: "pause", botId: "bot-1" }));
    socket.send(JSON.stringify({ type: "resume", botId: "bot-1" }));
    socket.send(JSON.stringify(promptMessage));

    await server.waitForMessage("bot_text", 1, 3000);
    expect(runnerCalls().paused).toEqual(["bot-1"]);
    expect(runnerCalls().resumed).toEqual(["bot-1"]);
  });

  it("连接断开后按默认退避重连，5 秒内重新 hello", async () => {
    const server = await startPair();
    const first = await server.waitForSocket(1);
    await server.waitForMessage("hello", 1, 3000);

    const brokenAt = Date.now();
    first.terminate();

    await server.waitForSocket(2, 5000);
    await server.waitForMessage("hello", 2, 5000);
    expect(Date.now() - brokenAt).toBeLessThan(5000);
  }, 15_000);

  it("控制面连上就踢且不发 welcome 时，重连间隔逐次拉大", async () => {
    const server = startControlPlane();
    servers.push(server);
    const closedAt: number[] = [];
    server.onConnection((socket) => {
      closedAt.push(Date.now());
      socket.close();
    });
    spawnAgent(await server.url(), { backoff: { initialMs: 100, maxMs: 5000, factor: 2 } });

    await poll(() => (closedAt.length >= 4 ? closedAt.length : undefined), 5000, "第 4 次连接");

    const gaps = closedAt.slice(1).map((at, index) => at - (closedAt[index] ?? 0));
    expect(gaps[1], `间隔应逐次拉大，实际 ${gaps.join("、")}`).toBeGreaterThan(gaps[0] ?? 0);
    expect(gaps[2], `间隔应逐次拉大，实际 ${gaps.join("、")}`).toBeGreaterThan(gaps[1] ?? 0);
  }, 15_000);
});

describe("退避", () => {
  const options: BackoffOptions = { initialMs: 500, maxMs: 30_000, factor: 2 };

  it("第一次等 initialMs，之后按 factor 翻倍", () => {
    expect(backoffDelay(0, options)).toBe(500);
    expect(backoffDelay(1, options)).toBe(1000);
    expect(backoffDelay(2, options)).toBe(2000);
  });

  it("封顶在 maxMs", () => {
    expect(backoffDelay(20, options)).toBe(30_000);
  });
});
