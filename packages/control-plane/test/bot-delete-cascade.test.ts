import { ComputerTokenResponse, CreateBotResponse, type ControlToAgent, type GroupId } from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { helloAgent } from "./helpers/agent.js";
import { startTestServer, type ApiClient, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser } from "./helpers/fixtures.js";

type Prompt = Extract<ControlToAgent, { type: "prompt" }>;

let database: TestDb;
let server: TestServer;

beforeAll(async () => {
  database = await createTestDb();
  server = await startTestServer(database.db);
});

afterAll(async () => {
  await server.close();
  await database.close();
});

async function recreateConstraint(constraint: string): Promise<void> {
  const [found] = await database.sql<{ table: string; definition: string }[]>`
    SELECT conrelid::regclass::text AS table, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conname = ${constraint}`;
  if (found === undefined) throw new Error(`没有约束 ${constraint}`);
  await database.sql.unsafe(
    `ALTER TABLE ${found.table} DROP CONSTRAINT "${constraint}", ADD CONSTRAINT "${constraint}" ${found.definition}`,
  );
}

async function firingOrder(constraints: readonly string[]): Promise<string[]> {
  const rows = await database.sql<{ conname: string }[]>`
    SELECT c.conname FROM pg_trigger t JOIN pg_constraint c ON c.oid = t.tgconstraint
    WHERE t.tgrelid = c.confrelid AND c.conname IN ${database.sql(constraints)}
    ORDER BY t.tgname`;
  return [...new Set(rows.map((row) => row.conname))];
}

async function runRow(runId: string) {
  const [row] = await database.sql<
    {
      bot_id: string | null;
      group_id: string | null;
      trigger_message_id: string | null;
      continue_requested: boolean;
    }[]
  >`SELECT bot_id, group_id, trigger_message_id, continue_requested FROM runs WHERE id = ${runId}`;
  return row;
}

async function say(client: ApiClient, groupId: GroupId, text: string): Promise<void> {
  expect((await client.post(`/api/groups/${groupId}/messages`, { text })).status).toBe(201);
}

describe("删 Bot 的级联不随外键触发器的先后变", () => {
  it("单聊里有 run，run 的群置空排在单聊消息级联删除之前：删除仍回 204，run 作为账留着，三处归属都置空", async () => {
    await recreateConstraint("messages_group_id_groups_id_fk");
    expect(
      await firingOrder(["messages_group_id_groups_id_fk", "runs_group_id_groups_id_fk"]),
      "前提：删群时先置空 run 的群，再级联删消息",
    ).toEqual(["runs_group_id_groups_id_fk", "messages_group_id_groups_id_fk"]);

    const user = await makeUser(database.db);
    const computer = await makeComputer(database.db, user.id);
    const client = server.client();
    expect((await client.login(user.email, PASSWORD)).status).toBe(200);
    const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小服" })).json());
    const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
    try {
      await say(client, created.group.id, "做这件事");
      const prompt: Prompt = await agent.expect("prompt");
      const response = await client.delete(`/api/bots/${created.bot.id}`);
      expect(response.status, await response.clone().text()).toBe(204);
      expect(await runRow(prompt.runId)).toEqual({
        bot_id: null,
        group_id: null,
        trigger_message_id: null,
        continue_requested: false,
      });
    } finally {
      agent.close();
    }
  });

  it("单聊里的 run 请求过换电脑，Bot 置空排在单聊群级联删除之前：删除仍回 204，换电脑的标记清掉", async () => {
    await recreateConstraint("groups_solo_bot_id_bots_id_fk");
    expect(
      await firingOrder(["groups_solo_bot_id_bots_id_fk", "runs_bot_id_bots_id_fk"]),
      "前提：删 Bot 时先置空 run 的 Bot，再级联删单聊群",
    ).toEqual(["runs_bot_id_bots_id_fk", "groups_solo_bot_id_bots_id_fk"]);

    const user = await makeUser(database.db);
    const computer = await makeComputer(database.db, user.id);
    const client = server.client();
    expect((await client.login(user.email, PASSWORD)).status).toBe(200);
    const remote = ComputerTokenResponse.parse(await (await client.post("/api/computers/remote")).json());
    const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小运" })).json());
    const local = await helloAgent(server.server.port, computer.computerId, computer.token);
    const cloud = await helloAgent(server.server.port, remote.computerId, remote.token);
    try {
      await say(client, created.group.id, "把这周的报表整理一下");
      const prompt: Prompt = await local.agent.expect("prompt");
      const switched = await fetch(`http://localhost:${server.server.port}/hub/v1/lane/computer`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${local.config.modelGateway.apiKey}`,
          "x-baize-lane": `${prompt.botId}/${prompt.groupId}/${prompt.lane.epoch}`,
        },
        body: JSON.stringify({ runId: prompt.runId, kind: "remote" }),
      });
      expect(await switched.json()).toEqual({ result: "switching" });
      expect((await runRow(prompt.runId))?.continue_requested).toBe(true);

      const response = await client.delete(`/api/bots/${created.bot.id}`);
      expect(response.status, await response.clone().text()).toBe(204);
      expect(await runRow(prompt.runId)).toEqual({
        bot_id: null,
        group_id: null,
        trigger_message_id: null,
        continue_requested: false,
      });
    } finally {
      local.agent.close();
      cloud.agent.close();
    }
  });
});
