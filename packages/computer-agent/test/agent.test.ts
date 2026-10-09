import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { AgentToControl, BotId, ComputerId, GroupId, MessageId, RunId, Skill } from "@baize/shared";
import type { CdpConnection, RunnerConfig } from "@baize/bot-runner";
import {
  startAgent as startProductAgent,
  type AgentHandle,
  type AgentOptions,
  type AgentRunnerConfig,
  type RunnerFactory,
  RUN_DONE_REPLAY_LIMIT,
  UNACKED_RUN_DONE_LIMIT,
} from "../src/agent.js";
import { startAssistantChrome, type AssistantChrome, type BrowserLoginState } from "../src/chrome.js";
import { chromeProfileDir, profileChromePids, reapProfileChromes } from "../src/chrome-process.js";
import type { CdpPipe } from "@baize/bot-runner";
import { backoffDelay, type BackoffOptions } from "../src/backoff.js";

const fakeConnection: CdpConnection = {
  send: () => Promise.reject(new Error("假 Chrome 不接命令")),
  onEvent: () => () => undefined,
  isOpen: () => true,
};

const fakeChrome = (): AssistantChrome => ({
  kind: "local",
  profileDir: "/tmp/baize-test/chrome-profile",
  connection: async () => fakeConnection,
  login: async () => ({ login: "valid", handle: "白泽工厂日记" }),
  pid: () => null,
  stop: async () => {},
});
const initialRunnerConfigs: AgentRunnerConfig[] = [];

function startAgent(options: AgentOptions): AgentHandle {
  return startProductAgent({ ...options, makeChrome: options.makeChrome ?? fakeChrome });
}

// 假运行器。电脑代理这一层只管把报文派到运行器的接口上，真跑 Pi 在 @baize/bot-runner 的测试里。
interface RunnerCalls {
  readonly approvals: Array<{ runId: RunId; callId: string; approved: boolean }>;
  readonly activeRuns: RunId[];
  readonly paused: BotId[];
  readonly resumed: BotId[];
  readonly prompts: RunId[];
  /** 运行器拿到的每条 prompt 的 context，parse 之后的样子。 */
  readonly promptContexts: Array<Parameters<ReturnType<RunnerFactory>["prompt"]>[0]["context"]>;
  /** 每次建运行器时拿到的 config.skills，原样记下，undefined 也记。 */
  readonly configSkills: Array<readonly Skill[] | undefined>;
  /** 已有运行器收到的配置更新，原样记下。 */
  readonly appliedConfigs: RunnerConfig[];
}

function fakeRunner(calls: RunnerCalls): RunnerFactory {
  return (config) => {
    initialRunnerConfigs.push(config);
    calls.configSkills.push(config.skills);
    return runnerOf(config, calls);
  };
}

function runnerOf(
  config: Parameters<RunnerFactory>[0],
  calls: RunnerCalls,
  applyConfigDone: Promise<void> = Promise.resolve(),
): ReturnType<RunnerFactory> {
  return {
    async applyConfig(nextConfig) {
      calls.appliedConfigs.push(nextConfig);
      await applyConfigDone;
    },
    async prompt(message) {
      calls.prompts.push(message.runId);
      calls.promptContexts.push(message.context);
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
  generation: 1,
  bots: [{ id: "bot-1", role: "member", name: "小服", tag: "", description: "客服 Bot" }],
  tools: [],
  accounts: [],
  grants: [],
  modelGateway: { baseUrl: "http://localhost:3001/model", apiKey: "dev-key" },
  accountsProxy: { baseUrl: "http://localhost:3001/accounts-proxy" },
};

const promptMessage = {
  type: "prompt",
  runId: "run-1",
  botId: "bot-1",
  groupId: "group-1",
  messageId: "message-1",
  text: "查一下昨天的订单",
  origin: { kind: "user" },
  reason: "solo",
  group: { id: "group-1", number: "", title: "小服", kind: "solo" },
  context: [],
  purpose: "plan",
  task: null,
  members: [{ id: "bot-1", name: "小服", tag: "", description: "客服 Bot", seat: "member" }],
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

/**
 * 假的助理 Chrome 管道：只回发布器前几步用到的 CDP 命令，页面永远停在小红书登录页。
 * 发布器真用上这台电脑的浏览器，就会撞到登录页回 login_expired。
 */
function startLoginWallPipe(): { readonly pipe: CdpPipe; commands(): string[] } {
  const toChrome = new PassThrough();
  const fromChrome = new PassThrough();
  const commands: string[] = [];
  let buffered = "";
  toChrome.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (let end = buffered.indexOf("\0"); end !== -1; end = buffered.indexOf("\0")) {
      const { id, method, params } = JSON.parse(buffered.slice(0, end)) as {
        id: number;
        method: string;
        params: { expression?: string };
      };
      buffered = buffered.slice(end + 1);
      commands.push(method);
      const result =
        method === "Target.createTarget"
          ? { targetId: "tab-1" }
          : method === "Target.attachToTarget"
            ? { sessionId: "session-1" }
            : method === "Runtime.evaluate" && params.expression === "location.href"
              ? { result: { type: "string", value: "https://creator.xiaohongshu.com/login?redirectReason=401" } }
              : method === "Runtime.evaluate"
                ? { result: { type: "object", subtype: "null", value: null } }
                : {};
      fromChrome.write(`${JSON.stringify({ id, result })}\0`);
    }
  });
  return { pipe: { toChrome, fromChrome }, commands: () => [...commands] };
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

function spawnAgent(
  url: string,
  tuning: Partial<
    Pick<AgentOptions, "heartbeatMs" | "backoff" | "makeRunner" | "makeChrome" | "loginTimeoutMs" | "dataDir" | "log">
  > = {},
): AgentHandle {
  const calls: RunnerCalls = {
    approvals: [],
    activeRuns: [],
    paused: [],
    resumed: [],
    prompts: [],
    promptContexts: [],
    configSkills: [],
    appliedConfigs: [],
  };
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

const dataDirs: string[] = [];

async function tempDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "baize-agent-test-"));
  dataDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.stop()));
  await Promise.all(dataDirs.map((directory) => reapProfileChromes(chromeProfileDir(directory))));
  await Promise.all(dataDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  runnerCallsLog.splice(0);
  initialRunnerConfigs.splice(0);
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

  it("第二条 config 不重建运行器，改为交给 applyConfig", async () => {
    let releaseApplyConfig: (() => void) | undefined;
    const applyConfigDone = new Promise<void>((resolve) => {
      releaseApplyConfig = resolve;
    });
    const server = startControlPlane();
    servers.push(server);
    spawnAgent(await server.url(), {
      makeRunner: (config) => {
        runnerCalls().configSkills.push(config.skills);
        return runnerOf(config, runnerCalls(), applyConfigDone);
      },
    });
    const socket = await server.waitForSocket(1);
    const secondConfig = {
      ...configMessage,
      generation: 2,
      bots: [{ id: "bot-1", role: "member", name: "新版小服", tag: "", description: "新版客服 Bot" }],
    };

    try {
      socket.send(JSON.stringify(configMessage));
      await poll(() => (runnerCalls().configSkills.length === 1 ? true : undefined), 3000, "首个运行器建好");
      socket.send(JSON.stringify(secondConfig));
      socket.send(JSON.stringify(promptMessage));

      await poll(
        () => (runnerCalls().appliedConfigs.length === 1 ? true : undefined),
        3000,
        "第二条 config 进入 applyConfig",
      );
      expect(runnerCalls().prompts).toEqual([]);

      releaseApplyConfig?.();
      await poll(() => (runnerCalls().prompts.length === 1 ? true : undefined), 3000, "applyConfig 完成后的 prompt");
      await server.waitForMessage("bot_text", 1, 3000);
      expect(runnerCalls().configSkills).toHaveLength(1);
      expect(runnerCalls().appliedConfigs).toHaveLength(1);
      expect(runnerCalls().appliedConfigs[0]?.bots[0]?.name).toBe("新版小服");
    } finally {
      releaseApplyConfig?.();
    }
  });

  it("把 Chrome profile 和管道连接交给运行器", async () => {
    const server = await startPair();
    const socket = await server.waitForSocket(1);

    socket.send(JSON.stringify(configMessage));
    await poll(() => initialRunnerConfigs[0], 3000, "运行器配置");

    expect(initialRunnerConfigs[0]?.browser.profileDir).toBe("/tmp/baize-test/chrome-profile");
    await expect(initialRunnerConfigs[0]?.browser.connection()).resolves.toBe(fakeConnection);
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

  it("旧控制面发来的 context 行不带 settled，prompt 照样接住跑完，这些行按定稿交给运行器", async () => {
    const server = await startPair();
    const socket = await server.waitForSocket(1);

    socket.send(JSON.stringify(configMessage));
    socket.send(
      JSON.stringify({ ...promptMessage, context: [{ messageId: "message-0", from: "用户", text: "昨天那单呢" }] }),
    );

    const reply = await server.waitForMessage("bot_text", 1, 3000);
    expect(reply.runId, "没被当坏报文丢掉").toBe("run-1");
    expect(runnerCalls().promptContexts, "缺省的 settled 当定稿").toEqual([
      [{ messageId: "message-0", from: "用户", text: "昨天那单呢", settled: true }],
    ]);
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
    socket.send(JSON.stringify({ ...configMessage, generation: 2 }));
    socket.send(JSON.stringify(promptMessage));

    await server.waitForMessage("bot_text", 1, 3000);
    expect(runnerCalls().configSkills).toEqual([[skill]]);
    expect(runnerCalls().appliedConfigs.map((config) => config.skills)).toEqual([undefined]);
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
    expect(
      server.messages.filter((message) => message.type === "agent_error"),
      "报错带上 runId，控制面才知道替哪个 run 收尾",
    ).toEqual([
      {
        type: "agent_error",
        code: "prompt_before_config",
        detail: "run run-早了 的 prompt 比 config 先到",
        groupId: "group-1",
        runId: "run-早了",
      },
    ]);
  });

  it("旧控制面发来缺 accountsProxy 的 config：回 config_rejected 带字段路径、不建运行器，下一条合格的 config 建好后回 config_applied", async () => {
    const server = await startPair();
    const socket = await server.waitForSocket(1);
    const { accountsProxy: _dropped, ...oldConfig } = configMessage;

    socket.send(JSON.stringify(oldConfig));
    socket.send(JSON.stringify(promptMessage));
    const rejected = await server.waitForMessage("agent_error", 1, 3000);
    expect(rejected, "被拒的 config 要报给控制面，detail 写校验不过的字段路径，generation 说明拒的是哪一代").toEqual({
      type: "agent_error",
      code: "config_rejected",
      generation: 1,
      detail: "config 不合这个电脑代理的版本，校验不过的字段：accountsProxy",
    });
    expect(
      (await server.waitForMessage("agent_error", 2, 3000)).code,
      "没建运行器，后面的 prompt 照旧丢掉并报给控制面",
    ).toBe("prompt_before_config");
    expect(runnerCalls().configSkills, "旧 config 不建运行器").toEqual([]);
    expect(server.messages.filter((message) => message.type === "config_applied")).toEqual([]);

    socket.send(JSON.stringify(configMessage));
    expect(await server.waitForMessage("config_applied", 1, 3000)).toEqual({ type: "config_applied", generation: 1 });
    expect(runnerCalls().configSkills, "合格的 config 建出运行器").toHaveLength(1);
  });

  it("代际比已应用的旧的 config 丢掉不回执；回执带上这条 config 的代际；重连后代际从头算", async () => {
    const server = await startPair();
    const socket = await server.waitForSocket(1);
    const named = (generation: number, name: string) => ({
      ...configMessage,
      generation,
      bots: [{ id: "bot-1", role: "member", name, tag: "", description: "客服 Bot" }],
    });

    socket.send(JSON.stringify(named(2, "第二代")));
    expect(await server.waitForMessage("config_applied", 1, 3000), "回执说的是收下了哪一代").toEqual({
      type: "config_applied",
      generation: 2,
    });
    // 控制面并发重发时，先开始读快照的那条可能后到：它的代际更小，里面的账号状态是旧的。
    socket.send(JSON.stringify(named(1, "第一代")));
    socket.send(JSON.stringify(named(3, "第三代")));
    expect(await server.waitForMessage("config_applied", 2, 3000)).toEqual({ type: "config_applied", generation: 3 });
    expect(
      runnerCalls().appliedConfigs.map((config) => config.bots[0]?.name),
      "第一代比已应用的第二代旧，不交给运行器",
    ).toEqual(["第三代"]);
    expect(server.messages.filter((message) => message.type === "config_applied")).toHaveLength(2);

    const { accountsProxy: _dropped, ...oldShape } = named(4, "第四代");
    socket.send(JSON.stringify(oldShape));
    expect((await server.waitForMessage("agent_error", 1, 3000)).generation, "拒收也说清拒的是哪一代").toBe(4);

    socket.terminate();
    const second = await server.waitForSocket(2, 5000);
    await server.waitForMessage("hello", 2, 5000);
    second.send(JSON.stringify(named(1, "重连后的第一代")));
    expect(await server.waitForMessage("config_applied", 3, 3000), "代际按连接算，新连接的第一代不算旧").toEqual({
      type: "config_applied",
      generation: 1,
    });
    expect(runnerCalls().appliedConfigs.map((config) => config.bots[0]?.name)).toEqual(["第三代", "重连后的第一代"]);
  });

  it("旧连接的 config 还在 applyConfig 里时重连：它做完不更新代际、不经新连接回执，新连接的第一代照常生效", async () => {
    let releaseApplyConfig!: () => void;
    const applyConfigDone = new Promise<void>((resolve) => {
      releaseApplyConfig = resolve;
    });
    const server = startControlPlane();
    servers.push(server);
    spawnAgent(await server.url(), {
      backoff: { initialMs: 50, maxMs: 50, factor: 1 },
      makeRunner: (config) => runnerOf(config, runnerCalls(), applyConfigDone),
    });
    const named = (generation: number, name: string) => ({
      ...configMessage,
      generation,
      bots: [{ id: "bot-1", role: "member", name, tag: "", description: "客服 Bot" }],
    });
    const first = await server.waitForSocket(1);
    first.send(JSON.stringify(named(1, "第一条连接的第一代")));
    await server.waitForMessage("config_applied", 1, 3000);

    first.send(JSON.stringify(named(7, "第一条连接的第七代")));
    await poll(() => (runnerCalls().appliedConfigs.length === 1 ? true : undefined), 3000, "旧连接进入 applyConfig");
    first.terminate();
    const second = await server.waitForSocket(2, 5000);
    await server.waitForMessage("hello", 2, 5000);
    second.send(JSON.stringify(named(1, "第二条连接的第一代")));
    releaseApplyConfig();

    expect(await server.waitForMessage("config_applied", 2, 3000), "新连接只确认自己的第一代").toEqual({
      type: "config_applied",
      generation: 1,
    });
    expect(
      server.messages.filter((message) => message.type === "config_applied"),
      "旧连接那一代做完了也不回执",
    ).toEqual([
      { type: "config_applied", generation: 1 },
      { type: "config_applied", generation: 1 },
    ]);
    expect(
      runnerCalls().appliedConfigs.map((config) => config.bots[0]?.name),
      "运行器最后停在新连接那份配置上",
    ).toEqual(["第一条连接的第七代", "第二条连接的第一代"]);
  });

  it("两条 config 背靠背到达、前一条的 applyConfig 卡住：后一条等它做完才进运行器，最终生效的是后一条", async () => {
    // 「旧不盖新」靠全局 inbox 串行：并发处理的话，后一代先做完、前一代卡住的晚做完，运行器会停在旧的那份上。
    // 改成并发处理时这条会红；到那时要改成按连接重放最新配置，不能只靠做完后核连接来源。
    let releaseSecond!: () => void;
    const secondBlocked = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const entered: string[] = [];
    const tookEffect: string[] = [];
    const server = startControlPlane();
    servers.push(server);
    spawnAgent(await server.url(), {
      makeRunner: (config) => ({
        ...runnerOf(config, runnerCalls()),
        applyConfig: async (next) => {
          const name = next.bots[0]?.name ?? "";
          entered.push(name);
          if (name === "第二代") await secondBlocked;
          tookEffect.push(name);
        },
      }),
    });
    const named = (generation: number, name: string) => ({
      ...configMessage,
      generation,
      bots: [{ id: "bot-1", role: "member", name, tag: "", description: "客服 Bot" }],
    });
    const socket = await server.waitForSocket(1);

    try {
      socket.send(JSON.stringify(named(1, "第一代")));
      await server.waitForMessage("config_applied", 1, 3000);

      socket.send(JSON.stringify(named(2, "第二代")));
      socket.send(JSON.stringify(named(3, "第三代")));
      // ws 按帧的顺序处理：ping 在第三代之后到，代理的 message 回调已经为第三代跑过，pong 才会回来。
      const ponged = new Promise<void>((resolve) => socket.once("pong", () => resolve()));
      socket.ping();
      await ponged;
      expect(entered, "第二代还卡着，第三代不能先进运行器").toEqual(["第二代"]);

      releaseSecond();
      await server.waitForMessage("config_applied", 3, 3000);
      expect(tookEffect, "先后生效，最后停在第三代上").toEqual(["第二代", "第三代"]);
      expect(
        server.messages.filter((message) => message.type === "config_applied").map((message) => message.generation),
      ).toEqual([1, 2, 3]);
    } finally {
      releaseSecond();
    }
  });

  it("已应用新代际后，晚到的旧代际 config 就算不合版本也按代际丢掉，不回 config_rejected", async () => {
    const server = await startPair();
    const socket = await server.waitForSocket(1);
    socket.send(JSON.stringify({ ...configMessage, generation: 3 }));
    await server.waitForMessage("config_applied", 1, 3000);

    const { accountsProxy: _dropped, ...staleOldShape } = { ...configMessage, generation: 2 };
    socket.send(JSON.stringify(staleOldShape));
    socket.send(JSON.stringify({ ...configMessage, generation: 4 }));
    await server.waitForMessage("config_applied", 2, 3000);

    expect(
      server.messages.filter((message) => message.type === "agent_error"),
      "旧代际先按代际丢，轮不到校验形状，控制面不会被旧拒收卡住",
    ).toEqual([]);
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

  it("收 browser_login 后回一条 login_state", async () => {
    const server = await startPair();
    const socket = await server.waitForSocket(1);

    socket.send(
      JSON.stringify({ type: "browser_login", accountId: "account-1", platform: "xiaohongshu", attempt: "try-1" }),
    );

    await expect(server.waitForMessage("login_state", 1, 500)).resolves.toEqual({
      type: "login_state",
      accountId: "account-1",
      state: { login: "valid", handle: "白泽工厂日记" },
    });
  });

  it("publish_draft 交给发布器时带上助理浏览器和数据目录", async () => {
    const server = startControlPlane();
    servers.push(server);
    const dataDir = await tempDataDir();
    const bytes = Buffer.from("起草时拷下来的图");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const drafts = join(dataDir, "bot-x", "drafts");
    await mkdir(drafts, { recursive: true });
    await writeFile(join(drafts, `${sha256}.png`), bytes);
    let connectionCalls = 0;
    spawnAgent(await server.url(), {
      dataDir,
      makeChrome: () => ({
        ...fakeChrome(),
        connection: async () => {
          connectionCalls += 1;
          return fakeConnection;
        },
      }),
    });
    const socket = await server.waitForSocket(1);

    socket.send(
      JSON.stringify({
        type: "publish_draft",
        draftId: "draft-1",
        botId: "bot-x",
        accountId: "account-1",
        platform: "xiaohongshu",
        content: {
          kind: "post",
          title: "周一早安",
          text: "新的一周从一杯咖啡开始",
          images: [{ path: join(drafts, `${sha256}.png`), sha256 }],
          github: null,
        },
        attempt: "2026-09-26T08:00:00.000Z",
      }),
    );

    // 配图校验认的是代理的数据目录，过了才去要助理 Chrome 的连接；这台假 Chrome 不接命令，所以回 error。
    await expect(server.waitForMessage("publish_result", 1, 10_000)).resolves.toMatchObject({
      type: "publish_result",
      draftId: "draft-1",
      attempt: "2026-09-26T08:00:00.000Z",
      result: { status: "failed", reason: "error" },
    });
    expect(connectionCalls, "发布器拿到的是代理的助理浏览器，配图也在代理的数据目录里认过了").toBe(1);
  });

  it("远程电脑收到 publish_draft 回 error 并写明没有助理浏览器，Bot 的助理浏览器照旧", async () => {
    const server = startControlPlane();
    servers.push(server);
    const wall = startLoginWallPipe();
    let launches = 0;
    const dataDir = await tempDataDir();
    const bytes = Buffer.from("远程电脑上起草时拷下来的图");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const drafts = join(dataDir, "bot-1", "drafts");
    await mkdir(drafts, { recursive: true });
    await writeFile(join(drafts, `${sha256}.png`), bytes);
    spawnAgent(await server.url(), {
      dataDir,
      makeChrome: (options) =>
        startAssistantChrome({
          ...options,
          platform: "linux",
          launchChrome: async () => {
            launches += 1;
            const stopped = new AbortController();
            const exited = new Promise<void>((resolve) => stopped.signal.addEventListener("abort", () => resolve()));
            return { pid: process.pid, exited, pipe: wall.pipe, stop: async () => stopped.abort() };
          },
        }),
    });
    const socket = await server.waitForSocket(1);
    socket.send(JSON.stringify(configMessage));
    socket.send(
      JSON.stringify({
        type: "publish_draft",
        draftId: "draft-1",
        botId: "bot-1",
        accountId: "account-1",
        platform: "xiaohongshu",
        content: {
          kind: "post",
          title: "周一早安",
          text: "新的一周从一杯咖啡开始",
          images: [{ path: join(drafts, `${sha256}.png`), sha256 }],
          github: null,
        },
        attempt: "2026-09-26T08:00:00.000Z",
      }),
    );

    await expect(
      server.waitForMessage("publish_result", 1, 10_000),
      "远程上扫码登录会被拒，不能回 login_expired 引用户去扫码",
    ).resolves.toEqual({
      type: "publish_result",
      draftId: "draft-1",
      attempt: "2026-09-26T08:00:00.000Z",
      result: { status: "failed", reason: "error", detail: "这台电脑没有助理浏览器" },
    });
    expect(launches, "发布器没去起这台电脑上的 Chrome").toBe(0);
    expect(wall.commands(), "管道上一条命令都没有").toEqual([]);
    const botBrowser = (await poll(() => initialRunnerConfigs.at(-1), 3000, "运行器收到 config")).browser;
    expect(botBrowser.profileDir).toBe(chromeProfileDir(dataDir));
    const connection = await botBrowser.connection();
    await connection.send("Target.createTarget", { url: "about:blank", background: true });
    expect(wall.commands(), "Bot 的助理浏览器工具在远程照样拿得到浏览器").toEqual([
      "Browser.getVersion",
      "Target.createTarget",
    ]);
  });

  it.each([
    ["启动就失败", async (): Promise<never> => Promise.reject(new Error("没装 Chrome"))],
    ["一直起不来", (): Promise<never> => new Promise<never>(() => {})],
  ])("Chrome %s时 browser_login 回 failed window_failed，不说账号过期", async (_label, launchChrome) => {
    const server = startControlPlane();
    servers.push(server);
    spawnAgent(await server.url(), {
      dataDir: await tempDataDir(),
      loginTimeoutMs: 300,
      makeChrome: (options) =>
        startAssistantChrome({
          ...options,
          launchChrome,
          activateProcess: async () => {},
          backgroundProcess: async () => {},
        }),
    });
    const socket = await server.waitForSocket(1);

    socket.send(
      JSON.stringify({ type: "browser_login", accountId: "account-1", platform: "xiaohongshu", attempt: "try-1" }),
    );

    await expect(server.waitForMessage("login_state", 1, 3000)).resolves.toEqual({
      type: "login_state",
      accountId: "account-1",
      state: { login: "failed", reason: "window_failed", attempt: "try-1" },
    });
  });

  it("Linux 上登录请求回失败并带说明，不为此起 Chrome", async () => {
    const server = startControlPlane();
    servers.push(server);
    const lines: string[] = [];
    let launches = 0;
    spawnAgent(await server.url(), {
      dataDir: await tempDataDir(),
      log: (line) => lines.push(line),
      makeChrome: (options) =>
        startAssistantChrome({
          ...options,
          platform: "linux",
          launchChrome: async () => {
            launches += 1;
            throw new Error("不该起 Chrome");
          },
        }),
    });
    const socket = await server.waitForSocket(1);

    socket.send(
      JSON.stringify({ type: "browser_login", accountId: "account-1", platform: "xiaohongshu", attempt: "try-1" }),
    );

    await expect(server.waitForMessage("login_state", 1, 3000)).resolves.toEqual({
      type: "login_state",
      accountId: "account-1",
      state: { login: "failed", reason: "remote_refused", attempt: "try-1" },
    });
    expect(lines.join("\n")).toContain("远程电脑上不能登录，请在本机登录这个账号");
    expect(launches).toBe(0);
  });

  it("前一个登录卡住不堵后一个", async () => {
    const server = startControlPlane();
    servers.push(server);
    const outcomes: Promise<BrowserLoginState>[] = [
      new Promise<never>(() => {}),
      Promise.resolve({ login: "valid", handle: "白泽工厂日记" }),
    ];
    let logins = 0;
    spawnAgent(await server.url(), {
      loginTimeoutMs: 300,
      makeChrome: () => ({
        ...fakeChrome(),
        login: () => {
          logins += 1;
          return outcomes.shift() ?? Promise.reject(new Error("多登了一次"));
        },
      }),
    });
    const socket = await server.waitForSocket(1);

    socket.send(
      JSON.stringify({ type: "browser_login", accountId: "account-1", platform: "xiaohongshu", attempt: "try-1" }),
    );
    // 上限从收到报文算起。第二条等第一条真的卡在登录里再发，它的上限才晚于第一条到点。
    await poll(() => (logins === 1 ? true : undefined), 3000, "第一次登录开始");
    socket.send(
      JSON.stringify({ type: "browser_login", accountId: "account-2", platform: "xiaohongshu", attempt: "try-2" }),
    );
    await server.waitForMessage("login_state", 2, 3000);

    expect(server.messages.filter((message) => message.type === "login_state")).toEqual([
      {
        type: "login_state",
        accountId: "account-1",
        state: { login: "failed", reason: "window_failed", attempt: "try-1" },
      },
      { type: "login_state", accountId: "account-2", state: { login: "valid", handle: "白泽工厂日记" } },
    ]);
  });

  it("断线期间完成的登录，重连收到 welcome 后补发，同一账号只补最新一条", async () => {
    const server = startControlPlane();
    servers.push(server);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const outcomes: BrowserLoginState[] = [
      { login: "failed", reason: "window_failed" },
      { login: "valid", handle: "白泽工厂日记" },
      { login: "valid", handle: "白泽二号" },
    ];
    const logs: string[] = [];
    let logins = 0;
    spawnAgent(await server.url(), {
      backoff: { initialMs: 200, maxMs: 200, factor: 1 },
      log: (line) => logs.push(line),
      makeChrome: () => ({
        ...fakeChrome(),
        login: async () => {
          logins += 1;
          const outcome = outcomes.shift();
          await gate;
          return outcome ?? Promise.reject(new Error("多登了一次"));
        },
      }),
    });
    const first = await server.waitForSocket(1);
    await server.waitForMessage("hello", 1);
    for (const [accountId, attempt] of [
      ["account-1", "try-1"],
      ["account-1", "try-2"],
      ["account-2", "try-3"],
    ])
      first.send(JSON.stringify({ type: "browser_login", accountId, platform: "xiaohongshu", attempt }));
    await poll(() => (logins === 1 ? true : undefined), 3000, "第一次登录开始");

    first.terminate();
    await poll(() => (logs.some((line) => line.includes("后重连")) ? true : undefined), 3000, "代理发现断线");
    release?.();
    // 三次登录都只等 gate，结果在微任务里就排完了，等一轮 setImmediate 它们都已经到 send 了，重连定时器还没到。
    await new Promise((resolve) => setImmediate(resolve));
    expect(logins, "前提：三次登录都在断线期间做完").toBe(3);

    const second = await server.waitForSocket(2);
    await server.waitForMessage("hello", 2);
    second.send(
      JSON.stringify({ type: "welcome", ownerId: "owner-1", kind: "local", serverTime: new Date().toISOString() }),
    );
    second.send(JSON.stringify(configMessage));
    await server.waitForMessage("config_applied", 1);

    expect(server.messages.filter((message) => message.type === "login_state")).toEqual([
      { type: "login_state", accountId: "account-1", state: { login: "valid", handle: "白泽工厂日记" } },
      { type: "login_state", accountId: "account-2", state: { login: "valid", handle: "白泽二号" } },
    ]);
  });

  it("断线期间留下的登录结果，被重连后 welcome 前做完的同一账号新结果顶掉，welcome 时不再补旧的", async () => {
    const server = startControlPlane();
    servers.push(server);
    const gates: Array<() => void> = [];
    const outcomes: BrowserLoginState[] = [
      { login: "failed", reason: "window_failed" },
      { login: "valid", handle: "白泽工厂日记" },
    ];
    const logs: string[] = [];
    spawnAgent(await server.url(), {
      backoff: { initialMs: 200, maxMs: 200, factor: 1 },
      log: (line) => logs.push(line),
      makeChrome: () => ({
        ...fakeChrome(),
        login: async () => {
          const outcome = outcomes.shift();
          await new Promise<void>((resolve) => gates.push(resolve));
          return outcome ?? Promise.reject(new Error("多登了一次"));
        },
      }),
    });
    const first = await server.waitForSocket(1);
    await server.waitForMessage("hello", 1);
    for (const attempt of ["try-1", "try-2"])
      first.send(JSON.stringify({ type: "browser_login", accountId: "account-1", platform: "xiaohongshu", attempt }));
    await poll(() => gates[0], 3000, "第一次登录开始");

    first.terminate();
    await poll(() => (logs.some((line) => line.includes("后重连")) ? true : undefined), 3000, "代理发现断线");
    gates[0]?.();
    const second = await server.waitForSocket(2);
    await server.waitForMessage("hello", 2);
    (await poll(() => gates[1], 3000, "第二次登录开始"))();
    await server.waitForMessage("login_state", 1);
    second.send(
      JSON.stringify({ type: "welcome", ownerId: "owner-1", kind: "local", serverTime: new Date().toISOString() }),
    );
    second.send(JSON.stringify(configMessage));
    await server.waitForMessage("config_applied", 1);

    expect(server.messages.filter((message) => message.type === "login_state")).toEqual([
      { type: "login_state", accountId: "account-1", state: { login: "valid", handle: "白泽工厂日记" } },
    ]);
  });

  it.runIf(process.platform === "darwin")(
    "代理正常停机后，这个 profile 的 Chrome 不在了",
    async () => {
      const server = startControlPlane();
      servers.push(server);
      const directory = await tempDataDir();
      const connections: Promise<CdpConnection>[] = [];
      const agent = spawnAgent(await server.url(), {
        dataDir: directory,
        makeChrome: startAssistantChrome,
        makeRunner: (config) => {
          connections.push(config.browser.connection());
          return runnerOf(config, runnerCalls());
        },
      });
      const socket = await server.waitForSocket(1);
      socket.send(JSON.stringify(configMessage));
      await poll(() => connections[0], 3000, "运行器要管道连接");
      await connections[0];
      const running = await profileChromePids(chromeProfileDir(directory));
      expect(running, "前提：运行器要过连接之后这个 profile 有一个 Chrome").toHaveLength(1);

      await agent.stop();

      expect(await profileChromePids(chromeProfileDir(directory))).toEqual([]);
    },
    30_000,
  );

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
          applyConfig: async () => {},
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

  it("resume 补跑时 inbox 不被堵住：紧跟的 approval_result 先送到运行器", async () => {
    const server = startControlPlane();
    servers.push(server);
    let runnerCreated = false;
    let resumeStarted = false;
    let releaseResume!: () => void;
    const resumeDone = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const approvals: Array<{ runId: RunId; callId: string; approved: boolean }> = [];
    agents.push(
      startAgent({
        url: await server.url(),
        computerId: ComputerId.parse("computer-1"),
        token: "dev-token",
        version: "0.1.0",
        log: () => {},
        makeRunner: () => {
          runnerCreated = true;
          return {
            applyConfig: async () => {},
            prompt: async () => {},
            approve: (runId, callId, approved) => approvals.push({ runId, callId, approved }),
            pause: async () => {},
            resume: async () => {
              resumeStarted = true;
              await resumeDone;
            },
            activeRuns: () => [],
            stop: async () => {},
          };
        },
      }),
    );

    const socket = await server.waitForSocket(1);
    socket.send(JSON.stringify(configMessage));
    await poll(() => (runnerCreated ? true : undefined), 3000, "运行器建好");
    socket.send(JSON.stringify({ type: "resume", botId: "bot-1" }));
    await poll(() => (resumeStarted ? true : undefined), 3000, "resume 开始补跑");
    socket.send(JSON.stringify({ type: "approval_result", runId: "run-1", callId: "call-1", approved: true }));

    await poll(() => (approvals.length === 1 ? true : undefined), 3000, "审批结论送到运行器");
    expect(approvals).toEqual([{ runId: "run-1", callId: "call-1", approved: true }]);
    releaseResume();
  });

  it("run 收尾对账期间来 config：后面的审批结论仍送达，两条 run 都 run_done", async () => {
    const server = startControlPlane();
    servers.push(server);
    let runnerCreated = false;
    let firstRunFinalizing = false;
    let configDuringFinalizing = false;
    let firstRunStarted = false;
    let releaseFirstRun!: () => void;
    const firstRunDone = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });
    let approveSecondRun!: () => void;
    const secondApproval = new Promise<void>((resolve) => {
      approveSecondRun = resolve;
    });
    const approved: Array<{ runId: RunId; callId: string; approved: boolean }> = [];
    const appliedConfigs: RunnerConfig[] = [];
    agents.push(
      startAgent({
        url: await server.url(),
        computerId: ComputerId.parse("computer-1"),
        token: "dev-token",
        version: "0.1.0",
        log: () => {},
        makeRunner: (config) => {
          runnerCreated = true;
          return {
            async applyConfig(nextConfig) {
              appliedConfigs.push(nextConfig);
              configDuringFinalizing = firstRunFinalizing;
            },
            async prompt(message) {
              if (message.runId === "run-1") {
                firstRunStarted = true;
                firstRunFinalizing = true;
                await firstRunDone;
                config.send({
                  type: "run_done",
                  runId: message.runId,
                  botId: message.botId,
                  groupId: message.groupId,
                  steps: 1,
                  inputTokens: 1,
                  outputTokens: 1,
                });
                firstRunFinalizing = false;
                return;
              }
              config.send({
                type: "approval_request",
                runId: message.runId,
                botId: message.botId,
                groupId: message.groupId,
                callId: "call-2",
                tool: "send_email",
                action: "message_person",
                target: null,
                view: { kind: "mcp", server: "客服工具", tool: "send_email", params: [], raw: "发一封报价邮件" },
              });
              await secondApproval;
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
            approve: (runId, callId, approvedResult) => {
              approved.push({ runId, callId, approved: approvedResult });
              approveSecondRun();
            },
            pause: async () => {},
            resume: async () => {},
            activeRuns: () => [],
            stop: async () => {},
          };
        },
      }),
    );

    const socket = await server.waitForSocket(1);
    socket.send(JSON.stringify(configMessage));
    await poll(() => (runnerCreated ? true : undefined), 3000, "运行器建好");
    socket.send(JSON.stringify({ ...promptMessage, runId: "run-1" }));
    await poll(() => (firstRunStarted ? true : undefined), 3000, "run-1 进入收尾对账");
    firstRunFinalizing = true;
    socket.send(
      JSON.stringify({
        ...configMessage,
        generation: 2,
        bots: [{ id: "bot-1", role: "member", name: "小服", tag: "", description: "新版客服 Bot" }],
      }),
    );
    socket.send(JSON.stringify({ ...promptMessage, runId: "run-2", text: "发报价邮件" }));
    await server.waitForMessage("approval_request", 1, 3000);
    releaseFirstRun();
    await server.waitForMessage("run_done", 1, 3000);
    socket.send(JSON.stringify({ type: "approval_result", runId: "run-2", callId: "call-2", approved: true }));
    await poll(() => (approved.length === 1 ? true : undefined), 3000, "run-2 的审批结论送到运行器");
    await server.waitForMessage("run_done", 2, 3000);

    expect(configDuringFinalizing).toBe(true);
    expect(appliedConfigs).toHaveLength(1);
    expect(approved).toEqual([{ runId: "run-2", callId: "call-2", approved: true }]);
    expect(server.messages.filter((message) => message.type === "run_done").map((message) => message.runId)).toEqual([
      "run-1",
      "run-2",
    ]);
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

  it("停机时运行器的放弃审批和 run_done 先送到控制面再断开", async () => {
    const server = startControlPlane();
    servers.push(server);
    const order: string[] = [];
    server.onConnection((socket) => {
      socket.on("message", (data) => {
        const parsed = AgentToControl.parse(JSON.parse(data.toString()));
        if (parsed.type !== "hello") order.push(parsed.type);
      });
      socket.on("close", () => order.push("closed"));
    });
    const handle = startAgent({
      url: await server.url(),
      computerId: ComputerId.parse("computer-1"),
      token: "dev-token",
      version: "0.1.0",
      log: () => {},
      makeRunner: (config) => ({
        applyConfig: async () => {},
        async prompt(message) {
          config.send({
            type: "approval_request",
            runId: message.runId,
            botId: message.botId,
            groupId: message.groupId,
            callId: "call-1",
            tool: "send_email",
            action: "message_person",
            target: null,
            view: { kind: "mcp", server: "客服工具", tool: "send_email", params: [], raw: {} },
          });
        },
        approve: () => {},
        pause: async () => {},
        resume: async () => {},
        activeRuns: () => [RunId.parse("run-1")],
        async stop() {
          config.send({
            type: "approval_abandoned",
            runId: RunId.parse("run-1"),
            callId: "call-1",
            reason: "stopped",
          });
          config.send({
            type: "run_done",
            runId: RunId.parse("run-1"),
            botId: BotId.parse("bot-1"),
            groupId: GroupId.parse("group-1"),
            steps: 1,
            inputTokens: 10,
            outputTokens: 2,
          });
        },
      }),
    });
    agents.push(handle);
    const socket = await server.waitForSocket(1);
    socket.send(JSON.stringify(configMessage));
    socket.send(JSON.stringify(promptMessage));
    await server.waitForMessage("approval_request", 1, 3000);

    await handle.stop();
    await poll(() => (order.includes("closed") ? true : undefined), 3000, "连接关闭");

    expect(server.messages.find((message) => message.type === "approval_abandoned")).toEqual({
      type: "approval_abandoned",
      runId: "run-1",
      callId: "call-1",
      reason: "stopped",
    });
    expect(server.messages.filter((message) => message.type === "run_done")).toEqual([
      {
        type: "run_done",
        runId: "run-1",
        botId: "bot-1",
        groupId: "group-1",
        steps: 1,
        inputTokens: 10,
        outputTokens: 2,
      },
    ]);
    expect(order).toEqual(["config_applied", "approval_request", "approval_abandoned", "run_done", "closed"]);
  });

  it("运行器停不下来时，停机在上限内返回", async () => {
    const server = startControlPlane();
    servers.push(server);
    let runnerCreated = false;
    let closed = false;
    server.onConnection((socket) => socket.on("close", () => (closed = true)));
    const handle = startAgent({
      url: await server.url(),
      computerId: ComputerId.parse("computer-1"),
      token: "dev-token",
      version: "0.1.0",
      log: () => {},
      makeRunner: (config) => {
        runnerCreated = true;
        return {
          ...runnerOf(config, {
            approvals: [],
            activeRuns: [],
            paused: [],
            resumed: [],
            prompts: [],
            promptContexts: [],
            configSkills: [],
            appliedConfigs: [],
          }),
          stop: () => new Promise<void>(() => {}),
        };
      },
      runnerStopTimeoutMs: 40,
    });
    const socket = await server.waitForSocket(1);
    socket.send(JSON.stringify(configMessage));
    await poll(() => (runnerCreated ? true : undefined), 3000, "运行器建好");

    const startedAt = Date.now();
    const result = await Promise.race([
      handle.stop().then(() => "stopped" as const),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 500)),
    ]);
    const elapsedMs = Date.now() - startedAt;
    await poll(() => (closed ? true : undefined), 3000, "连接关闭");

    expect(result).toBe("stopped");
    expect(elapsedMs).toBeGreaterThanOrEqual(30);
    expect(elapsedMs).toBeLessThan(300);
    expect(closed).toBe(true);
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

const welcomeFrame = () =>
  JSON.stringify({ type: "welcome", ownerId: "owner-1", kind: "local", serverTime: new Date().toISOString() });
const runDoneOf = (runId: string) =>
  ({
    type: "run_done",
    runId: RunId.parse(runId),
    botId: BotId.parse("bot-1"),
    groupId: GroupId.parse("group-1"),
    steps: 3,
    inputTokens: 120,
    outputTokens: 40,
  }) as const;
const runDonesSeen = (server: ControlPlane) => server.messages.filter((message) => message.type === "run_done");

describe("run_done 补发", () => {
  /** 运行器在 prompt 里等 finish 放行，然后按 finish 给的 runId 逐条报 run_done。 */
  function gatedRunner(server: ControlPlane, logs: string[]) {
    let finish: ((runIds: readonly string[]) => void) | undefined;
    let started = false;
    return {
      spawn: async () =>
        spawnAgent(await server.url(), {
          backoff: { initialMs: 200, maxMs: 200, factor: 1 },
          log: (line) => logs.push(line),
          makeRunner: (config) => ({
            ...runnerOf(config, runnerCalls()),
            async prompt() {
              started = true;
              const runIds = await new Promise<readonly string[]>((resolve) => {
                finish = resolve;
              });
              for (const runId of runIds) config.send(runDoneOf(runId));
            },
          }),
        }),
      started: () => started,
      finish: (runIds: readonly string[]) => finish?.(runIds),
    };
  }

  it("断线期间跑完的 run：hello 把它报成还在跑，welcome 之后才补发，同一个 runId 报两次只补一条", async () => {
    const server = startControlPlane();
    servers.push(server);
    const logs: string[] = [];
    const runner = gatedRunner(server, logs);
    await runner.spawn();
    const first = await server.waitForSocket(1);
    await server.waitForMessage("hello", 1);
    first.send(JSON.stringify(configMessage));
    first.send(JSON.stringify(promptMessage));
    await poll(() => (runner.started() ? true : undefined), 3000, "run-1 开始");

    first.terminate();
    await poll(() => (logs.some((line) => line.includes("后重连")) ? true : undefined), 3000, "代理发现断线");
    runner.finish(["run-1", "run-1"]);
    await poll(
      () => (logs.some((line) => line.includes("run run-1 的 run_done 留到重连后补发")) ? true : undefined),
      3000,
      "run_done 留下",
    );

    const second = await server.waitForSocket(2);
    const hello = await server.waitForMessage("hello", 2);
    expect(hello.activeRuns, "运行器已经不跑它了，但 run_done 还没送到，对账不能按断线收尾").toEqual(["run-1"]);
    expect(runDonesSeen(server), "welcome 之前控制面不认这条连接的帧，不能先发").toEqual([]);

    second.send(welcomeFrame());
    second.send(JSON.stringify(configMessage));
    await server.waitForMessage("config_applied", 2);
    expect(runDonesSeen(server)).toEqual([runDoneOf("run-1")]);
  });

  it("连接在时发出去的 run_done 也留到控制面确认：没确认就每次重连补发，确认之后不再报也不再补", async () => {
    const server = startControlPlane();
    servers.push(server);
    const logs: string[] = [];
    const runner = gatedRunner(server, logs);
    await runner.spawn();
    const first = await server.waitForSocket(1);
    await server.waitForMessage("hello", 1);
    first.send(JSON.stringify(configMessage));
    first.send(JSON.stringify(promptMessage));
    await poll(() => (runner.started() ? true : undefined), 3000, "run-1 开始");
    runner.finish(["run-1", "run-1"]);
    await server.waitForMessage("run_done", 1);
    first.send(JSON.stringify({ ...configMessage, generation: 2 }));
    await server.waitForMessage("config_applied", 2);
    expect(runDonesSeen(server), "同一个 runId 报两次，连接在时也只发一条").toHaveLength(1);

    first.terminate();
    const second = await server.waitForSocket(2);
    expect((await server.waitForMessage("hello", 2)).activeRuns, "发出去了但没确认，仍报成还在跑").toEqual(["run-1"]);
    second.send(welcomeFrame());
    await server.waitForMessage("run_done", 2);
    second.send(JSON.stringify({ type: "run_done_ack", runId: "run-1" }));
    second.send(JSON.stringify(configMessage));
    await server.waitForMessage("config_applied", 3);

    second.terminate();
    const third = await server.waitForSocket(3);
    expect((await server.waitForMessage("hello", 3)).activeRuns, "确认过的不再报").toEqual([]);
    third.send(welcomeFrame());
    third.send(JSON.stringify(configMessage));
    await server.waitForMessage("config_applied", 4);
    expect(runDonesSeen(server), "确认之后重连不再补发").toEqual([runDoneOf("run-1"), runDoneOf("run-1")]);
  });

  it("控制面一直不确认：补发够次数后 hello 不再报它，交给对账按断线收尾，补发也停", async () => {
    const server = startControlPlane();
    servers.push(server);
    const logs: string[] = [];
    const runner = gatedRunner(server, logs);
    await runner.spawn();
    const first = await server.waitForSocket(1);
    await server.waitForMessage("hello", 1);
    first.send(JSON.stringify(configMessage));
    first.send(JSON.stringify(promptMessage));
    await poll(() => (runner.started() ? true : undefined), 3000, "run-1 开始");
    runner.finish(["run-1"]);
    await server.waitForMessage("run_done", 1);

    let current = first;
    for (let replay = 1; replay <= RUN_DONE_REPLAY_LIMIT; replay += 1) {
      current.terminate();
      current = await server.waitForSocket(replay + 1);
      const hello = await server.waitForMessage("hello", replay + 1);
      expect(hello.activeRuns, `第 ${replay} 次重连还在补发次数里，仍报它`).toEqual(["run-1"]);
      current.send(welcomeFrame());
      await server.waitForMessage("run_done", replay + 1);
    }

    current.terminate();
    const last = await server.waitForSocket(RUN_DONE_REPLAY_LIMIT + 2);
    const hello = await server.waitForMessage("hello", RUN_DONE_REPLAY_LIMIT + 2);
    expect(hello.activeRuns, "补发够次数没确认，不再报，控制面对账才能按断线收尾").toEqual([]);
    last.send(welcomeFrame());
    last.send(JSON.stringify(configMessage));
    await server.waitForMessage("config_applied", 2);
    expect(runDonesSeen(server), "放手之后不再补发").toHaveLength(RUN_DONE_REPLAY_LIMIT + 1);
  });

  it("待确认的 run_done 超过上限时丢最老的，hello 只报留下的", async () => {
    const server = startControlPlane();
    servers.push(server);
    const logs: string[] = [];
    const runner = gatedRunner(server, logs);
    await runner.spawn();
    const first = await server.waitForSocket(1);
    await server.waitForMessage("hello", 1);
    first.send(JSON.stringify(configMessage));
    first.send(JSON.stringify(promptMessage));
    await poll(() => (runner.started() ? true : undefined), 3000, "run 开始");
    const runIds = Array.from({ length: UNACKED_RUN_DONE_LIMIT + 1 }, (_, index) => `run-${index}`);
    runner.finish(runIds);
    await server.waitForMessage("run_done", runIds.length);

    first.terminate();
    await server.waitForSocket(2);
    const hello = await server.waitForMessage("hello", 2);
    expect(hello.activeRuns, "最老的 run-0 被丢掉，交给对账；其余照报").toEqual(runIds.slice(1));
    expect(logs.some((line) => line.includes("丢掉最老的 run run-0"))).toBe(true);
  });
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
