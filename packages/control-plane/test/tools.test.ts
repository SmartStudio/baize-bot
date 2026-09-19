import { CreateBotResponse, ToolListResponse, ToolResponse, type BotId } from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { helloAgent } from "./helpers/agent.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser } from "./helpers/fixtures.js";
import { startTestMcp, type TestMcp } from "./helpers/mcp.js";

let database: TestDb;
let server: TestServer;
let mcp: TestMcp;

beforeAll(async () => {
  database = await createTestDb();
  server = await startTestServer(database.db);
  mcp = await startTestMcp();
});

afterAll(async () => {
  await mcp.close();
  await server.close();
  await database.close();
});

async function owner(): Promise<{
  client: ApiClient;
  botId: BotId;
  computer: Awaited<ReturnType<typeof makeComputer>>;
}> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const response = await client.post("/api/bots", { name: "小服" });
  expect(response.status).toBe(201);
  const botId = CreateBotResponse.parse(await response.json()).bot.id;
  return { client, botId, computer };
}

async function list(client: ApiClient) {
  const response = await client.get("/api/tools");
  expect(response.status).toBe(200);
  return ToolListResponse.parse(await response.json()).items;
}

describe("工具连接", () => {
  it("发现操作、加密认证、分配 Bot，并随变更重发解密后的 config", async () => {
    const { client, botId, computer } = await owner();
    const { agent, config } = await helloAgent(server.server.port, computer.computerId, computer.token);
    expect(config.tools).toEqual([]);

    try {
      const response = await client.post("/api/tools", {
        name: "公司工具",
        url: mcp.url,
        authorization: "Bearer test-secret-42",
      });
      expect(response.status).toBe(201);
      const created = ToolResponse.parse(await response.json()).tool;
      expect(created.assignedBotIds).toEqual([]);
      expect(created.operations).toEqual([
        {
          name: "send_email",
          description: "对外发送邮件",
          inputSchema: expect.objectContaining({ type: "object" }),
          needsApproval: true,
        },
        {
          name: "lookup_stock",
          description: "查询库存",
          inputSchema: expect.objectContaining({ type: "object" }),
          needsApproval: false,
        },
      ]);
      expect(mcp.authorizations()).toContain("Bearer test-secret-42");
      expect(JSON.stringify(created)).not.toContain("test-secret-42");

      const raw = await database.sql`SELECT authorization_enc FROM tool_connections WHERE id = ${created.id}`;
      const ciphertext = raw[0]?.authorization_enc;
      expect(typeof ciphertext).toBe("string");
      expect(ciphertext).not.toContain("test-secret-42");
      expect(ciphertext).not.toBe("Bearer test-secret-42");

      const createdConfig = await agent.expect("config");
      expect(createdConfig.tools).toEqual([{ ...created, authorization: "Bearer test-secret-42" }]);

      const changed = await client.patch(`/api/tools/${created.id}`, {
        assignedBotIds: [botId],
        operations: [{ name: "lookup_stock", needsApproval: true }],
      });
      expect(changed.status).toBe(200);
      const updated = ToolResponse.parse(await changed.json()).tool;
      expect(updated.assignedBotIds).toEqual([botId]);
      expect(updated.operations.map((operation) => [operation.name, operation.needsApproval])).toEqual([
        ["send_email", true],
        ["lookup_stock", true],
      ]);
      expect(await list(client)).toEqual([updated]);
      expect((await agent.expect("config")).tools).toEqual([{ ...updated, authorization: "Bearer test-secret-42" }]);

      const deletedBot = await client.delete(`/api/bots/${botId}`);
      expect(deletedBot.status).toBe(204);
      expect((await list(client))[0]?.assignedBotIds, "外键级联清除已删除 Bot 的分配").toEqual([]);
      expect((await agent.expect("config")).tools[0]?.assignedBotIds).toEqual([]);

      const deleted = await client.delete(`/api/tools/${created.id}`);
      expect(deleted.status).toBe(204);
      expect(await deleted.text()).toBe("");
      expect(await list(client)).toEqual([]);
      expect((await agent.expect("config")).tools).toEqual([]);
    } finally {
      agent.close();
    }
  });

  it("拒绝坏地址、同名、未知操作、跨用户 Bot，并把别人的连接当 404", async () => {
    const first = await owner();
    const second = await owner();

    const bad = await first.client.post("/api/tools", { name: "坏地址", url: "http://127.0.0.1:1/mcp" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/连不上 MCP/);

    const created = await first.client.post("/api/tools", { name: "公司工具", url: mcp.url });
    expect(created.status).toBe(201);
    const tool = ToolResponse.parse(await created.json()).tool;

    expect((await first.client.post("/api/tools", { name: "公司工具", url: mcp.url })).status).toBe(409);
    expect(
      (
        await first.client.patch(`/api/tools/${tool.id}`, {
          operations: [{ name: "not_discovered", needsApproval: false }],
        })
      ).status,
    ).toBe(400);
    expect((await first.client.patch(`/api/tools/${tool.id}`, { assignedBotIds: [second.botId] })).status).toBe(400);
    expect(await list(first.client)).toEqual([tool]);

    expect((await second.client.patch(`/api/tools/${tool.id}`, { name: "窃取" })).status).toBe(404);
    expect((await second.client.delete(`/api/tools/${tool.id}`)).status).toBe(404);
    expect(await list(second.client)).toEqual([]);
    expect(await list(first.client)).toEqual([tool]);
  });
});
