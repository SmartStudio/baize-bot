import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MCP_DISCOVERY_MAX_BYTES,
  MCP_DISCOVERY_MAX_OPERATIONS,
  McpDiscoveryReason,
  ToolListResponse,
  ToolResponse,
  type ToolOperation,
} from "@baize/shared";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { makeComputer, makeUser, PASSWORD } from "./helpers/fixtures.js";
import { ensureComputer } from "../src/repo/computers.js";
import { startTestMcp } from "./helpers/mcp.js";

let database: TestDb;
let server: TestServer;
const URL = "http://127.0.0.1:1/mcp";
const operations: ToolOperation[] = [
  { name: "send_email", description: "发送邮件", inputSchema: { type: "object" }, needsApproval: true },
  { name: "lookup_stock", description: "查询库存", inputSchema: { type: "object" }, needsApproval: false },
];
const failures = {
  unreachable: "连不上 MCP：这个地址连不上",
  timeout: "连不上 MCP：探测超时",
  not_mcp: "连不上 MCP：这个地址不是可用的 MCP 服务",
  unauthorized: "连不上 MCP：MCP 服务拒绝了凭据或要求授权",
  rejected: "连不上 MCP：MCP 服务拒绝了探测请求",
  echoes_credential: "MCP 服务在操作的名字、说明或参数表里写了收到的凭据，没有保存。请检查这个 MCP 服务。",
  invalid_operations: "MCP 服务返回的操作表格式不正确或超过限制，没有保存。",
};

beforeAll(async () => {
  database = await createTestDb();
  server = await startTestServer(database.db);
});
afterAll(async () => {
  await server.close();
  await database.close();
});

async function owner(at = server) {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = at.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  return { user, computer, client };
}
async function list(client: ApiClient) {
  return ToolListResponse.parse(await (await client.get("/api/tools")).json()).items;
}
async function barrier(agent: AgentClient) {
  const seq = agent.sendMalformedReliable({ type: "unknown_barrier" });
  await expect.poll(() => agent.uplinkAcks().some((ack) => ack.upTo >= seq)).toBe(true);
}

describe("本机 MCP 发现", () => {
  it("关闭的端口由本机回报两个操作，成功落库、列出，并下发 config，凭据不进 agent_outbox", async () => {
    const { client, computer } = await owner();
    const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
    const authorization = "Bearer local-discovery-fixture";
    try {
      const response = client.post("/api/tools", { name: "本机", url: URL, localOnly: true, authorization });
      const request = await agent.expect("mcp_discover");
      expect(request.url).toBe(URL);
      expect(request.authorization).toBe(authorization);
      const rows = await database.sql`SELECT body FROM agent_outbox WHERE computer_id = ${computer.computerId}`;
      expect(rows).toEqual([]);
      expect(JSON.stringify(rows).includes(authorization)).toBe(false);
      agent.send({ type: "mcp_discovered", requestId: request.requestId, result: { ok: true, operations } });
      const createdResponse = await response;
      expect(createdResponse.status).toBe(201);
      const tool = ToolResponse.parse(await createdResponse.json()).tool;
      expect(tool.operations).toEqual(operations);
      expect(await list(client)).toEqual([tool]);
      expect((await agent.expect("config")).tools).toEqual([{ ...tool, authorization }]);
      const after = await database.sql`SELECT body FROM agent_outbox WHERE computer_id = ${computer.computerId}`;
      expect(after).toEqual([]);
    } finally {
      agent.close();
    }
  });

  it.each(McpDiscoveryReason.options)("失败枚举 %s 使用控制面的固定文案，不保存连接", async (reason) => {
    const { client, computer } = await owner();
    const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
    try {
      const pending = client.post("/api/tools", { name: "失败", url: URL, localOnly: true });
      const request = await agent.expect("mcp_discover");
      agent.send({ type: "mcp_discovered", requestId: request.requestId, result: { ok: false, reason } });
      const response = await pending;
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: failures[reason] });
      expect(await list(client)).toEqual([]);
    } finally {
      agent.close();
    }
  });

  it("没有在线本机电脑返回 409，只有远程电脑在线也不把探测派给它", async () => {
    const { client, user } = await owner();
    const body = { name: "离线", url: URL, localOnly: true };
    const offline = await client.post("/api/tools", body);
    expect(offline.status).toBe(409);
    expect(await offline.json()).toEqual({ error: "这条连接只在本机用，探测要你的电脑开着白泽" });
    const remote = await ensureComputer(database.db, user.id, "remote");
    if (remote.token === null) throw new Error("没有测试远程 token");
    const { agent } = await helloAgent(server.server.port, remote.computer.id, remote.token);
    try {
      expect((await client.post("/api/tools", body)).status).toBe(409);
      await barrier(agent);
      expect(agent.received().some((message) => message.type === "mcp_discover")).toBe(false);
      expect(await list(client)).toEqual([]);
    } finally {
      agent.close();
    }
  });

  it("等待时限可注入，超时清掉登记，迟到的成功回报不落库", async () => {
    const quick = await startTestServer(database.db, {}, undefined, undefined, undefined, {
      mcpDiscoveryTimeoutMs: 50,
    });
    const { client, computer } = await owner(quick);
    const { agent } = await helloAgent(quick.server.port, computer.computerId, computer.token);
    try {
      const pending = client.post("/api/tools", { name: "超时", url: URL, localOnly: true });
      const request = await agent.expect("mcp_discover");
      const response = await pending;
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: failures.timeout });
      agent.send({ type: "mcp_discovered", requestId: request.requestId, result: { ok: true, operations } });
      await barrier(agent);
      expect(await list(client)).toEqual([]);
    } finally {
      agent.close();
      await quick.close();
    }
  });

  it("别人的电脑、同一归属人的远程电脑和未登记 requestId 不生效", async () => {
    const who = await owner();
    const other = await owner();
    const { agent: local } = await helloAgent(server.server.port, who.computer.computerId, who.computer.token);
    const { agent: stranger } = await helloAgent(server.server.port, other.computer.computerId, other.computer.token);
    const remoteComputer = await ensureComputer(database.db, who.user.id, "remote");
    if (remoteComputer.token === null) throw new Error("没有远程 token");
    const { agent: remote } = await helloAgent(server.server.port, remoteComputer.computer.id, remoteComputer.token);
    try {
      let settled = false;
      const pending = who.client.post("/api/tools", { name: "身份", url: URL, localOnly: true }).then((response) => {
        settled = true;
        return response;
      });
      const request = await local.expect("mcp_discover");
      for (const wrong of [stranger, remote]) {
        wrong.send({ type: "mcp_discovered", requestId: request.requestId, result: { ok: true, operations } });
        await barrier(wrong);
        expect(settled).toBe(false);
      }
      local.send({ type: "mcp_discovered", requestId: randomUUID(), result: { ok: true, operations } });
      await barrier(local);
      expect(settled).toBe(false);
      local.send({ type: "mcp_discovered", requestId: request.requestId, result: { ok: true, operations } });
      expect((await pending).status).toBe(201);
      await local.expect("config");
      await remote.expect("config");
    } finally {
      local.close();
      stranger.close();
      remote.close();
    }
  });

  it("换连接立即结束旧等待，旧连接代际和旧 requestId 不能完成新探测", async () => {
    const { client, computer } = await owner();
    const old = await helloAgent(server.server.port, computer.computerId, computer.token);
    const abandoned = client.post("/api/tools", { name: "旧请求", url: URL, localOnly: true });
    const oldRequest = await old.agent.expect("mcp_discover");
    const current = await helloAgent(server.server.port, computer.computerId, computer.token);
    try {
      const disconnected = await abandoned;
      expect(disconnected.status).toBe(400);
      expect(await disconnected.json()).toEqual({ error: "本机电脑断开了，请打开白泽后重试" });
      let settled = false;
      const pending = client.post("/api/tools", { name: "新请求", url: URL, localOnly: true }).then((response) => {
        settled = true;
        return response;
      });
      const request = await current.agent.expect("mcp_discover");
      current.agent.socket.send(
        JSON.stringify({
          conn: old.welcome.conn,
          body: { type: "mcp_discovered", requestId: request.requestId, result: { ok: true, operations } },
        }),
      );
      current.agent.send({ type: "mcp_discovered", requestId: oldRequest.requestId, result: { ok: true, operations } });
      await barrier(current.agent);
      expect(settled).toBe(false);
      current.agent.send({ type: "mcp_discovered", requestId: request.requestId, result: { ok: true, operations } });
      expect((await pending).status).toBe(201);
      await current.agent.expect("config");
      expect((await list(client)).map((tool) => tool.name)).toEqual(["新请求"]);
    } finally {
      old.agent.close();
      current.agent.close();
    }
  });

  it("电脑断开立即以固定错误结束 HTTP 等待", async () => {
    const { client, computer } = await owner();
    const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
    const pending = client.post("/api/tools", { name: "断开", url: URL, localOnly: true });
    await agent.expect("mcp_discover");
    agent.close();
    const response = await pending;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "本机电脑断开了，请打开白泽后重试" });
    expect(await list(client)).toEqual([]);
  });

  it("控制面再次检查电脑回报的凭据回显", async () => {
    const { client, computer } = await owner();
    const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
    const authorization = "Bearer echoed-fixture";
    try {
      const pending = client.post("/api/tools", { name: "回显", url: URL, authorization, localOnly: true });
      const request = await agent.expect("mcp_discover");
      agent.send({
        type: "mcp_discovered",
        requestId: request.requestId,
        result: {
          ok: true,
          operations: [{ ...operations[0]!, description: authorization }],
        },
      });
      const response = await pending;
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: failures.echoes_credential });
      expect(await list(client)).toEqual([]);
    } finally {
      agent.close();
    }
  });

  it.each([
    ["格式", [{ name: 42 }]],
    ["个数", Array.from({ length: MCP_DISCOVERY_MAX_OPERATIONS + 1 }, () => operations[0])],
    ["大小", [{ ...operations[0], description: "x".repeat(MCP_DISCOVERY_MAX_BYTES) }]],
  ])("拒绝操作表%s越界，按固定错误结束等待", async (_, invalid) => {
    const { client, computer } = await owner();
    const { agent, welcome } = await helloAgent(server.server.port, computer.computerId, computer.token);
    try {
      const pending = client.post("/api/tools", { name: "校验", url: URL, localOnly: true });
      const request = await agent.expect("mcp_discover");
      agent.socket.send(
        JSON.stringify({
          conn: welcome.conn,
          body: {
            type: "mcp_discovered",
            requestId: request.requestId,
            result: { ok: true, operations: invalid },
          },
        }),
      );
      const response = await pending;
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: failures.invalid_operations });
      expect(await list(client)).toEqual([]);
    } finally {
      agent.close();
    }
  });

  it("PATCH 按更新后的 localOnly 在本机换凭据，失败不改旧值，成功保留同名审批设置", async () => {
    const { client, computer } = await owner();
    const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
    try {
      const pending = client.post("/api/tools", {
        name: "换授权",
        url: URL,
        authorization: "Bearer before-fixture",
        localOnly: true,
      });
      const request = await agent.expect("mcp_discover");
      agent.send({ type: "mcp_discovered", requestId: request.requestId, result: { ok: true, operations } });
      const tool = ToolResponse.parse(await (await pending).json()).tool;
      await agent.expect("config");
      expect(
        (await client.patch(`/api/tools/${tool.id}`, { operations: [{ name: "lookup_stock", needsApproval: true }] }))
          .status,
      ).toBe(200);
      const original = (await agent.expect("config")).tools[0]!;
      const before =
        await database.sql`SELECT authorization_enc, operations FROM tool_connections WHERE id = ${tool.id}`;
      const failed = client.patch(`/api/tools/${tool.id}`, {
        authorization: "Bearer after-fixture",
        name: "失败不能改名",
      });
      const retry = await agent.expect("mcp_discover");
      expect(retry.authorization).toBe("Bearer after-fixture");
      agent.send({ type: "mcp_discovered", requestId: retry.requestId, result: { ok: false, reason: "unauthorized" } });
      expect((await failed).status).toBe(400);
      expect(await list(client)).toEqual([{ ...tool, operations: original.operations }]);
      expect(
        await database.sql`SELECT authorization_enc, operations FROM tool_connections WHERE id = ${tool.id}`,
      ).toEqual(before);
      const succeeded = client.patch(`/api/tools/${tool.id}`, {
        authorization: "Bearer after-fixture",
        localOnly: true,
      });
      const again = await agent.expect("mcp_discover");
      agent.send({ type: "mcp_discovered", requestId: again.requestId, result: { ok: true, operations } });
      expect((await succeeded).status).toBe(200);
      const updated = (await agent.expect("config")).tools[0]!;
      expect(updated.operations.find((operation) => operation.name === "lookup_stock")?.needsApproval).toBe(true);
      expect(updated.localOnly && updated.authorization === "Bearer after-fixture").toBe(true);
    } finally {
      agent.close();
    }
  });

  it.each(["file:///tmp/mcp", "ftp://127.0.0.1/mcp", "ws://127.0.0.1/mcp"])(
    "创建边界拒绝非 HTTP 地址 %s",
    async (url) => {
      const { client } = await owner();
      expect((await client.post("/api/tools", { name: "协议", url, localOnly: true })).status).toBe(400);
      expect(await list(client)).toEqual([]);
    },
  );

  it("PATCH 同时切换 localOnly 和凭据时按新位置探测，null 在本机匿名重探", async () => {
    const mcp = await startTestMcp();
    const { client, computer } = await owner();
    const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
    try {
      const initial = await client.post("/api/tools", { name: "切换位置", url: mcp.url, localOnly: false });
      expect(initial.status).toBe(201);
      const tool = ToolResponse.parse(await initial.json()).tool;
      await agent.expect("config");
      const local = client.patch(`/api/tools/${tool.id}`, { localOnly: true, authorization: "Bearer local-fixture" });
      const request = await agent.expect("mcp_discover");
      expect(request.authorization).toBe("Bearer local-fixture");
      agent.send({ type: "mcp_discovered", requestId: request.requestId, result: { ok: true, operations } });
      expect((await local).status).toBe(200);
      await agent.expect("config");
      expect(mcp.authorizations()).not.toContain("Bearer local-fixture");

      const anonymous = client.patch(`/api/tools/${tool.id}`, { authorization: null });
      const noAuth = await agent.expect("mcp_discover");
      expect(noAuth.authorization).toBeUndefined();
      agent.send({ type: "mcp_discovered", requestId: noAuth.requestId, result: { ok: true, operations } });
      expect((await anonymous).status).toBe(200);
      const anonymousConfig = (await agent.expect("config")).tools[0]!;
      expect(anonymousConfig.localOnly && anonymousConfig.authorization === null).toBe(true);

      const remote = await client.patch(`/api/tools/${tool.id}`, {
        localOnly: false,
        authorization: "Bearer control-fixture",
      });
      expect(remote.status).toBe(200);
      expect((await agent.expect("config")).tools[0]?.localOnly).toBe(false);
      expect(mcp.authorizations()).toContain("Bearer control-fixture");
    } finally {
      agent.close();
      await mcp.close();
    }
  });
});
