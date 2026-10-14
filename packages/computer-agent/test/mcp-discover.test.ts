import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { AgentToControl, BareUplinkFrame, ComputerId, type McpDiscoveryResult } from "@baize/shared";
import { startAgent, type AgentOptions } from "../src/agent.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
});
const result: McpDiscoveryResult = {
  ok: true,
  operations: [{ name: "lookup", description: "查询", inputSchema: { type: "object" }, needsApproval: false }],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const send = (socket: WebSocket, requestId = randomUUID()) => {
  socket.send(
    JSON.stringify({
      type: "mcp_discover",
      requestId,
      url: "http://127.0.0.1:1/mcp",
      authorization: "Bearer agent-discover-fixture",
    }),
  );
  return requestId;
};

async function fixture(discoverMcp: NonNullable<AgentOptions["discoverMcp"]>) {
  const dataDir = await mkdtemp(join(tmpdir(), "baize-discover-agent-"));
  closers.push(() => rm(dataDir, { recursive: true, force: true }));
  const ws = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => ws.once("listening", resolve));
  closers.push(() => new Promise<void>((resolve, reject) => ws.close((error) => (error ? reject(error) : resolve()))));
  const address = ws.address();
  if (typeof address === "string" || address === null) throw new Error("假控制面没有端口");
  let connection = 0;
  const hellos: WebSocket[] = [];
  const messages: { conn: number; body: AgentToControl }[] = [];
  let runnerCreated = 0;
  const logs: string[] = [];
  ws.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const json: unknown = JSON.parse(raw.toString());
      const hello = AgentToControl.safeParse(json);
      if (hello.success && hello.data.type === "hello") {
        connection += 1;
        hellos.push(socket);
        socket.send(
          JSON.stringify({
            type: "welcome",
            ownerId: "owner",
            kind: "local",
            conn: connection,
            serverTime: new Date().toISOString(),
            upAcked: 0,
          }),
        );
        return;
      }
      messages.push(BareUplinkFrame.parse(json));
    });
  });
  const agent = startAgent({
    url: `ws://127.0.0.1:${address.port}/agent`,
    computerId: ComputerId.parse("computer"),
    token: "test",
    version: "test",
    dataDir,
    discoverMcp,
    log: (line) => logs.push(line),
    heartbeatMs: 60_000,
    backoff: { initialMs: 10, maxMs: 10, factor: 1 },
    makeRunner: () => {
      runnerCreated += 1;
      throw new Error("探测不应该起运行器");
    },
    makeChrome: () => ({
      kind: "local",
      profileDir: join(dataDir, "chrome"),
      connection: async () => {
        throw new Error("探测不应该用 Chrome");
      },
      onExit: () => () => {},
      reveal: async () => {},
      conceal: async () => {},
      pid: () => null,
      stop: async () => {},
    }),
  });
  closers.push(() => agent.stop());
  await expect.poll(() => hellos.length).toBe(1);
  return { agent, dataDir, messages, hellos, send, logs, runnerCreated: () => runnerCreated };
}
async function diskContents(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const contents = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? diskContents(join(directory, entry.name)) : readFile(join(directory, entry.name), "utf8"),
    ),
  );
  return contents.join("\n");
}

describe("电脑代理本机 MCP 探测", () => {
  it("welcome 后无需 config 或 Pi 会话即可回 bare 结果，凭据和报文不落盘、不进日志", async () => {
    const inputs: string[] = [];
    const f = await fixture(async (input) => {
      inputs.push(input.authorization ?? "");
      return result;
    });
    const id = f.send(f.hellos[0]!);
    await expect.poll(() => f.messages.some((message) => message.body.type === "mcp_discovered")).toBe(true);
    expect(f.messages.find((message) => message.body.type === "mcp_discovered")).toEqual({
      conn: 1,
      body: { type: "mcp_discovered", requestId: id, result },
    });
    expect(inputs.length).toBe(1);
    expect(f.runnerCreated()).toBe(0);
    await expect(readFile(join(f.dataDir, ".agent", "downlink.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const disk = await diskContents(join(f.dataDir, ".agent"));
    for (const text of [disk, f.logs.join("\n")]) {
      expect(text.includes("agent-discover-fixture")).toBe(false);
      expect(text.includes("mcp_discover")).toBe(false);
    }
  });

  it("慢探测不堵下行队列，第二次探测能先回", async () => {
    const slow = deferred<McpDiscoveryResult>();
    let count = 0;
    const f = await fixture(async () => (++count === 1 ? slow.promise : result));
    const first = f.send(f.hellos[0]!);
    const second = f.send(f.hellos[0]!);
    await expect.poll(() => f.messages.filter((message) => message.body.type === "mcp_discovered").length).toBe(1);
    expect(f.messages.find((message) => message.body.type === "mcp_discovered")?.body).toEqual({
      type: "mcp_discovered",
      requestId: second,
      result,
    });
    slow.resolve(result);
    await expect
      .poll(() =>
        f.messages.some((message) => message.body.type === "mcp_discovered" && message.body.requestId === first),
      )
      .toBe(true);
  });

  it("停机取消正在跑的探测并等它关掉，不发送迟到结果", async () => {
    let aborted = false;
    const started = deferred<void>();
    const f = await fixture(async (_, options) => {
      started.resolve();
      return new Promise<McpDiscoveryResult>((resolve) =>
        options?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve({ ok: false, reason: "timeout" });
          },
          { once: true },
        ),
      );
    });
    f.send(f.hellos[0]!);
    await started.promise;
    await f.agent.stop();
    expect(aborted).toBe(true);
    expect(f.messages.some((message) => message.body.type === "mcp_discovered")).toBe(false);
  });

  it("旧连接完成的探测不回到新连接", async () => {
    const old = deferred<McpDiscoveryResult>();
    const started = deferred<void>();
    let count = 0;
    const f = await fixture(async () => {
      if (++count === 1) {
        started.resolve();
        return old.promise;
      }
      return result;
    });
    const oldId = f.send(f.hellos[0]!);
    await started.promise;
    f.hellos[0]!.close();
    await expect.poll(() => f.hellos.length).toBe(2);
    old.resolve(result);
    const newId = f.send(f.hellos[1]!);
    await expect
      .poll(() =>
        f.messages.some((message) => message.body.type === "mcp_discovered" && message.body.requestId === newId),
      )
      .toBe(true);
    expect(
      f.messages.some((message) => message.body.type === "mcp_discovered" && message.body.requestId === oldId),
    ).toBe(false);
    expect(f.messages.find((message) => message.body.type === "mcp_discovered")?.conn).toBe(2);
  });
});
