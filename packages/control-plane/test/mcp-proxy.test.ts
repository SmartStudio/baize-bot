import {
  CreateBotResponse,
  McpProxyCallResponse,
  ToolListResponse,
  ToolResponse,
  type BotId,
  type ControlToAgent,
} from "@baize/shared";
import { Server as HttpServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureComputer } from "../src/repo/computers.js";
import { McpClients } from "../src/mcp/call.js";
import { ToolCrypto } from "../src/crypto.js";
import { helloAgent } from "./helpers/agent.js";
import { startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser } from "./helpers/fixtures.js";
import { startTestMcp, type TestMcp } from "./helpers/mcp.js";

type Config = Extract<ControlToAgent, { type: "config" }>;
let database: TestDb;
let server: TestServer;
let mcp: TestMcp;
const SECRET = "Bearer proxy-private-token";

beforeAll(async () => {
  database = await createTestDb();
  server = await startTestServer(database.db);
  mcp = await startTestMcp();
});

afterAll(async () => {
  await server.close();
  await mcp.close();
  await database.close();
});

async function owner(testServer = server) {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = testServer.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const botId = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "代理测试" })).json()).bot.id;
  return { user, computer, client, botId };
}

async function connect(who: Awaited<ReturnType<typeof owner>>, localOnly = false, name = "公司插件", url = mcp.url) {
  const created = await who.client.post("/api/tools", { name, url, authorization: SECRET, localOnly });
  expect(created.status).toBe(201);
  const tool = ToolResponse.parse(await created.json()).tool;
  const assigned = await who.client.patch(`/api/tools/${tool.id}`, { assignedBotIds: [who.botId] });
  expect(assigned.status).toBe(200);
  return ToolResponse.parse(await assigned.json()).tool;
}

function call(
  config: Config,
  id: string,
  botId: BotId,
  tool = "lookup_stock",
  sku = "X3",
  key = config.modelGateway.apiKey,
  signal?: AbortSignal,
) {
  return fetch(`${config.mcpProxy.baseUrl}/${id}/call`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ botId, tool, arguments: { sku } }),
    ...(signal === undefined ? {} : { signal }),
  });
}

describe("MCP 控制面代执行", () => {
  it.each(["sse-end", "sse-drop", "drop-all", "get-end", "get-drop"])(
    "响应流 %s 没有回包，5 秒内固定分类失败，健康 POST 调用照常返回",
    async (sku) => {
      const persistent = await startTestMcp({ stateful: true });
      const who = await owner();
      const tool = await connect(who, false, "断流", persistent.url);
      const { agent, config } = await helloAgent(server.server.port, who.computer.computerId, who.computer.token);
      const hold = persistent.holdNextCall();
      try {
        const pending = call(config, tool.id, who.botId);
        await hold.arrived;
        await persistent.waitForStreams(1);
        const before = persistent.initializations();
        const closed = persistent.nextCallClosed();
        const started = Date.now();
        const failed = await call(
          config,
          tool.id,
          who.botId,
          "lookup_stock",
          sku,
          config.modelGateway.apiKey,
          AbortSignal.timeout(4_000),
        );
        expect(failed.status).toBe(502);
        expect(await failed.json()).toEqual({ error: "插件调用失败：这个地址连不上" });
        expect(Date.now() - started, "断流不等 60 秒超时").toBeLessThan(5_000);
        await closed;
        hold.release();
        const other = await pending;
        if (sku === "drop-all") {
          expect(other.status).toBe(502);
          expect(await other.json()).toEqual({ error: "插件调用失败：这个地址连不上" });
        } else {
          expect(other.status).toBe(200);
          expect(await other.json()).toEqual({ content: [{ type: "text", text: "160" }], isError: false });
        }
        expect((await call(config, tool.id, who.botId)).status).toBe(200);
        expect(persistent.initializations() - before, "仅 POST 断流保留缓存；连接断开则重建").toBe(
          sku === "drop-all" || sku === "get-drop" ? 1 : 0,
        );
      } finally {
        hold.release();
        await who.client.delete(`/api/tools/${tool.id}`);
        agent.close();
        await persistent.close();
      }
    },
  );

  it("GET 返回的 SSE 事件也在解析前限长，终止该 Client 的在途调用并作废缓存", async () => {
    const persistent = await startTestMcp({ stateful: true });
    const who = await owner();
    const tool = await connect(who, false, "GET 限长", persistent.url);
    const { agent, config } = await helloAgent(server.server.port, who.computer.computerId, who.computer.token);
    const hold = persistent.holdNextCall();
    try {
      const pending = call(config, tool.id, who.botId);
      await hold.arrived;
      await persistent.waitForStreams(1);
      const before = persistent.initializations();
      const result = await call(config, tool.id, who.botId, "lookup_stock", "stream-get");
      const other = await pending;
      for (const response of [result, other]) {
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({ error: "插件结果超过 20 MiB 上限" });
      }
      await expect(persistent.waitForStreams(0, AbortSignal.timeout(2_000))).resolves.toBeUndefined();
      expect(persistent.completedLargeResponses()).toBe(0);
      expect((await call(config, tool.id, who.botId)).status).toBe(200);
      expect(persistent.initializations() - before).toBe(1);
    } finally {
      hold.release();
      await who.client.delete(`/api/tools/${tool.id}`);
      agent.close();
      await persistent.close();
    }
  });

  it.each(["stream-json", "stream-sse", "stream-sse-error"])(
    "上游 %s 在 SDK 解析前限长，超过 20 MiB 中止请求并关闭对端流",
    async (sku) => {
      const persistent = await startTestMcp({ stateful: true });
      const who = await owner();
      const tool = await connect(who, false, "流式限长", persistent.url);
      const { agent, config } = await helloAgent(server.server.port, who.computer.computerId, who.computer.token);
      try {
        expect((await call(config, tool.id, who.botId)).status).toBe(200);
        await persistent.waitForStreams(1);
        const before = persistent.initializations();
        const closed = persistent.nextCallClosed();
        const result = await call(config, tool.id, who.botId, "lookup_stock", sku);
        expect(result.status).toBe(502);
        expect(await result.json()).toEqual({ error: "插件结果超过 20 MiB 上限" });
        await closed;
        expect(persistent.streamedBytes(), "对端没有发送完整的 100 块正文").toBeLessThan(105_000_000);
        expect(persistent.completedLargeResponses(), "上游尚未完成 JSON/SSE，请求已被中止").toBe(0);
        expect(persistent.activeStreams(), "只关闭超限 POST，保留共享 GET").toBe(1);
        expect((await call(config, tool.id, who.botId)).status).toBe(200);
        expect(persistent.initializations()).toBe(before);
      } finally {
        await who.client.delete(`/api/tools/${tool.id}`);
        agent.close();
        await persistent.close();
      }
    },
  );

  it("PATCH 之外更新凭据，下次调用比较指纹、用新 Client，旧 Client 在途归零后关闭", async () => {
    const persistent = await startTestMcp({ stateful: true });
    const who = await owner();
    const tool = await connect(who, false, "指纹", persistent.url);
    const { agent, config } = await helloAgent(server.server.port, who.computer.computerId, who.computer.token);
    const hold = persistent.holdNextCall();
    try {
      const old = call(config, tool.id, who.botId);
      await hold.arrived;
      await persistent.waitForStreams(1);
      const before = persistent.initializations();
      const rotated = "Bearer fingerprint-private-token";
      const encrypted = new ToolCrypto("a".repeat(64)).encrypt(rotated);
      await database.sql`UPDATE tool_connections SET authorization_enc = ${encrypted} WHERE id = ${tool.id}`;
      const newStream = persistent.nextStream();
      expect((await call(config, tool.id, who.botId)).status).toBe(200);
      expect(persistent.initializations() - before, "未走 PATCH invalidate，凭据指纹仍触发重建").toBe(1);
      expect(persistent.calls().at(-1)?.authorization).toBe(rotated);
      await newStream;
      expect(persistent.activeStreams()).toBe(2);
      hold.release();
      expect((await old).status).toBe(200);
      await expect(
        persistent.waitForStreams(1, AbortSignal.timeout(2_000)),
        "旧 Client 确实关闭",
      ).resolves.toBeUndefined();
      expect((await call(config, tool.id, who.botId)).status).toBe(200);
      expect(persistent.initializations() - before).toBe(1);
      await who.client.delete(`/api/tools/${tool.id}`);
      await expect(persistent.waitForStreams(0, AbortSignal.timeout(2_000))).resolves.toBeUndefined();
    } finally {
      hold.release();
      await who.client.delete(`/api/tools/${tool.id}`);
      agent.close();
      await persistent.close();
    }
  });

  it("调用方断开后在途计数归零，作废时关闭旧 Client，对端流数归零", async () => {
    const persistent = await startTestMcp({ stateful: true });
    const who = await owner();
    const tool = await connect(who, false, "取消计数", persistent.url);
    const { agent, config } = await helloAgent(server.server.port, who.computer.computerId, who.computer.token);
    const controller = new AbortController();
    const hold = persistent.holdNextCall();
    try {
      const cancelled = persistent.nextCancellation();
      const closed = persistent.nextCallClosed();
      const pending = call(
        config,
        tool.id,
        who.botId,
        "lookup_stock",
        "X3",
        config.modelGateway.apiKey,
        controller.signal,
      ).catch((error: unknown) => error);
      await hold.arrived;
      await persistent.waitForStreams(1);
      controller.abort();
      expect(await pending).toBeInstanceOf(Error);
      await cancelled;
      await closed;
      expect((await who.client.patch(`/api/tools/${tool.id}`, { name: "取消后作废" })).status).toBe(200);
      await expect(
        persistent.waitForStreams(0, AbortSignal.timeout(2_000)),
        "取消必须减在途计数，作废后旧 Client 应关闭",
      ).resolves.toBeUndefined();
    } finally {
      controller.abort();
      hold.release();
      await who.client.delete(`/api/tools/${tool.id}`);
      agent.close();
      await persistent.close();
    }
  });

  it("挂着的调用不受另一个调用的 isError 影响，按自己的结果返回", async () => {
    const who = await owner();
    const tool = await connect(who);
    const { agent, config } = await helloAgent(server.server.port, who.computer.computerId, who.computer.token);
    const hold = mcp.holdNextCall();
    try {
      const pending = call(config, tool.id, who.botId);
      await hold.arrived;
      const before = mcp.initializations();
      const failed = await call(config, tool.id, who.botId, "lookup_stock", "error");
      expect(failed.status).toBe(200);
      expect(McpProxyCallResponse.parse(await failed.json()).isError).toBe(true);
      hold.release();
      const result = await pending;
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ content: [{ type: "text", text: "160" }], isError: false });
      expect((await call(config, tool.id, who.botId)).status).toBe(200);
      expect(mcp.initializations() - before, "业务错误不废弃共享 Client").toBe(0);
    } finally {
      hold.release();
      agent.close();
    }
  });

  it("连接阶段第一个调用被断开，第二个调用仍使用连好的 Client", async () => {
    const who = await owner();
    const tool = await connect(who);
    const { agent, config } = await helloAgent(server.server.port, who.computer.computerId, who.computer.token);
    const hold = mcp.holdNextInitialization();
    const controller = new AbortController();
    const original = McpClients.prototype.call;
    let entered!: () => void;
    const secondEntered = new Promise<void>((resolve) => (entered = resolve));
    let disconnected!: () => void;
    const firstDisconnected = new Promise<void>((resolve) => (disconnected = resolve));
    let count = 0;
    const probe = vi.spyOn(McpClients.prototype, "call").mockImplementation(function (this: McpClients, ...args) {
      const pending = original.apply(this, args);
      count += 1;
      if (count === 1) args[4].addEventListener("abort", disconnected, { once: true });
      if (count === 2) entered();
      return pending;
    });
    try {
      const before = mcp.initializations();
      const first = call(
        config,
        tool.id,
        who.botId,
        "lookup_stock",
        "X3",
        config.modelGateway.apiKey,
        controller.signal,
      ).catch((error: unknown) => error);
      await hold.arrived;
      const second = call(config, tool.id, who.botId);
      await secondEntered;
      controller.abort();
      expect(await first).toBeInstanceOf(Error);
      await firstDisconnected;
      hold.release();
      const result = await second;
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ content: [{ type: "text", text: "160" }], isError: false });
      expect(mcp.initializations() - before, "两个调用共用同一次初始化").toBe(1);
    } finally {
      hold.release();
      probe.mockRestore();
      agent.close();
    }
  });

  it("单个在途调用被取消，不关闭共享 Client，也不影响另一个调用", async () => {
    const who = await owner();
    const tool = await connect(who);
    const { agent, config } = await helloAgent(server.server.port, who.computer.computerId, who.computer.token);
    const hold = mcp.holdNextCall();
    const controller = new AbortController();
    let otherHold: ReturnType<TestMcp["holdNextCall"]> | undefined;
    try {
      const pending = call(config, tool.id, who.botId);
      await hold.arrived;
      const before = mcp.initializations();
      const cancelled = mcp.nextCancellation();
      otherHold = mcp.holdNextCall();
      const other = call(
        config,
        tool.id,
        who.botId,
        "lookup_stock",
        "X3",
        config.modelGateway.apiKey,
        controller.signal,
      ).catch((error: unknown) => error);
      await otherHold.arrived;
      controller.abort();
      expect(await other).toBeInstanceOf(Error);
      await cancelled;
      otherHold.release();
      hold.release();
      const result = await pending;
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ content: [{ type: "text", text: "160" }], isError: false });
      expect((await call(config, tool.id, who.botId)).status).toBe(200);
      expect(mcp.initializations() - before).toBe(0);
    } finally {
      controller.abort();
      otherHold?.release();
      hold.release();
      agent.close();
    }
  });

  it.each(["协议错误", "传输错误", "修改连接"])("%s 废弃缓存时，旧调用继续返回，新调用使用新 Client", async (cause) => {
    const persistent = await startTestMcp({ stateful: true });
    const who = await owner();
    const tool = await connect(who, false, "在途缓存", persistent.url);
    const { agent, config } = await helloAgent(server.server.port, who.computer.computerId, who.computer.token);
    const hold = persistent.holdNextCall();
    try {
      await persistent.waitForStreams(0);
      const pending = call(config, tool.id, who.botId);
      await hold.arrived;
      await persistent.waitForStreams(1);
      const before = persistent.initializations();
      if (cause !== "修改连接") {
        const failed = await call(
          config,
          tool.id,
          who.botId,
          "lookup_stock",
          cause === "协议错误" ? "rpcerror" : "httperror",
        );
        expect(failed.status).toBe(502);
        expect(await failed.json()).toEqual({
          error:
            cause === "协议错误"
              ? "插件调用失败：MCP 服务回了错误（代码 -32603）"
              : "插件调用失败：MCP 服务回了 HTTP 500",
        });
      } else {
        expect((await who.client.patch(`/api/tools/${tool.id}`, { name: "已修改" })).status).toBe(200);
        await agent.expect("config");
      }
      const newStream = persistent.nextStream();
      expect((await call(config, tool.id, who.botId)).status).toBe(200);
      await newStream;
      expect(persistent.activeStreams(), "旧调用仍在途，新旧 Client 各自保持连接").toBe(2);
      expect(persistent.initializations() - before).toBe(1);
      hold.release();
      const result = await pending;
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ content: [{ type: "text", text: "160" }], isError: false });
      await persistent.waitForStreams(1);
      expect((await call(config, tool.id, who.botId)).status).toBe(200);
      expect(persistent.initializations() - before, "旧 Client 收尾不废弃新的缓存").toBe(1);
      expect((await who.client.delete(`/api/tools/${tool.id}`)).status).toBe(204);
      await persistent.waitForStreams(0);
    } finally {
      hold.release();
      await who.client.delete(`/api/tools/${tool.id}`);
      agent.close();
      await persistent.close();
    }
  });

  it("initialize 失败只回固定分类，下次调用重新建立连接", async () => {
    const who = await owner();
    const tool = await connect(who);
    const { agent, config } = await helloAgent(server.server.port, who.computer.computerId, who.computer.token);
    const errorLog = vi.spyOn(console, "error");
    const warningLog = vi.spyOn(console, "warn");
    try {
      mcp.failNextInitialization();
      const failed = await call(config, tool.id, who.botId);
      expect(failed.status).toBe(502);
      expect(await failed.json()).toEqual({ error: "插件调用失败：MCP 服务回了错误（代码 -32603）" });
      const before = mcp.initializations();
      expect((await call(config, tool.id, who.botId)).status).toBe(200);
      expect(mcp.initializations() - before).toBe(1);
      expect(JSON.stringify([...errorLog.mock.calls, ...warningLog.mock.calls])).not.toContain("proxy-private-token");
    } finally {
      errorLog.mockRestore();
      warningLog.mockRestore();
      agent.close();
    }
  });

  it.each([false, true])("请求体超过 20 MiB 回 413，不触达上游（分块：%s）", async (chunked) => {
    const who = await owner();
    const tool = await connect(who);
    const { agent, config } = await helloAgent(server.server.port, who.computer.computerId, who.computer.token);
    try {
      const before = mcp.initializations();
      const calls = mcp.calls().length;
      const oversized = new Uint8Array(20 * 1024 * 1024 + 1);
      const body = chunked
        ? new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(oversized);
              controller.close();
            },
          })
        : oversized;
      const init: RequestInit & { duplex?: "half" } = {
        method: "POST",
        headers: { authorization: `Bearer ${config.modelGateway.apiKey}`, "content-type": "application/json" },
        body,
        ...(chunked ? { duplex: "half" as const } : {}),
      };
      const result = await fetch(`${config.mcpProxy.baseUrl}/${tool.id}/call`, init);
      expect(result.status).toBe(413);
      expect(await result.json()).toEqual({ error: "请求体超过 20 MiB 上限" });
      expect(mcp.initializations()).toBe(before);
      expect(mcp.calls()).toHaveLength(calls);
    } finally {
      agent.close();
    }
  });

  it.each(["large", "large-error"])("上游 %s 结果超过 20 MiB 回固定中文错误，缓存仍可使用", async (sku) => {
    const who = await owner();
    const tool = await connect(who);
    const { agent, config } = await helloAgent(server.server.port, who.computer.computerId, who.computer.token);
    const errorLog = vi.spyOn(console, "error");
    const warningLog = vi.spyOn(console, "warn");
    try {
      const result = await call(config, tool.id, who.botId, "lookup_stock", sku);
      expect(result.status).toBe(502);
      expect(await result.json()).toEqual({ error: "插件结果超过 20 MiB 上限" });
      const before = mcp.initializations();
      expect((await call(config, tool.id, who.botId)).status).toBe(200);
      expect(mcp.initializations()).toBe(before);
      expect(JSON.stringify([...errorLog.mock.calls, ...warningLog.mock.calls])).not.toContain("proxy-private-token");
    } finally {
      errorLog.mockRestore();
      warningLog.mockRestore();
      agent.close();
    }
  });

  it("HTTP server.close 失败仍关闭 MCP，停机后 HTTP 调用不会新建 Client", async () => {
    const persistent = await startTestMcp({ stateful: true });
    const lifecycle = await startTestServer(database.db);
    const who = await owner(lifecycle);
    const tool = await connect(who, false, "关闭失败", persistent.url);
    const { agent, config } = await helloAgent(lifecycle.server.port, who.computer.computerId, who.computer.token);
    try {
      expect((await call(config, tool.id, who.botId)).status).toBe(200);
      await persistent.waitForStreams(1);
      const before = persistent.initializations();
      const failure = new Error("模拟 HTTP 关闭失败");
      const probe = vi.spyOn(HttpServer.prototype, "close").mockImplementationOnce(function (
        this: HttpServer,
        callback,
      ) {
        callback?.(failure);
        return this;
      });
      try {
        await expect(lifecycle.close()).rejects.toBe(failure);
      } finally {
        probe.mockRestore();
      }
      await persistent.waitForStreams(0);
      for (let i = 0; i < 2; i += 1) {
        const result = await call(config, tool.id, who.botId);
        expect(result.status).toBe(502);
        expect(await result.json()).toEqual({ error: "插件服务正在停机，请稍后再试" });
      }
      expect(persistent.initializations()).toBe(before);
    } finally {
      agent.close();
      await lifecycle.close();
      await persistent.close();
    }
  });

  it("本机只收到本机插件的凭据，远程不收到本机插件；切换 localOnly 后两条连接更新", async () => {
    const who = await owner();
    const proxy = await connect(who);
    const local = await connect(who, true, "本机插件");
    const remote = await ensureComputer(database.db, who.user.id, "remote");
    if (remote.token === null) throw new Error("远程电脑应新建");
    const first = await helloAgent(server.server.port, who.computer.computerId, who.computer.token);
    const second = await helloAgent(server.server.port, remote.computer.id, remote.token);
    try {
      expect(first.config.tools).toEqual([proxy, { ...local, authorization: SECRET }]);
      expect(second.config.tools).toEqual([proxy]);
      expect(JSON.stringify(second.config)).not.toContain("proxy-private-token");
      expect(first.config.tools[0]).not.toHaveProperty("authorization");
      expect((await call(first.config, local.id, who.botId)).status).toBe(409);
      const blocked = await call(second.config, local.id, who.botId);
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toEqual({ error: "这个插件只在本机用" });

      expect((await who.client.patch(`/api/tools/${local.id}`, { localOnly: false })).status).toBe(200);
      const localConfig = await first.agent.expect("config");
      const remoteConfig = await second.agent.expect("config");
      expect(localConfig.tools.every((entry) => !entry.localOnly && !("authorization" in entry))).toBe(true);
      expect(remoteConfig.tools.map((entry) => entry.id)).toEqual([proxy.id, local.id]);
      expect((await who.client.patch(`/api/tools/${proxy.id}`, { localOnly: true })).status).toBe(200);
      expect((await first.agent.expect("config")).tools[0]).toMatchObject({
        id: proxy.id,
        localOnly: true,
        authorization: SECRET,
      });
      expect((await second.agent.expect("config")).tools.map((entry) => entry.id)).toEqual([local.id]);
    } finally {
      first.agent.close();
      second.agent.close();
    }
  });

  it("真实 SDK callTool 使用服务器凭据，复用连接；修改和删除立即废弃缓存", async () => {
    const who = await owner();
    const tool = await connect(who);
    const { agent, config } = await helloAgent(server.server.port, who.computer.computerId, who.computer.token);
    try {
      const before = mcp.initializations();
      const result = await call(config, tool.id, who.botId);
      expect(result.status).toBe(200);
      expect(McpProxyCallResponse.parse(await result.json())).toEqual({
        content: [{ type: "text", text: "160" }],
        isError: false,
      });
      expect(mcp.calls().at(-1)).toEqual({ name: "lookup_stock", arguments: { sku: "X3" }, authorization: SECRET });
      expect((await call(config, tool.id, who.botId)).status).toBe(200);
      expect(mcp.initializations() - before, "两次调用只 initialize 一次").toBe(1);

      expect((await who.client.patch(`/api/tools/${tool.id}`, { name: "新名字" })).status).toBe(200);
      await agent.expect("config");
      expect((await call(config, tool.id, who.botId)).status).toBe(200);
      expect(mcp.initializations() - before, "改连接后重新 initialize").toBe(2);

      expect(
        (await who.client.patch(`/api/tools/${tool.id}`, { authorization: "Bearer rotated-private-token" })).status,
      ).toBe(200);
      const refreshed = await agent.expect("config");
      expect(JSON.stringify(refreshed)).not.toContain("rotated-private-token");
      const afterDiscovery = mcp.initializations();
      expect((await call(config, tool.id, who.botId)).status).toBe(200);
      expect(mcp.initializations() - afterDiscovery).toBe(1);
      expect(mcp.calls().at(-1)?.authorization).toBe("Bearer rotated-private-token");

      expect((await who.client.delete(`/api/tools/${tool.id}`)).status).toBe(204);
      const calls = mcp.calls().length;
      expect((await call(config, tool.id, who.botId)).status).toBe(404);
      expect(mcp.calls().length).toBe(calls);
    } finally {
      agent.close();
    }
  });

  it("坏 Bearer 401，跨归属连接、跨归属 Bot、未分配 Bot 和未知操作都 404，不触达 MCP", async () => {
    const first = await owner();
    const second = await owner();
    const tool = await connect(first);
    const unassigned = CreateBotResponse.parse(await (await first.client.post("/api/bots", { name: "未分配" })).json())
      .bot.id;
    const { agent, config } = await helloAgent(server.server.port, first.computer.computerId, first.computer.token);
    const other = await helloAgent(server.server.port, second.computer.computerId, second.computer.token);
    try {
      const before = mcp.calls().length;
      expect((await call(config, tool.id, first.botId, "lookup_stock", "X3", "bad-key")).status).toBe(401);
      expect((await call(other.config, tool.id, second.botId)).status).toBe(404);
      expect((await call(config, tool.id, second.botId)).status).toBe(404);
      expect((await call(config, tool.id, unassigned)).status).toBe(404);
      expect((await call(config, tool.id, first.botId, "unknown_tool")).status).toBe(404);
      expect(mcp.calls().length).toBe(before);
    } finally {
      agent.close();
      other.agent.close();
    }
  });

  it("成功和 isError 正文都脱敏，抛错回中文分类，响应和日志没有凭据；调用错误下次重连", async () => {
    const who = await owner();
    const tool = await connect(who);
    const { agent, config } = await helloAgent(server.server.port, who.computer.computerId, who.computer.token);
    const errorLog = vi.spyOn(console, "error");
    const warningLog = vi.spyOn(console, "warn");
    try {
      const echo = await call(config, tool.id, who.botId, "lookup_stock", "echo");
      expect(echo.status).toBe(200);
      const text = await echo.text();
      expect(text).toContain("[已隐藏]");
      expect(text).not.toContain("proxy-private-token");
      expect(text).not.toContain(encodeURIComponent(SECRET));

      const failed = await call(config, tool.id, who.botId, "lookup_stock", "error");
      expect(failed.status).toBe(200);
      const body = McpProxyCallResponse.parse(await failed.json());
      expect(body.isError).toBe(true);
      expect(JSON.stringify(body)).not.toContain("proxy-private-token");
      const before = mcp.initializations();
      expect((await call(config, tool.id, who.botId)).status).toBe(200);
      expect(mcp.initializations() - before, "业务错误保留旧 Client").toBe(0);

      const thrown = await call(config, tool.id, who.botId, "lookup_stock", "rpcerror");
      expect(thrown.status).toBe(502);
      const thrownText = await thrown.text();
      expect(thrownText).not.toContain("proxy-private-token");
      expect(thrownText).not.toContain(Buffer.from(SECRET).toString("base64"));
      expect(thrownText).toMatch(/插件调用失败/);
      const afterFailure = mcp.initializations();
      expect((await call(config, tool.id, who.botId)).status).toBe(200);
      expect(mcp.initializations() - afterFailure, "协议错误也丢弃旧 Client").toBe(1);
      expect(JSON.stringify([...errorLog.mock.calls, ...warningLog.mock.calls])).not.toContain("proxy-private-token");
    } finally {
      await who.client.delete(`/api/tools/${tool.id}`);
      agent.close();
      errorLog.mockRestore();
      warningLog.mockRestore();
    }
  });

  it("分享导入的待授权插件回 409，格式错误回 400，都不触达上游", async () => {
    const who = await owner();
    const tool = await connect(who);
    const exported = await who.client.post(`/api/bots/${who.botId}/template`, {
      skills: false,
      plugins: true,
      preferences: false,
    });
    expect(exported.status).toBe(200);
    const imported = await who.client.post("/api/bots/import", { template: await exported.json() });
    expect(imported.status).toBe(201);
    const botId = CreateBotResponse.parse(await imported.json()).bot.id;
    const listed = ToolListResponse.parse(await (await who.client.get("/api/tools")).json());
    const pending = listed.items.find((entry) => entry.assignedBotIds.includes(botId));
    if (pending === undefined) throw new Error("导入插件未创建");
    expect(pending.localOnly).toBe(false);
    const { agent, config } = await helloAgent(server.server.port, who.computer.computerId, who.computer.token);
    try {
      const before = mcp.calls().length;
      const blocked = await call(config, pending.id, botId);
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toEqual({ error: "这个插件还没补授权" });
      const bad = await fetch(`${config.mcpProxy.baseUrl}/${tool.id}/call`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.modelGateway.apiKey}`, "content-type": "application/json" },
        body: "[]",
      });
      expect(bad.status).toBe(400);
      expect(mcp.calls().length).toBe(before);
    } finally {
      agent.close();
    }
  });

  it("单次调用超过 60 秒回 504，共享 Client 仍可使用，超时后在途计数归零并可关闭", async () => {
    const persistent = await startTestMcp({ stateful: true });
    const who = await owner();
    const tool = await connect(who, false, "超时计数", persistent.url);
    const { agent, config } = await helloAgent(server.server.port, who.computer.computerId, who.computer.token);
    try {
      const cancelled = persistent.nextCancellation();
      const closed = persistent.nextCallClosed();
      const timedOut = await call(config, tool.id, who.botId, "lookup_stock", "hang");
      expect(timedOut.status).toBe(504);
      expect(await timedOut.json()).toEqual({ error: "插件调用超过 60 秒，请稍后再试" });
      await cancelled;
      await closed;
      const before = persistent.initializations();
      expect((await call(config, tool.id, who.botId)).status).toBe(200);
      expect(persistent.initializations() - before).toBe(0);
      expect((await who.client.patch(`/api/tools/${tool.id}`, { name: "超时后作废" })).status).toBe(200);
      await expect(
        persistent.waitForStreams(0, AbortSignal.timeout(2_000)),
        "超时必须减在途计数，作废后旧 Client 应关闭",
      ).resolves.toBeUndefined();
    } finally {
      await who.client.delete(`/api/tools/${tool.id}`);
      agent.close();
      await persistent.close();
    }
  }, 70_000);

  it("控制面停机关闭缓存的 MCP 连接，其他控制面实例的缓存照常使用", async () => {
    const persistent = await startTestMcp({ stateful: true });
    const lifecycle = await startTestServer(database.db);
    const who = await owner(lifecycle);
    const other = await owner();
    let stopped = false;
    const first = await helloAgent(lifecycle.server.port, who.computer.computerId, who.computer.token);
    const second = await helloAgent(server.server.port, other.computer.computerId, other.computer.token);
    try {
      const tool = await connect(who, false, "停机缓存", persistent.url);
      const otherTool = await connect(other, false, "另一实例", persistent.url);
      await persistent.waitForStreams(0);
      expect((await call(first.config, tool.id, who.botId)).status).toBe(200);
      expect((await call(second.config, otherTool.id, other.botId)).status).toBe(200);
      await persistent.waitForStreams(2);
      await lifecycle.close();
      stopped = true;
      await persistent.waitForStreams(1);
      expect((await call(second.config, otherTool.id, other.botId)).status).toBe(200);
      expect((await other.client.delete(`/api/tools/${otherTool.id}`)).status).toBe(204);
      await persistent.waitForStreams(0);
    } finally {
      first.agent.close();
      second.agent.close();
      if (!stopped) await lifecycle.close();
      await persistent.close();
    }
  });
});
