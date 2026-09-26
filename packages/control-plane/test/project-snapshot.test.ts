import { CreateBotResponse, CreateGroupResponse, ProjectResponse } from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeUser } from "./helpers/fixtures.js";
import { gatedDb } from "./helpers/gated-db.js";

let database: TestDb;
let gated: ReturnType<typeof gatedDb>;
let server: TestServer;

beforeAll(async () => {
  database = await createTestDb();
  gated = gatedDb(database.sql);
  server = await startTestServer(gated.db);
});

afterAll(async () => {
  await server.close();
  await database.close();
});

describe("项目页快照", () => {
  it("取回应的那条查询之前插进一句新话，said 和 replies 仍是同一轮", async () => {
    const user = await makeUser(database.db);
    const client = server.client();
    expect((await client.login(user.email, PASSWORD)).status).toBe(200);
    const first = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "阿文" })).json());
    const second = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "老周" })).json());
    const project = CreateGroupResponse.parse(
      await (await client.post("/api/groups", { title: "白泽开源首发", botIds: [first.bot.id, second.bot.id] })).json(),
    );
    const groupId = project.group.id;
    expect((await client.post(`/api/groups/${groupId}/messages`, { text: "第一句" })).status).toBe(201);

    // 回应里一定要排除花费卡，所以取回应的那条 SQL 必然带着这个字面量。
    const gate = gated.arm(/'cost'/);
    const reading = client.get(`/api/projects/${groupId}`);
    await gate.reached;
    expect((await client.post(`/api/groups/${groupId}/messages`, { text: "第二句" })).status).toBe(201);
    gate.release();

    const response = await reading;
    expect(response.status).toBe(200);
    const turn = ProjectResponse.parse(await response.json()).latestTurn;
    if (turn === null) throw new Error("说过话却没有最近一轮");
    expect(turn.said.body).toMatchObject({ kind: "user", text: "第一句" });
    expect(
      turn.replies.filter((message) => message.body.kind === "user"),
      "回应里不能混进下一轮的起点，Web 会把它当成回应藏掉",
    ).toEqual([]);

    const healed = ProjectResponse.parse(await (await client.get(`/api/projects/${groupId}`)).json());
    expect(healed.latestTurn?.said.body, "再拉一次就是新的一轮").toMatchObject({ kind: "user", text: "第二句" });
    expect(healed.olderTurns).toBe(1);
  });
});
