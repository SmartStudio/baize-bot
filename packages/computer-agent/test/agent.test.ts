import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { AgentToControl, ComputerId } from "@baize/shared";
import { startAgent, type AgentHandle } from "../src/agent.js";
import { backoffDelay, type BackoffOptions } from "../src/backoff.js";

const configMessage = {
  type: "config",
  bots: [{ id: "bot-1", name: "小服", description: "客服 Bot" }],
  tools: [],
  modelGateway: { baseUrl: "http://localhost:3001/model", apiKey: "dev-key", model: "dev-model" },
};

const promptMessage = {
  type: "prompt",
  runId: "run-1",
  botId: "bot-1",
  groupId: "group-1",
  text: "查一下昨天的订单",
  context: [],
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

function spawnAgent(url: string, tuning: { heartbeatMs?: number; backoff?: BackoffOptions } = {}): AgentHandle {
  const handle = startAgent({
    url,
    computerId: ComputerId.parse("computer-1"),
    token: "dev-token",
    version: "0.1.0",
    log: () => {},
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
});

describe("电脑代理连控制面", () => {
  it("连上后 3 秒内发出 hello，且能 parse 通过 AgentToControl", async () => {
    const server = await startPair();

    const hello = await server.waitForMessage("hello", 1, 3000);

    expect(hello).toEqual({ type: "hello", computerId: "computer-1", token: "dev-token", version: "0.1.0" });
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
