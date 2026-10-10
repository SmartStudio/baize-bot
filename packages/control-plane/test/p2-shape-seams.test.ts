import { AgentToControl, CreateBotResponse, MessageId, MessageListResponse } from "@baize/shared";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { helloAgent } from "./helpers/agent.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser } from "./helpers/fixtures.js";

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

it("config 恒带 preferences 和 brand：没有偏好是空数组，没写过手册是 null，运行器靠它们对账", async () => {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const { agent, config } = await helloAgent(server.server.port, computer.computerId, computer.token);
  try {
    expect(config.preferences).toEqual([]);
    expect(config.brand).toBeNull();
  } finally {
    agent.close();
  }
});

const STUB_EVENTS = [["metric_report", { value: 2, label: "星" }]] as const;

const fill = (value: unknown, ids: { readonly bot: string; readonly group: string }): unknown =>
  JSON.parse(JSON.stringify(value).replaceAll("{bot}", ids.bot).replaceAll("{group}", ids.group));

it.each(STUB_EVENTS)(
  "第 2 期的上行 %s 抛错只记错误类别和 id，同一条连接上接着发的 bot_text 落库、run_done 收到确认",
  async (type, fields) => {
    const user = await makeUser(database.db);
    const computer = await makeComputer(database.db, user.id);
    const client = new ApiClient(server.server.port);
    expect((await client.login(user.email, PASSWORD)).status).toBe(200);
    const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小服" })).json());
    const ids = { bot: created.bot.id, group: created.group.id };
    const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await client.post(`/api/groups/${created.group.id}/messages`, { text: "记住我喜欢短句" })).status).toBe(
        201,
      );
      const prompt = await agent.expect("prompt");
      const run = { runId: prompt.runId, botId: created.bot.id, groupId: created.group.id };
      agent.send(AgentToControl.parse({ type, ...run, ...(fill(fields, ids) as object) }));
      agent.send({
        ...run,
        type: "bot_text",
        messageId: MessageId.parse(`m-after-${type}`),
        delta: "桩之后照常说话",
        done: true,
      });
      agent.send({ ...run, type: "run_done", steps: 1, inputTokens: 0, outputTokens: 0 });
      await agent.ack(prompt.runId);
      const history = MessageListResponse.parse(
        await (await client.get(`/api/groups/${created.group.id}/messages`)).json(),
      );
      expect(
        history.messages.map((message) => (message.body.kind === "bot" ? message.body.text : message.body.kind)),
        "桩抛错之后同一条连接上的 bot_text 要落库",
      ).toContain("桩之后照常说话");
      expect(logged.mock.calls, "接缝占位抛错要记录错误类别和 id，不打印异常对象").toEqual([
        [`处理电脑 ${computer.computerId} run ${prompt.runId} 的报文出错：Error`],
      ]);
    } finally {
      logged.mockRestore();
      agent.close();
    }
  },
);
