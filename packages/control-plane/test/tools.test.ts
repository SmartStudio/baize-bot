import { CreateBotResponse, ToolListResponse, ToolResponse, type BotId } from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { helloAgent } from "./helpers/agent.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser } from "./helpers/fixtures.js";
import {
  ECHO_AUTHORIZATION_PREFIX,
  META_ECHO_AUTHORIZATION_PREFIX,
  startTestMcp,
  type TestMcp,
} from "./helpers/mcp.js";

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
  it("发现操作、加密认证、分配 Bot，并随变更重发不带凭据的 config", async () => {
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
      expect(createdConfig.tools).toEqual([created]);

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
      expect((await agent.expect("config")).tools).toEqual([updated]);

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

    const echoed = await first.client.post("/api/tools", {
      name: "回显凭据",
      url: mcp.url,
      authorization: `${ECHO_AUTHORIZATION_PREFIX}sk-create-echo-07`,
    });
    expect(echoed.status).toBe(400);
    const echoedBody = await echoed.text();
    expect(echoedBody, "MCP 报错原样带回了凭据，回包里要换掉").not.toContain("sk-create-echo-07");
    expect(echoedBody, "报错里凭据的 base64 也不能带回：对端写的文字一律不回给前端").not.toContain(
      Buffer.from(`${ECHO_AUTHORIZATION_PREFIX}sk-create-echo-07`).toString("base64"),
    );
    expect(echoedBody).toMatch(/连不上 MCP/);

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

  it("tools/list 成功但操作说明里写了收到的凭据：新建和补授权都 400，不落库、不进回包", async () => {
    const { client } = await owner();
    const token = "sk-meta-13";
    const secret = `${META_ECHO_AUTHORIZATION_PREFIX}${token}`;

    const created = await client.post("/api/tools", { name: "回显说明", url: mcp.url, authorization: secret });
    expect(created.status).toBe(400);
    const createdBody = await created.text();
    expect(createdBody, `回包里没有凭据：${createdBody}`).not.toContain(token);
    expect(await list(client), "一条都没落库").toEqual([]);

    const plain = await client.post("/api/tools", { name: "正常工具", url: mcp.url });
    expect(plain.status).toBe(201);
    const before = ToolResponse.parse(await plain.json()).tool;
    const patched = await client.patch(`/api/tools/${before.id}`, { authorization: secret });
    expect(patched.status).toBe(400);
    expect(await patched.text()).not.toContain(token);
    const after = await client.get("/api/tools");
    expect((await after.clone().text()).includes(token), "工具列表里没有凭据").toBe(false);
    expect(ToolListResponse.parse(await after.json()).items, "操作表和凭据都没换").toEqual([before]);
  });

  it("两个改审批的 PATCH 排在同一把行锁后面：后提交的不撤回先提交的", async () => {
    const { client } = await owner();
    const created = await client.post("/api/tools", { name: "行锁", url: mcp.url });
    expect(created.status).toBe(201);
    const { tool } = ToolResponse.parse(await created.json());
    const allOff = [
      { name: "send_email", needsApproval: false },
      { name: "lookup_stock", needsApproval: false },
    ];
    expect((await client.patch(`/api/tools/${tool.id}`, { operations: allOff })).status).toBe(200);

    /** 本库里排在 tool_connections 行锁后面的连接数到了 count 才返回。靠 SQL 观察排队，不靠计时。 */
    const blockedReach = async (count: number): Promise<void> => {
      for (;;) {
        const rows = await database.sql`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND query ILIKE '%tool_connections%' AND cardinality(pg_blocking_pids(pid)) > 0
        `;
        if (rows.length >= count) return;
      }
    };
    let locked!: () => void;
    let unlock!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const release = new Promise<void>((resolve) => (unlock = resolve));
    const holder = database.sql.begin(async (tx) => {
      await tx`SELECT id FROM tool_connections WHERE id = ${tool.id} FOR UPDATE`;
      locked();
      await release;
    });
    const requests: Promise<Response>[] = [];
    try {
      await holding;
      requests.push(
        client.patch(`/api/tools/${tool.id}`, { operations: [{ name: "send_email", needsApproval: true }] }),
      );
      await blockedReach(1);
      requests.push(
        client.patch(`/api/tools/${tool.id}`, { operations: [{ name: "lookup_stock", needsApproval: true }] }),
      );
      await blockedReach(2);
    } finally {
      unlock();
      await holder;
    }
    expect((await Promise.all(requests)).map((response) => response.status)).toEqual([200, 200]);
    const after = (await list(client)).find((one) => one.id === tool.id);
    expect(
      Object.fromEntries(after?.operations.map((op) => [op.name, op.needsApproval]) ?? []),
      "两个 PATCH 各自要的审批都在",
    ).toEqual({ send_email: true, lookup_stock: true });
  });
});
