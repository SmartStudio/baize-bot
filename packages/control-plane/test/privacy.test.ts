import {
  BotListResponse,
  CreateBotResponse,
  CreateGroupResponse,
  RoutineResponse,
  type Routine,
  type UserId,
} from "@baize/shared";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as botsRepo from "../src/repo/bots.js";
import { helloAgent, openAgent, sendHello } from "./helpers/agent.js";
import { startTestServer, type ApiClient, type TestServer } from "./helpers/client.js";
import { contentJob, createDraft, nextOf, specOf, tweet, type ContentJob } from "./helpers/content.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, waitFor } from "./helpers/fixtures.js";
import { gatedDb } from "./helpers/gated-db.js";
import { startTestMcp, type TestMcp } from "./helpers/mcp.js";

/** 删号事务删完 runs 的那条。拦在它后面，Bot 锁已经拿着、用户还没删。 */
const DELETE_RUNS = /^delete from "runs"/;

/** 建 run 的插入。拦在它前面，派活已经过了成员检查、拿着 Bot 的共享锁。 */
const INSERT_RUN = /^insert into "runs"/;

/** 派活事务里写上下文窗口的那条；run 和 outbox 都还没提交。 */
const RECORD_CONTEXT = /^update "runs" set "unsettled_context"/;

/** 认电脑身份的那条。拦在它后面，身份已经认出来、hello 还没排进链。 */
const AUTHENTICATE = /^select .* from "computers" where "computers"\."id" = \$1 limit/;

/** 建多 Bot 群插群行的那条。拦在它前面，建群已经锁了成员 Bot 的行、占了编号。 */
const INSERT_GROUP = /^insert into "groups"/;

/** 派活选电脑时列这个人电脑的那条。拦在它前面，用户消息已经落库，派活还什么都没碰。 */
const LIST_COMPUTERS = /^select .* from "computers" where "computers"\."owner_id"/;

/** 事务里第一把共享 advisory 锁。建 run 和开项目的事务都是归属人锁打头，拦到的就是它。 */
const SHARED_ADVISORY = /^SELECT pg_advisory_xact_lock_shared\(/;

/** 派活读触发消息序号的那条。拦在它前面，成员名单已经读到、触发消息还没读。 */
const MESSAGE_SEQ = /^select "seq" from "messages"/;

let database: TestDb;
let gate: ReturnType<typeof gatedDb>;
let server: TestServer;
let mcp: TestMcp;

beforeAll(async () => {
  database = await createTestDb();
  gate = gatedDb(database.sql);
  server = await startTestServer(gate.db);
  mcp = await startTestMcp();
});

afterAll(async () => {
  await mcp.close();
  await server.close();
  await database.close();
});

const ACCOUNT_TOKEN = "ghp_privacy_account_secret";
const TOOL_SECRET = "Bearer privacy-tool-secret-9";

async function withJob(test: (job: ContentJob) => Promise<void>): Promise<void> {
  const job = await contentJob(server, database.db, [{ platform: "x", handle: "baize_x", token: ACCOUNT_TOKEN }]);
  try {
    await test(job);
  } finally {
    job.close();
  }
}

const deleteAccount = (client: ApiClient, email: unknown) => client.request("DELETE", "/api/me", { email });

/** runs 对用户、Bot、群的外键都是置空，删完按 owner_id 数恒为零，只能按 id 看那一行还在不在。 */
async function runExists(runId: string): Promise<boolean> {
  const rows = await database.sql`SELECT 1 FROM runs WHERE id = ${runId}`;
  return rows.length > 0;
}

/** 归属人已经没了的 run。删号把本人的 run 先删掉，按外键置空出来的一行都不该有。 */
async function orphanRuns(): Promise<number> {
  const rows = await database.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM runs WHERE owner_id IS NULL`;
  return rows[0]?.n ?? 0;
}

async function lockWaiters(): Promise<number> {
  const rows = await database.sql<{ waiting: number }[]>`
    SELECT count(*)::int AS waiting FROM pg_stat_activity
    WHERE datname = ${database.databaseName} AND wait_event_type = 'Lock'`;
  return rows[0]?.waiting ?? 0;
}

async function statusOf(computerId: string): Promise<string | undefined> {
  const rows = await database.sql<{ status: string }[]>`SELECT status FROM computers WHERE id = ${computerId}`;
  return rows[0]?.status;
}

/** 这些表里还挂在这个用户名下的行数。 */
async function leftovers(userId: UserId): Promise<Record<string, number>> {
  const [row] = await database.sql<Record<string, string>[]>`
    SELECT
      (SELECT count(*) FROM users WHERE id = ${userId}) AS users,
      (SELECT count(*) FROM bots WHERE owner_id = ${userId}) AS bots,
      (SELECT count(*) FROM groups WHERE owner_id = ${userId}) AS groups,
      (SELECT count(*) FROM computers WHERE owner_id = ${userId}) AS computers,
      (SELECT count(*) FROM accounts WHERE owner_id = ${userId}) AS accounts,
      (SELECT count(*) FROM drafts WHERE owner_id = ${userId}) AS drafts,
      (SELECT count(*) FROM sessions WHERE user_id = ${userId}) AS sessions`;
  if (row === undefined) throw new Error("计数查询没有返回行");
  return Object.fromEntries(Object.entries(row).map(([table, n]) => [table, Number(n)]));
}

it("导出里有偏好和品牌手册，grep 不到 token 和 authorization", async () => {
  await withJob(async (job) => {
    const { client } = job;

    job.agent.send({
      type: "preference_add",
      runId: job.runId,
      botId: job.botId,
      groupId: job.groupId,
      text: "周报不用感叹号",
      private: true,
      sourceMessageId: null,
    });
    expect((await nextOf(job.push, "preference_updated")).preference.text).toBe("周报不用感叹号");
    // 草稿等的是紧接着的两条推送，赶在别的写操作推送之前建。
    const account = job.accounts[0];
    if (account === undefined) throw new Error("contentJob 没建账号");
    const draft = await createDraft(job, specOf(account, tweet("这周发了新版本")));

    const brand = await client.request("PUT", "/api/brand", {
      facts: "白泽明理做多 Bot 协作。",
      voice: "短句。",
      taboo: "不提竞品。",
      assetsDir: null,
      edits: [],
      version: 0,
    });
    expect(brand.status).toBe(200);

    expect(
      (await client.post(`/api/bots/${job.botId}/skills`, { name: "写周报", steps: ["汇总", "成稿"] })).status,
    ).toBe(201);
    const tool = await client.post("/api/tools", { name: "公司工具", url: mcp.url, authorization: TOOL_SECRET });
    expect(tool.status).toBe(201);

    const routineResponse = await client.post(`/api/bots/${job.botId}/routines`, {
      name: "工单早报",
      instruction: "把今天的工单汇总一下",
      triggers: [{ kind: "webhook" }, { kind: "cron", expr: "0 9 * * *" }],
      onFailure: "stop_and_tell",
    });
    expect(routineResponse.status).toBe(201);
    const routine: Routine = RoutineResponse.parse(await routineResponse.json()).routine;
    const webhook = routine.triggers.find((trigger) => trigger.kind === "webhook");
    if (webhook?.kind !== "webhook") throw new Error("例行任务没有生成 webhook token");

    const helper = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小帮" })).json());
    const project = await client.post("/api/groups", { title: "开源增长", botIds: [job.botId, helper.bot.id] });
    expect(project.status).toBe(201);
    const projectGroup = CreateGroupResponse.parse(await project.json()).group;

    const stranger = await makeUser(database.db, "别人");
    const strangerClient = server.client();
    expect((await strangerClient.login(stranger.email, PASSWORD)).status).toBe(200);
    expect((await strangerClient.post("/api/bots", { name: "别人家的" })).status).toBe(201);

    const response = await client.get("/api/export");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("content-disposition"), "浏览器当附件下载").toMatch(
      /^attachment; filename=".+\.json"$/,
    );
    const text = await response.text();
    const exported = JSON.parse(text) as unknown;

    expect(exported).toMatchObject({
      format: 1,
      user: { id: job.user.id, email: job.user.email },
      brand: { facts: "白泽明理做多 Bot 协作。", voice: "短句。", taboo: "不提竞品。", version: 1 },
      bots: expect.arrayContaining([
        expect.objectContaining({
          id: job.botId,
          name: "小内",
          preferences: [expect.objectContaining({ text: "周报不用感叹号", private: true })],
          skills: [expect.objectContaining({ name: "写周报", steps: ["汇总", "成稿"] })],
        }),
        expect.objectContaining({ id: helper.bot.id, name: "小帮", preferences: [], skills: [] }),
      ]),
      routines: [
        expect.objectContaining({
          id: routine.id,
          name: "工单早报",
          triggers: [{ kind: "webhook" }, { kind: "cron", expr: "0 9 * * *" }],
        }),
      ],
      projects: [expect.objectContaining({ groupId: projectGroup.id, title: "开源增长" })],
      drafts: [expect.objectContaining({ id: draft.id, content: draft.content })],
    });
    expect(text, "别人的 Bot 不进我的导出").not.toContain("别人家的");

    const [computerRow] = await database.sql<{ token_hash: string; gateway_key_hash: string }[]>`
      SELECT token_hash, gateway_key_hash FROM computers WHERE id = ${job.computer.computerId}`;
    for (const secret of [
      webhook.token,
      TOOL_SECRET,
      ACCOUNT_TOKEN,
      job.computer.token,
      computerRow?.token_hash,
      computerRow?.gateway_key_hash,
    ]) {
      expect(secret, "凭据样本本身得在").toBeTruthy();
      expect(text.includes(secret ?? ""), `导出里出现了凭据 ${secret}`).toBe(false);
    }
    expect(text).not.toMatch(/token/i);
    expect(text).not.toMatch(/authorization/i);
    expect(text).not.toMatch(/password/i);
  });
});

it("删账号时邮箱不对回 400", async () => {
  const user = await makeUser(database.db);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const before = await leftovers(user.id);

  const wrong = await deleteAccount(client, `other-${user.email}`);
  expect(wrong.status).toBe(400);
  expect(await wrong.json()).toEqual({ error: "邮箱和当前账号不符" });
  expect((await deleteAccount(client, "不是邮箱")).status).toBe(400);
  expect((await client.request("DELETE", "/api/me")).status, "不带请求体").toBe(400);

  expect((await client.get("/api/me")).status, "账号还在，会话也还在").toBe(200);
  expect(await leftovers(user.id)).toEqual(before);
});

it("删账号后电脑代理的连接被关掉", async () => {
  const bystander = await makeUser(database.db, "旁观者");
  const bystanderComputer = await makeComputer(database.db, bystander.id);
  const bystanderClient = server.client();
  expect((await bystanderClient.login(bystander.email, PASSWORD)).status).toBe(200);
  const { agent: bystanderAgent } = await helloAgent(
    server.server.port,
    bystanderComputer.computerId,
    bystanderComputer.token,
  );

  try {
    await withJob(async (job) => {
      const account = job.accounts[0];
      if (account === undefined) throw new Error("contentJob 没建账号");
      await createDraft(job, specOf(account, tweet("删号前的草稿")));
      const before = await leftovers(job.user.id);
      expect(await runExists(job.runId), "派过活才有用量行").toBe(true);
      expect(before.accounts).toBe(1);

      const response = await deleteAccount(job.client, job.user.email);
      expect(response.status).toBe(204);
      expect(await job.agent.closed(), "代理的连接被控制面关掉").toBe(4002);

      expect(await leftovers(job.user.id)).toEqual({
        users: 0,
        bots: 0,
        groups: 0,
        computers: 0,
        accounts: 0,
        drafts: 0,
        sessions: 0,
      });
      expect(await runExists(job.runId), "用量行跟着账号删了").toBe(false);
      expect((await job.client.get("/api/me")).status, "会话跟着删了").toBe(401);
      expect((await server.client().login(job.user.email, PASSWORD)).status, "账号登不上了").toBe(401);

      const again = await openAgent(server.server.port);
      sendHello(again, job.computer.computerId, job.computer.token);
      expect(await again.closed(), "旧 token 再连被拒在握手").toBe(4001);
    });

    expect((await bystanderClient.get("/api/me")).status, "别人的账号不受影响").toBe(200);
    expect(bystanderAgent.socket.readyState, "别人的电脑连接不受影响").toBe(bystanderAgent.socket.OPEN);
    expect((await leftovers(bystander.id)).computers).toBe(1);
  } finally {
    bystanderAgent.close();
  }
});

it("删号删完 runs、还没删用户时派活：派活等删号提交，不建 run，不留归属人置空的用量行", async () => {
  const job = await contentJob(server, database.db, []);
  const deleteHeld = gate.arm(DELETE_RUNS, "after");
  let deleting: Promise<Response> | undefined;
  try {
    deleting = deleteAccount(job.client, job.user.email);
    await deleteHeld.reached;
    const posting = job.client.post(`/api/groups/${job.groupId}/messages`, { text: "删号交错时的新活" });
    const prompted = () => job.agent.received().some((frame) => frame.type === "prompt");
    // 不拿 Bot 锁的删号挡不住派活，它会建完 run 发出 prompt；拿了锁的话派活停在共享锁上。两种都等到再放行删号。
    await waitFor(async () => prompted() || (await lockWaiters()) > 0, "派活发出 prompt 或停在 Bot 锁上");
    deleteHeld.release();

    expect((await deleting).status).toBe(204);
    const response = await posting;
    expect(response.status, await response.clone().text()).toBe(201);
    expect(prompted(), "删号之后不再派活").toBe(false);
    expect(await orphanRuns(), "删号期间建出来的 run 也不能留下").toBe(0);
  } finally {
    deleteHeld.release();
    await deleting;
    job.close();
  }
});

it("派活拿着 Bot 锁建 run 时删号：删号等 run 提交再一并删掉，派活发不出 prompt 也不往已删的群写提示", async () => {
  const job = await contentJob(server, database.db, []);
  const inserting = gate.arm(INSERT_RUN, "before");
  let recording: ReturnType<typeof gate.arm> | undefined;
  let posting: Promise<Response> | undefined;
  let deleting: Promise<Response> | undefined;
  let deleted = false;
  try {
    posting = job.client.post(`/api/groups/${job.groupId}/messages`, { text: "已过成员检查、还没建 run" });
    await inserting.reached;
    recording = gate.arm(RECORD_CONTEXT, "before");
    deleting = deleteAccount(job.client, job.user.email).then((response) => {
      deleted = true;
      return response;
    });
    inserting.release();
    await recording.reached;
    await waitFor(async () => deleted || (await lockWaiters()) > 0, "删号停在派活事务的 Bot 锁上");
    expect(deleted, "上下文和 outbox 提交前删号不能越过派活事务").toBe(false);
    recording.release();

    const [posted, removed] = await Promise.all([posting, deleting]);
    expect(removed.status).toBe(204);
    expect(posted.status, await posted.clone().text()).toBe(201);
    expect(await job.agent.closed()).toBe(4002);
    expect(await orphanRuns(), "建出来的 run 随账号删掉").toBe(0);
    const left = await database.sql`SELECT 1 FROM messages WHERE group_id = ${job.groupId}`;
    expect(left, "已删的群里不留任何消息").toEqual([]);
  } finally {
    inserting.release();
    recording?.release();
    await Promise.all([posting, deleting]);
    job.close();
  }
});

it("删号拿完 Bot 快照后建 Bot：建 Bot 停在账号锁上等删号提交，之后按未登录回", async () => {
  const job = await contentJob(server, database.db, []);
  const deleteHeld = gate.arm(DELETE_RUNS, "after");
  let deleting: Promise<Response> | undefined;
  let creating: Promise<Response> | undefined;
  try {
    deleting = deleteAccount(job.client, job.user.email);
    await deleteHeld.reached;
    let created = false;
    creating = job.client.post("/api/bots", { name: "删号期间新建" }).then((response) => {
      created = true;
      return response;
    });
    await waitFor(async () => created || (await lockWaiters()) > 0, "建 Bot 回了或停在账号锁上");
    expect(created, "删号没提交前建不出 Bot").toBe(false);
    deleteHeld.release();

    expect((await deleting).status).toBe(204);
    const response = await creating;
    expect(response.status, await response.clone().text()).toBe(401);
    expect((await leftovers(job.user.id)).bots, "删号之后没有这个人的 Bot").toBe(0);
  } finally {
    deleteHeld.release();
    await Promise.all([deleting, creating]);
    job.close();
  }
});

it("删号拿完 Bot 快照后从分享包导入：导入停在账号锁上等删号提交，之后按未登录回，不留 Bot 和插件", async () => {
  const job = await contentJob(server, database.db, []);
  const deleteHeld = gate.arm(DELETE_RUNS, "after");
  const template = {
    format: 1,
    name: "删号期间导入",
    tags: [],
    description: "",
    skills: [],
    plugins: [{ name: "公司工具", url: "https://mcp.example.com/mcp", operations: [] }],
    preferences: [],
  };
  let deleting: Promise<Response> | undefined;
  let importing: Promise<Response> | undefined;
  try {
    deleting = deleteAccount(job.client, job.user.email);
    await deleteHeld.reached;
    let imported = false;
    importing = job.client.post("/api/bots/import", { template }).then((response) => {
      imported = true;
      return response;
    });
    await waitFor(async () => imported || (await lockWaiters()) > 0, "导入回了或停在账号锁上");
    expect(imported, "删号没提交前导入建不出 Bot").toBe(false);
    deleteHeld.release();

    expect((await deleting).status).toBe(204);
    const response = await importing;
    expect(response.status, await response.clone().text()).toBe(401);
    expect((await leftovers(job.user.id)).bots, "删号之后没有这个人的 Bot").toBe(0);
    const [tools] = await database.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM tool_connections WHERE owner_id = ${job.user.id}`;
    expect(tools?.n, "删号之后没有这个人的插件").toBe(0);
  } finally {
    deleteHeld.release();
    await Promise.all([deleting, importing]);
    job.close();
  }
});

it("没经过建 Bot 那道锁就进库的 Bot：删号期间给它派活，建 run 等删号提交，不留孤儿 run", async () => {
  const job = await contentJob(server, database.db, []);
  const deleteHeld = gate.arm(DELETE_RUNS, "after");
  let deleting: Promise<Response> | undefined;
  let posting: Promise<Response> | undefined;
  try {
    deleting = deleteAccount(job.client, job.user.email);
    await deleteHeld.reached;
    // 直接插进库，和 hello 补建主助理一样不经过建 Bot 的账号锁：删号枚举 Bot 时它还不存在，它的 Bot 锁不在删号手里。
    const late = await database.db.transaction((tx) => botsRepo.insertMemberBot(tx, job.user.id, { name: "晚来的" }));
    posting = job.client.post(`/api/groups/${late.group.id}/messages`, { text: "给晚来的 Bot 派活" });
    const prompted = () => job.agent.received().some((frame) => frame.type === "prompt" && frame.botId === late.bot.id);
    await waitFor(async () => prompted() || (await lockWaiters()) > 0, "新 Bot 收到 prompt 或建 run 停在账号锁上");
    deleteHeld.release();

    expect((await deleting).status).toBe(204);
    const response = await posting;
    expect(response.status, await response.clone().text()).toBe(201);
    expect(prompted(), "删号之后不再派活").toBe(false);
    expect(await orphanRuns(), "删号期间建出来的 run 也不能留下").toBe(0);
  } finally {
    deleteHeld.release();
    await Promise.all([deleting, posting]);
    job.close();
  }
});

it("建群锁着成员 Bot 的行时删号：删号等建群提交，两边都不死锁", async () => {
  const job = await contentJob(server, database.db, []);
  const helper = CreateBotResponse.parse(await (await job.client.post("/api/bots", { name: "建群帮手" })).json());
  const inserting = gate.arm(INSERT_GROUP, "before");
  let creating: Promise<Response> | undefined;
  let deleting: Promise<Response> | undefined;
  try {
    creating = job.client.post("/api/groups", { title: "删号交错建群", botIds: [job.botId, helper.bot.id] });
    await inserting.reached;
    let deleted = false;
    deleting = deleteAccount(job.client, job.user.email).then((response) => {
      deleted = true;
      return response;
    });
    await waitFor(async () => deleted || (await lockWaiters()) > 0, "删号停在锁上");
    inserting.release();

    const [groupResponse, deleteResponse] = await Promise.all([creating, deleting]);
    expect(groupResponse.status, await groupResponse.clone().text()).toBe(201);
    expect(deleteResponse.status, await deleteResponse.clone().text()).toBe(204);
    expect((await leftovers(job.user.id)).groups, "刚建的群随账号一起删掉").toBe(0);
  } finally {
    inserting.release();
    await Promise.all([creating, deleting]);
    job.close();
  }
});

it("派活选电脑前删号：选不到电脑也不往已删的群写提示，消息照常 201", async () => {
  const job = await contentJob(server, database.db, []);
  const listing = gate.arm(LIST_COMPUTERS, "before");
  let posting: Promise<Response> | undefined;
  try {
    posting = job.client.post(`/api/groups/${job.groupId}/messages`, { text: "选电脑前删号" });
    await listing.reached;
    expect((await deleteAccount(job.client, job.user.email)).status).toBe(204);
    listing.release();

    const response = await posting;
    expect(response.status, await response.clone().text()).toBe(201);
    const left = await database.sql`SELECT 1 FROM messages WHERE group_id = ${job.groupId}`;
    expect(left, "已删的群里不留任何消息").toEqual([]);
  } finally {
    listing.release();
    await posting;
    job.close();
  }
});

it("认完身份、hello 还没入链时删号：这条 hello 不能握手成功，连接被关掉", async () => {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const authenticated = gate.arm(AUTHENTICATE, "after");
  const agent = await openAgent(server.server.port);
  try {
    sendHello(agent, computer.computerId, computer.token);
    await authenticated.reached;
    expect((await deleteAccount(client, user.email)).status).toBe(204);
    authenticated.release();

    expect(await agent.closed(), "握手途中删号也按删号关").toBe(4002);
    expect(
      agent.received().map((frame) => frame.type),
      "没有 welcome 也没有 config",
    ).toEqual([]);
  } finally {
    authenticated.release();
    agent.close();
  }
});

it("握手中途抛错：连接移出连接表、socket 关掉，电脑记回休眠，下一次 hello 照常握手", async () => {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const original = botsRepo.ensureAssistant;
  const spy = vi.spyOn(botsRepo, "ensureAssistant").mockImplementation(async (...args) => {
    if (args[1] === user.id) throw new Error("补建主助理失败");
    return original(...args);
  });
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const agent = await openAgent(server.server.port);
  try {
    sendHello(agent, computer.computerId, computer.token);
    expect(await agent.closed(), "握手没走完就关").toBe(1011);
    await waitFor(async () => (await statusOf(computer.computerId)) === "sleeping", "电脑记回休眠");
  } finally {
    spy.mockRestore();
    errors.mockRestore();
    agent.close();
  }

  const { agent: again } = await helloAgent(server.server.port, computer.computerId, computer.token);
  try {
    expect(await statusOf(computer.computerId)).toBe("online");
  } finally {
    again.close();
  }
});

/** 跟主助理说一句，它在单聊里落一张方案卡，回卡的 id。 */
async function offeredProject(job: ContentJob): Promise<string> {
  const list = BotListResponse.parse(await (await job.client.get("/api/bots")).json());
  const assistant = list.items.find((entry) => entry.bot.role === "assistant");
  if (assistant === undefined) throw new Error("没有主助理");
  expect((await job.client.post(`/api/groups/${assistant.groupId}/messages`, { text: "出个方案" })).status).toBe(201);
  const prompt = await job.agent.expect("prompt");
  job.agent.send({
    type: "project_offer",
    runId: prompt.runId,
    botId: assistant.bot.id,
    groupId: assistant.groupId,
    name: "删号交错的项目",
    goal: "核对删号",
    team: [{ name: "交错队员", tags: ["内容"], description: "核对" }],
    platforms: [],
    cadence: "每周一次",
    firstStep: "先核对",
  });
  let id: string | undefined;
  await waitFor(async () => {
    const rows = await database.sql<{ id: string }[]>`
      SELECT id FROM messages WHERE group_id = ${assistant.groupId} AND body->>'kind' = 'project_offer'`;
    id = rows[0]?.id;
    return id !== undefined;
  }, "方案卡落库");
  if (id === undefined) throw new Error("方案卡没落库");
  return id;
}

it("开项目预查完卡、还没拿账号锁时删号：卡随账号没了，回 404，什么都不建", async () => {
  const job = await contentJob(server, database.db, []);
  const offerId = await offeredProject(job);
  const locking = gate.arm(SHARED_ADVISORY, "before");
  let starting: Promise<Response> | undefined;
  try {
    starting = job.client.post(`/api/messages/${offerId}/project-offer`, { decision: "start" });
    await locking.reached;
    expect((await deleteAccount(job.client, job.user.email)).status).toBe(204);
    locking.release();

    const response = await starting;
    expect(response.status, await response.clone().text()).toBe(404);
    expect(await leftovers(job.user.id), "删号之后开项目一个对象都没建出来").toEqual({
      users: 0,
      bots: 0,
      groups: 0,
      computers: 0,
      accounts: 0,
      drafts: 0,
      sessions: 0,
    });
  } finally {
    locking.release();
    await starting;
    job.close();
  }
});

it("开项目拿着账号锁时删号：删号等项目提交再一并删掉，两边都不死锁", async () => {
  const job = await contentJob(server, database.db, []);
  const offerId = await offeredProject(job);
  const locked = gate.arm(SHARED_ADVISORY, "after");
  let starting: Promise<Response> | undefined;
  let deleting: Promise<Response> | undefined;
  try {
    starting = job.client.post(`/api/messages/${offerId}/project-offer`, { decision: "start" });
    await locked.reached;
    deleting = deleteAccount(job.client, job.user.email);
    await waitFor(async () => (await lockWaiters()) > 0, "删号停在账号锁上");
    locked.release();

    const [started, removed] = await Promise.all([starting, deleting]);
    expect(started.status, await started.clone().text()).toBe(200);
    expect(removed.status, await removed.clone().text()).toBe(204);
    expect((await leftovers(job.user.id)).bots, "项目建出来的队员随账号删掉").toBe(0);
    expect(await orphanRuns()).toBe(0);
  } finally {
    locked.release();
    await Promise.all([starting, deleting]);
    job.close();
  }
});

it("建 run 拿着账号锁、还没拿 Bot 锁时删号：账号锁在 Bot 锁之前，删号等 run 提交，不死锁", async () => {
  const job = await contentJob(server, database.db, []);
  const locked = gate.arm(SHARED_ADVISORY, "after");
  let recording: ReturnType<typeof gate.arm> | undefined;
  let posting: Promise<Response> | undefined;
  let deleting: Promise<Response> | undefined;
  let deleted = false;
  try {
    posting = job.client.post(`/api/groups/${job.groupId}/messages`, { text: "建 run 的锁序" });
    await locked.reached;
    recording = gate.arm(RECORD_CONTEXT, "before");
    deleting = deleteAccount(job.client, job.user.email).then((response) => {
      deleted = true;
      return response;
    });
    await waitFor(async () => (await lockWaiters()) > 0, "删号停在账号锁上");
    locked.release();
    await recording.reached;

    expect(deleted, "录上下文时派活仍持有账号锁，删号不能提前提交").toBe(false);
    recording.release();
    const [posted, removed] = await Promise.all([posting, deleting]);
    expect(removed.status).toBe(204);
    expect(posted.status, await posted.clone().text()).toBe(201);
    expect(await orphanRuns(), "建出来的 run 随账号删掉").toBe(0);
    expect(await runExists(job.runId)).toBe(false);
  } finally {
    locked.release();
    recording?.release();
    await Promise.all([posting, deleting]);
    job.close();
  }
});

it("派活读完成员、还没读触发消息时删号：不建 run、不写提示，消息照常 201", async () => {
  const job = await contentJob(server, database.db, []);
  const reading = gate.arm(MESSAGE_SEQ, "before");
  let posting: Promise<Response> | undefined;
  try {
    posting = job.client.post(`/api/groups/${job.groupId}/messages`, { text: "读序号前删号" });
    await reading.reached;
    expect((await deleteAccount(job.client, job.user.email)).status).toBe(204);
    reading.release();

    const response = await posting;
    expect(response.status, await response.clone().text()).toBe(201);
    expect(await orphanRuns(), "删号之后不建 run").toBe(0);
    const left = await database.sql`SELECT 1 FROM messages WHERE group_id = ${job.groupId}`;
    expect(left, "已删的群里不留任何消息").toEqual([]);
  } finally {
    reading.release();
    await posting;
    job.close();
  }
});
