import {
  CreateBotResponse,
  MessageListResponse,
  RoutineResponse,
  type BotId,
  type ControlToAgent,
  type GroupId,
} from "@baize/shared";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, waitFor, type TestComputer } from "./helpers/fixtures.js";
import { gatedDb } from "./helpers/gated-db.js";

let database: TestDb;
let gate: ReturnType<typeof gatedDb>;
let server: TestServer;
const agents: AgentClient[] = [];

beforeAll(async () => {
  database = await createTestDb();
  gate = gatedDb(database.sql);
  server = await startTestServer(gate.db);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const agent of agents) agent.close();
  await Promise.all(agents.map((agent) => agent.closed()));
  agents.length = 0;
});

afterAll(async () => {
  await server.close();
  await database.close();
});

type Prompt = Extract<ControlToAgent, { type: "prompt" }>;
type Bot = { readonly botId: BotId; readonly groupId: GroupId };
type Rig = {
  readonly client: ApiClient;
  readonly computer: TestComputer;
  readonly agent: AgentClient;
  readonly bots: readonly [Bot, Bot];
};

/** 一个用户、一台在线电脑、两个单 Bot 群。 */
async function rig(): Promise<Rig> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const create = async (name: string): Promise<Bot> => {
    const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name })).json());
    return { botId: created.bot.id, groupId: created.group.id };
  };
  const bots: [Bot, Bot] = [await create("甲"), await create("乙")];
  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  agents.push(agent);
  return { client, computer, agent, bots };
}

async function say(who: Rig, bot: Bot, text: string): Promise<Prompt> {
  expect((await who.client.post(`/api/groups/${bot.groupId}/messages`, { text })).status).toBe(201);
  return who.agent.expect("prompt");
}

async function finish(who: Rig, bot: Bot, prompt: Prompt): Promise<void> {
  who.agent.send({
    type: "run_done",
    runId: prompt.runId,
    botId: bot.botId,
    groupId: bot.groupId,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
  });
  await who.agent.ack(prompt.runId);
}

async function errorsIn(client: ApiClient, groupId: GroupId): Promise<string[]> {
  const listed = MessageListResponse.parse(await (await client.get(`/api/groups/${groupId}/messages`)).json());
  return listed.messages.flatMap((message) =>
    message.body.kind === "system" && message.body.tone === "error" ? [message.body.text] : [],
  );
}

const reportedAs = (detail: string) => `电脑那边没干成这件事，跑活的进程出错了。原话是：${detail}`;

it("指定的群号已不存在：错误不落到这台电脑别的群，日志只带截断的 detail", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const who = await rig();
  const [first] = who.bots;
  const busy = await say(who, first, "开工");
  const longDetail = `用户内容${"很长".repeat(100)}`;
  who.agent.send({ type: "agent_error", code: "runner_failed", detail: longDetail, groupId: randomUUID() as GroupId });
  who.agent.send({
    type: "agent_error",
    code: "runner_failed",
    detail: "排在后面、确定会落地的报错",
    groupId: first.groupId,
  });
  await waitFor(async () => (await errorsIn(who.client, first.groupId)).length > 0, "后一条带真群号的报错落地");
  expect(await errorsIn(who.client, first.groupId), "不存在的群号那条不能顺手落进有活在跑的群").toEqual([
    reportedAs("排在后面、确定会落地的报错"),
  ]);
  const logged = warn.mock.calls.map((call) => String(call[0]));
  expect(logged).toHaveLength(1);
  expect(logged[0]).toContain(who.computer.computerId);
  expect(logged[0]).toContain("runner_failed");
  expect(logged[0]).toContain(longDetail.slice(0, 20));
  expect(logged[0], "detail 要截断，不把整段用户内容打进日志").not.toContain(longDetail);
  await finish(who, first, busy);
});

it("指定的群号属于别人：即使这台电脑有一条 run 记在那个群名下，报错也不落进别人的群", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const who = await rig();
  const [first] = who.bots;
  const stranger = await makeUser(database.db);
  const strangerClient = server.client();
  expect((await strangerClient.login(stranger.email, PASSWORD)).status).toBe(200);
  const theirs = CreateBotResponse.parse(await (await strangerClient.post("/api/bots", { name: "别人的" })).json());
  const busy = await say(who, first, "开工");
  await database.sql`UPDATE runs SET group_id = ${theirs.group.id} WHERE id = ${busy.runId}`;
  who.agent.send({ type: "agent_error", code: "runner_failed", detail: "指向别人的群", groupId: theirs.group.id });
  who.agent.send({
    type: "agent_error",
    code: "runner_failed",
    detail: "排在后面、确定会落地的报错",
    groupId: first.groupId,
  });
  await waitFor(async () => (await errorsIn(who.client, first.groupId)).length > 0, "后一条带真群号的报错落地");
  expect(await errorsIn(strangerClient, theirs.group.id), "别人的群里不能出现这台电脑发来的报错").toEqual([]);
  expect(warn.mock.calls.map((call) => String(call[0]))).toHaveLength(1);
  await database.sql`UPDATE runs SET group_id = ${first.groupId} WHERE id = ${busy.runId}`;
  await finish(who, first, busy);
});

it("不带群号、两个群各有一条 open run：错误不落群，留一行带 computerId 和 code 的日志", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const who = await rig();
  const [first, second] = who.bots;
  const one = await say(who, first, "第一道开工");
  const two = await say(who, second, "第二道开工");
  who.agent.send({ type: "agent_error", code: "runner_failed", detail: "归属不明的错误" });
  who.agent.send({
    type: "agent_error",
    code: "runner_failed",
    detail: "排在后面、确定会落地的报错",
    groupId: first.groupId,
  });
  await waitFor(async () => (await errorsIn(who.client, first.groupId)).length > 0, "后一条带群号的报错落地");
  expect(await errorsIn(who.client, first.groupId)).toEqual([reportedAs("排在后面、确定会落地的报错")]);
  expect(await errorsIn(who.client, second.groupId)).toEqual([]);
  const logged = warn.mock.calls.map((call) => String(call[0]));
  expect(logged).toHaveLength(1);
  expect(logged[0]).toContain(who.computer.computerId);
  expect(logged[0]).toContain("runner_failed");
  expect(logged[0]).toContain("归属不明的错误");
  await finish(who, first, one);
  await finish(who, second, two);
});

it("指定群有一条 open run、别的群也有一条：报错只替指定群那条例行任务记失败", async () => {
  const who = await rig();
  const [first, second] = who.bots;
  const created = await who.client.post(`/api/bots/${first.botId}/routines`, {
    name: "每日早报",
    instruction: "汇总今天的工单",
    triggers: [],
    onFailure: "stop_and_tell",
  });
  expect(created.status).toBe(201);
  const routine = RoutineResponse.parse(await created.json()).routine;
  expect((await who.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
  const routinePrompt = await who.agent.expect("prompt");
  const other = await say(who, second, "另一个群也在干活");
  who.agent.send({ type: "agent_error", code: "runner_failed", detail: "例行那条的错", groupId: first.groupId });
  await finish(who, second, other);
  const runs = await database.sql<{ status: string; note: string }[]>`
    SELECT status, note FROM routine_runs WHERE routine_id = ${routine.id}`;
  expect(runs, "报错带了第一个群的群号，该群只有这一条 open run，别群的 open run 不能让它认不出来").toEqual([
    { status: "failed", note: "跑活的进程出错了" },
  ]);
  expect(await errorsIn(who.client, first.groupId)).toEqual([reportedAs("例行那条的错")]);
  expect(await errorsIn(who.client, second.groupId)).toEqual([]);
  expect(routinePrompt.groupId).toBe(first.groupId);
});

it("消息已查到群、插入前删号：删号等这条消息提交，回 201 而不是外键 500，随后级联删掉，不留孤儿消息", async () => {
  const user = await makeUser(database.db);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "群行锁" })).json());
  const keyShare = gate.arm(/^select "id" from "groups" where "groups"\."id" = \$1/, "after", created.group.id);
  const posting = client.post(`/api/groups/${created.group.id}/messages`, { text: "查到群之后、插入之前" });
  let deleting: Promise<Response> | undefined;
  let deleted = false;
  try {
    await keyShare.reached;
    deleting = client.request("DELETE", "/api/me", { email: user.email });
    void deleting.then(() => (deleted = true));
    await waitFor(async () => {
      if (deleted) return true;
      const blocked = await database.sql`
        SELECT 1 FROM pg_stat_activity
        WHERE datname = ${database.databaseName} AND wait_event_type = 'Lock' AND query ILIKE 'delete from%'`;
      return blocked.length > 0;
    }, "删号卡在群行锁上或已经提交");
    expect(deleted, "群行持有 KEY SHARE 时删号必须等，不能抢先提交").toBe(false);
    keyShare.release();
    const posted = await posting;
    expect(posted.status, await posted.clone().text()).toBe(201);
    expect((await deleting).status).toBe(204);
    const [left] = await database.sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM messages WHERE group_id = ${created.group.id}`;
    expect(left?.n).toBe(0);
  } finally {
    keyShare.release();
    await Promise.allSettled([posting, deleting]);
  }
});
