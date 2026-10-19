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
import { expectHello, helloAgent, openAgent, sendHello, type AgentClient } from "./helpers/agent.js";
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
  readonly generation: number;
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
  const { agent, config } = await helloAgent(server.server.port, computer.computerId, computer.token);
  agents.push(agent);
  return { client, computer, agent, generation: config.generation, bots };
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

it("指定的群号已不存在：错误不落到这台电脑别的群，日志里 detail 满 80 个码点才截", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const who = await rig();
  const [first] = who.bots;
  const busy = await say(who, first, "开工");
  const cases: readonly (readonly [detail: string, logged: string])[] = [
    ["短", "短"],
    ["a".repeat(80), "a".repeat(80)],
    ["a".repeat(81), `${"a".repeat(80)}…`],
    [`用户内容${"很长".repeat(100)}`, `用户内容${"很长".repeat(38)}…`],
    ["😀".repeat(80), "😀".repeat(80)],
    ["😀".repeat(81), `${"😀".repeat(80)}…`],
    [`${"a".repeat(79)}😀z`, `${"a".repeat(79)}😀…`],
    [`${"a".repeat(80)}😀`, `${"a".repeat(80)}…`],
    [`${"a".repeat(79)}😀😀`, `${"a".repeat(79)}😀…`],
  ];
  for (const [detail] of cases) {
    who.agent.send({ type: "agent_error", code: "runner_failed", detail, groupId: randomUUID() as GroupId });
  }
  who.agent.send({
    type: "agent_error",
    code: "runner_failed",
    detail: "排在后面、确定会落地的报错",
    groupId: first.groupId,
  });
  await waitFor(async () => (await errorsIn(who.client, first.groupId)).length > 0, "后一条带真群号的报错落地");
  expect(await errorsIn(who.client, first.groupId), "不存在的群号那几条不能顺手落进有活在跑的群").toEqual([
    reportedAs("排在后面、确定会落地的报错"),
  ]);
  const logged = warn.mock.calls.map((call) => String(call[0]));
  expect(logged).toHaveLength(cases.length);
  for (const line of logged) {
    expect(line).toContain(who.computer.computerId);
    expect(line).toContain("runner_failed");
  }
  const tails = logged.map((line) => line.slice(line.indexOf("runner_failed ") + "runner_failed ".length));
  expect(tails).toEqual(cases.map(([, expected]) => expected));
  expect(tails.join(""), "截断不留孤立的代理项").not.toMatch(
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
  );
  await finish(who, first, busy);
});

it("config_rejected 的 warn 里 detail 也按码点截到 80", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const who = await rig();
  const [first] = who.bots;
  who.agent.send({
    type: "agent_error",
    code: "config_rejected",
    generation: who.generation,
    detail: `用户内容${"😀".repeat(200)}`,
  });
  who.agent.send({
    type: "agent_error",
    code: "runner_failed",
    detail: "排在后面、确定会落地的报错",
    groupId: first.groupId,
  });
  await waitFor(async () => (await errorsIn(who.client, first.groupId)).length > 0, "后一条带真群号的报错落地");
  expect(warn.mock.calls.map((call) => String(call[0]).split("config：")[1])).toEqual([`用户内容${"😀".repeat(76)}…`]);
});

it("双实例旧握手在信封校验后结束 run：runId error 日志只留 80 个码点，第 80、81 个 emoji 不留孤立代理项", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const oldQueries = gatedDb(database.sql);
  const oldServer = await startTestServer(oldQueries.db);
  const openRuns = /^select "id", "group_id" from "runs" where/;
  let oldRead: ReturnType<typeof oldQueries.arm> | undefined;
  let currentRead: ReturnType<typeof gate.arm> | undefined;
  try {
    const who = await rig();
    const [first, second] = who.bots;
    const busy = await say(who, first, "跨实例收尾窗口");
    // 这条可靠上行排在 prompt 的下行确认后，落地证明旧 hello 不会把 R 当成尚未投递的 prompt 跳过。
    who.agent.send({
      type: "agent_error",
      code: "runner_failed",
      detail: "下行签收后屏障",
      groupId: second.groupId,
    });
    await waitFor(async () => (await errorsIn(who.client, second.groupId)).length > 0, "下行确认之后的报错落地");

    oldRead = oldQueries.arm(openRuns, "after", who.computer.computerId);
    const oldAgent = await openAgent(oldServer.server.port);
    agents.push(oldAgent);
    sendHello(oldAgent, who.computer.computerId, who.computer.token);
    await oldRead.reached;

    const current = await helloAgent(server.server.port, who.computer.computerId, who.computer.token, [busy.runId]);
    agents.push(current.agent);
    expect(await who.agent.closed(), "新实例接受更新的 hello，替换它自己的旧连接").toBe(4000);
    currentRead = gate.arm(openRuns, "before", who.computer.computerId);
    const detail = `${"a".repeat(79)}😀🧪后续用户内容`;
    current.agent.send({
      type: "agent_error",
      code: "runner_failed",
      runId: busy.runId,
      groupId: first.groupId,
      detail,
    });
    await currentRead.reached;

    // 此时信封已认领电脑行并通过 run 校验。旧实例拿的是收尾锁，仍能在这条查询发出前结束 R。
    oldRead.release();
    await expectHello(oldAgent);
    expect(await errorsIn(who.client, first.groupId), "旧 hello 的收尾通知已提交，随后才放行新实例的查询").toEqual([
      "电脑断过线，这次活没做完",
    ]);
    currentRead.release();
    current.agent.send({
      type: "agent_error",
      code: "runner_failed",
      detail: "runId 报错之后的落地屏障",
      groupId: second.groupId,
    });
    await waitFor(async () => (await errorsIn(who.client, second.groupId)).length === 2, "runId 报错之后的报错落地");
    await waitFor(
      async () => current.agent.uplinkAcks().some((ack) => ack.upTo >= current.welcome.upAcked + 2),
      "两条可靠上行累计确认",
    );
    expect(
      current.agent.uplinkAcks().flatMap((ack) => ack.rejected),
      "runId 校验当时通过，不能在信封层被 run_closed 拒收",
    ).toEqual([]);
    const lines = error.mock.calls.map((call) => String(call[0]));
    const prefix = `电脑 ${who.computer.computerId} 报错带的 run ${busy.runId} 不是它还开着的活，不收尾：runner_failed `;
    const logged = lines.filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length));
    expect(logged, "这条真实可达的 runId error 日志准确按 80 个码点截断").toEqual([`${"a".repeat(79)}😀…`]);
    expect(Array.from(logged[0] ?? "")).toHaveLength(81);
    expect(logged.join(""), "第 80 个 emoji 完整保留，第 81 个完整截掉，不新造孤立代理项").not.toMatch(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
    );
    expect(await errorsIn(who.client, first.groupId), "runId 错误仅记日志，不能再次收尾或落群").toEqual([
      "电脑断过线，这次活没做完",
    ]);
  } finally {
    oldRead?.release();
    currentRead?.release();
    await oldServer.close();
  }
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
  const keyShare = gate.arm(
    /^select "id" from "groups" where \("groups"\."id" = \$1 .* for share$/,
    "after",
    created.group.id,
  );
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
    expect(deleted, "群行持有 SHARE 时删号必须等，不能抢先提交").toBe(false);
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
