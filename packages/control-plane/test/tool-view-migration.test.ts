import { randomUUID } from "node:crypto";
import { CreateBotResponse, MessageListResponse } from "@baize/shared";
import { expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { PASSWORD, makeComputer, makeUser } from "./helpers/fixtures.js";
import { helloAgent } from "./helpers/agent.js";
import { ApiClient, startTestServer } from "./helpers/client.js";
import { createTestDb } from "./helpers/db.js";

it("老格式的 tool_call 消息和审批行迁移后能从 HTTP 读出来", async () => {
  const database = await createTestDb();
  const server = await startTestServer(database.db);
  let agent: Awaited<ReturnType<typeof helloAgent>>["agent"] | null = null;
  try {
    const user = await makeUser(database.db);
    const computer = await makeComputer(database.db, user.id);
    const client = new ApiClient(server.server.port);
    expect((await client.login(user.email, PASSWORD)).status).toBe(200);
    const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小服" })).json());
    agent = (await helloAgent(server.server.port, computer.computerId, computer.token)).agent;
    expect((await client.post(`/api/groups/${created.group.id}/messages`, { text: "处理老数据" })).status).toBe(201);
    const prompt = await agent.expect("prompt");

    const applied0010 = await database.sql<{ name: string }[]>`
      SELECT name FROM _migrations WHERE name LIKE '0010_%'
    `;
    if (applied0010[0] !== undefined) {
      await database.sql.unsafe('ALTER TABLE "approvals" ADD COLUMN "summary" text DEFAULT \'\' NOT NULL');
      await database.sql.unsafe('ALTER TABLE "approvals" DROP COLUMN "view"');
      await database.sql.unsafe('ALTER TABLE "approvals" ADD COLUMN "kind" text');
      await database.sql`DELETE FROM _migrations WHERE name = ${applied0010[0].name}`;
    }

    const toolMessageId = randomUUID();
    const approvalMessageId = randomUUID();
    const approvalId = randomUUID();
    await database.sql`
      INSERT INTO messages (id, group_id, body, created_at)
      VALUES (
        ${toolMessageId},
        ${created.group.id},
        ${JSON.stringify({
          kind: "tool_call",
          botId: created.bot.id,
          tool: "legacy_lookup",
          argsSummary: "旧参数字符串",
          status: "running",
          durationMs: null,
        })}::jsonb,
        now()
      )
    `;
    await database.sql`
      INSERT INTO messages (id, group_id, body, created_at)
      VALUES (
        ${approvalMessageId},
        ${created.group.id},
        ${JSON.stringify({ kind: "approval", approvalId })}::jsonb,
        now()
      )
    `;
    await database.sql`
      INSERT INTO approvals (
        id, run_id, bot_id, group_id, call_id, tool, kind, action, summary, status, message_id, created_at
      )
      VALUES (
        ${approvalId}, ${prompt.runId}, ${created.bot.id}, ${created.group.id}, 'legacy-call', 'legacy_pay', 'pay', 'spend',
        '旧审批字符串', 'pending', ${approvalMessageId}, now()
      )
    `;

    const applied = await runMigrations(database.sql);
    expect(
      applied.some((name) => name.startsWith("0010_")),
      "应实际应用 0010 迁移",
    ).toBe(true);

    const response = await client.get(`/api/groups/${created.group.id}/messages`);
    expect(response.status).toBe(200);
    const page = MessageListResponse.parse(await response.json());
    const tool = page.messages.find((message) => message.id === toolMessageId);
    expect(tool?.body).toEqual({
      kind: "tool_call",
      runId: "",
      botId: created.bot.id,
      tool: "legacy_lookup",
      view: { kind: "mcp", server: "", tool: "legacy_lookup", params: [], raw: "旧参数字符串" },
      status: "running",
      durationMs: null,
    });
    expect(page.approvals).toMatchObject([
      {
        id: approvalId,
        view: { kind: "mcp", server: "", tool: "legacy_pay", params: [], raw: "旧审批字符串" },
      },
    ]);
  } finally {
    agent?.close();
    await server.close();
    await database.close();
  }
});
