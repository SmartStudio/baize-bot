import {
  CreateBotResponse,
  McpProxyCallResponse,
  ToolListResponse,
  ToolResponse,
  type BotId,
  type ControlToAgent,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureComputer } from "../src/repo/computers.js";
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
) {
  return fetch(`${config.mcpProxy.baseUrl}/${id}/call`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ botId, tool, arguments: { sku } }),
  });
}

describe("MCP 控制面代执行", () => {
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
      expect(mcp.initializations() - before, "业务错误也丢弃旧 Client").toBe(1);

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

  it("上游调用超过 60 秒回 504，并废弃超时 Client", async () => {
    const who = await owner();
    const tool = await connect(who);
    const { agent, config } = await helloAgent(server.server.port, who.computer.computerId, who.computer.token);
    try {
      const timedOut = await call(config, tool.id, who.botId, "lookup_stock", "hang");
      expect(timedOut.status).toBe(504);
      expect(await timedOut.json()).toEqual({ error: "插件调用超过 60 秒，请稍后再试" });
      const before = mcp.initializations();
      expect((await call(config, tool.id, who.botId)).status).toBe(200);
      expect(mcp.initializations() - before).toBe(1);
    } finally {
      await who.client.delete(`/api/tools/${tool.id}`);
      agent.close();
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
      await expect.poll(() => persistent.activeStreams(), { message: "发现工具后即关闭临时 SDK 连接" }).toBe(0);
      expect((await call(first.config, tool.id, who.botId)).status).toBe(200);
      expect((await call(second.config, otherTool.id, other.botId)).status).toBe(200);
      await expect.poll(() => persistent.activeStreams()).toBe(2);
      await lifecycle.close();
      stopped = true;
      await expect.poll(() => persistent.activeStreams(), { message: "停机只关闭该实例缓存的连接" }).toBe(1);
      expect((await call(second.config, otherTool.id, other.botId)).status).toBe(200);
      expect((await other.client.delete(`/api/tools/${otherTool.id}`)).status).toBe(204);
      await expect.poll(() => persistent.activeStreams()).toBe(0);
    } finally {
      first.agent.close();
      second.agent.close();
      if (!stopped) await lifecycle.close();
      await persistent.close();
    }
  });
});
