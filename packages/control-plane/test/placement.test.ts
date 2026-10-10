import { randomUUID } from "node:crypto";
import {
  ComputerTokenResponse,
  CreateBotResponse,
  CreateGroupResponse,
  MessageListResponse,
  RoutineResponse,
  type BotId,
  type ComputerId,
  type GroupId,
  type ServerPush,
  type UserId,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addAccount } from "../src/repo/accounts.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, waitFor, type TestComputer } from "./helpers/fixtures.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

let database: TestDb;
let server: TestServer;

/** 2030-01-07 是周一。时钟由测试拨，扫描间隔顶到一小时，只有测试自己调 `tick()` 才会到点。 */
const MONDAY_BEFORE_NINE = new Date("2030-01-07T08:59:00");
const MONDAY_NINE = new Date("2030-01-07T09:00:00");
let clock = new Date(MONDAY_BEFORE_NINE);

beforeAll(async () => {
  database = await createTestDb();
  server = await startTestServer(
    database.db,
    {},
    { now: () => clock, intervalMs: 60 * 60 * 1000 },
    { now: () => clock, intervalMs: 60 * 60 * 1000 },
  );
});

afterAll(async () => {
  await server.close();
  await database.close();
});

type Owner = {
  readonly ownerId: UserId;
  readonly client: ApiClient;
  readonly local: TestComputer;
  readonly remote: TestComputer;
  readonly groupId: GroupId;
  readonly botId: BotId;
};

/**
 * 一人两台电脑，本机挂小红书、远程挂 GitHub，和规格里第一批平台的分法一样。
 * 账号走 account-add 脚本的同一个函数写：这一单没有建账号的接口。
 */
async function ownerWithTwoComputers(): Promise<Owner> {
  const user = await makeUser(database.db);
  const local = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const remoteResponse = await client.post("/api/computers/remote");
  expect(remoteResponse.status).toBe(200);
  const remoteToken = ComputerTokenResponse.parse(await remoteResponse.json());
  const remote = { computerId: remoteToken.computerId, token: remoteToken.token };
  await addAccount(database.db, {
    ownerId: user.id,
    computerId: local.computerId,
    platform: "xiaohongshu",
    handle: "白泽工厂日记",
  });
  await addAccount(database.db, {
    ownerId: user.id,
    computerId: remote.computerId,
    platform: "github",
    handle: "baize-tech",
  });
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小运" })).json());
  return { ownerId: user.id, client, local, remote, groupId: created.group.id, botId: created.bot.id };
}

async function online(computer: TestComputer): Promise<AgentClient> {
  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  return agent;
}

async function statusOf(computerId: ComputerId): Promise<string | undefined> {
  const rows = await database.sql<{ status: string }[]>`SELECT status FROM computers WHERE id = ${computerId}`;
  return rows[0]?.status;
}

async function runComputers(groupId: GroupId): Promise<string[]> {
  const rows = await database.sql<{ computer_id: string }[]>`
    SELECT computer_id FROM runs WHERE group_id = ${groupId} ORDER BY started_at ASC, id ASC
  `;
  return rows.map((row) => row.computer_id);
}

async function errorNotices(owner: Owner, groupId: GroupId = owner.groupId): Promise<string[]> {
  const page = MessageListResponse.parse(await (await owner.client.get(`/api/groups/${groupId}/messages`)).json());
  return page.messages.flatMap(({ body }) => (body.kind === "system" && body.tone === "error" ? [body.text] : []));
}

async function offline(agent: AgentClient, computerId: ComputerId): Promise<void> {
  agent.close();
  await waitFor(async () => (await statusOf(computerId)) === "sleeping", "电脑变休眠");
}

async function routineRuns(routineId: string): Promise<{ status: string; note: string }[]> {
  return database.sql<{ status: string; note: string }[]>`
    SELECT status, note FROM routine_runs WHERE routine_id = ${routineId} ORDER BY started_at ASC, id ASC
  `;
}

async function tickAt(iso: string): Promise<void> {
  clock = new Date(iso);
  await server.server.routines.tick();
}

async function finishRoutine(agent: AgentClient, owner: Owner): Promise<void> {
  const prompt = await agent.expect("prompt");
  expect(prompt.origin).toEqual({ kind: "routine" });
  agent.send({
    type: "run_done",
    runId: prompt.runId,
    botId: owner.botId,
    groupId: owner.groupId,
    steps: 1,
    inputTokens: 10,
    outputTokens: 0,
  });
}

type Notice = Extract<ServerPush, { type: "notify" }>["notice"];

/** 改一下 Bot 描述当标记：标记的推送到了，它之前该到的通知就都到了，不靠超时等。 */
async function noticesBeforeMarker(owner: Owner, push: PushClient): Promise<Notice[]> {
  const description = `标记 ${randomUUID()}`;
  expect((await owner.client.patch(`/api/bots/${owner.botId}`, { description })).status).toBe(200);
  const notices: Notice[] = [];
  for (;;) {
    const item = await push.next();
    if (item.type === "bot_updated" && item.bot.description === description) return notices;
    if (item.type === "notify") notices.push(item.notice);
  }
}

describe("派到哪台电脑", () => {
  it("不碰账号的活本机在线走本机，本机离线走远程", async () => {
    const owner = await ownerWithTwoComputers();
    const local = await online(owner.local);
    const remote = await online(owner.remote);

    try {
      await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "第一件事" });
      // 发消息的请求在派活之后才回，这时 run 记在哪台、群里有没有派不出去的那句都已经定了。
      expect(await errorNotices(owner), "两台都在线，不该说派不出去").toEqual([]);
      expect(await runComputers(owner.groupId), "两台都在线时本机优先").toEqual([owner.local.computerId]);
      expect((await local.expect("prompt")).text, "两台都在线时本机优先").toBe("第一件事");

      local.close();
      await waitFor(async () => (await statusOf(owner.local.computerId)) === "sleeping", "本机变休眠");

      await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "第二件事" });
      expect(await errorNotices(owner), "本机离线还有远程，不该说派不出去").toEqual([]);
      // 远程收到的第一条 prompt 就是第二件事，说明第一件事没有派到远程。
      expect((await remote.expect("prompt")).text, "本机离线后落到远程").toBe("第二件事");
      expect(await runComputers(owner.groupId)).toEqual([owner.local.computerId, owner.remote.computerId]);
    } finally {
      local.close();
      remote.close();
    }
  });

  it("只碰远程账号的例行，本机离线时照常派到远程", async () => {
    const owner = await ownerWithTwoComputers();
    const remote = await online(owner.remote);
    clock = new Date(MONDAY_BEFORE_NINE);

    try {
      const response = await owner.client.post(`/api/bots/${owner.botId}/routines`, {
        name: "排本周计划",
        instruction: "按项目节奏排本周的 GitHub 更新",
        triggers: [{ kind: "cron", expr: "0 9 * * 1" }],
        onFailure: "stop_and_tell",
      });
      expect(response.status).toBe(201);
      const routine = RoutineResponse.parse(await response.json()).routine;
      await server.server.routines.tick();

      clock = new Date(MONDAY_NINE);
      await server.server.routines.tick();

      // tick 等这一轮例行跑完派活才回，运行记录和群里那句话这时都已落定。
      const runs = await database.sql<{ status: string; note: string }[]>`
        SELECT status, note FROM routine_runs WHERE routine_id = ${routine.id}
      `;
      expect(runs, "周一 09:00 跑了一次，派出去了还在跑").toEqual([{ status: "running", note: "" }]);
      expect(await errorNotices(owner), "派到远程了，群里不该有派不出去的那句").toEqual([]);
      const prompt = await remote.expect("prompt");
      expect(prompt.text).toBe("按项目节奏排本周的 GitHub 更新");
      expect(prompt.origin).toEqual({ kind: "routine" });
      expect(await runComputers(owner.groupId), "这次运行记在远程上").toEqual([owner.remote.computerId]);
    } finally {
      remote.close();
    }
  });

  it("同一条例行：本机在线走本机，本机断开走远程，两台都不在记失败不补跑，电脑回来后下一周照常", async () => {
    const owner = await ownerWithTwoComputers();
    let local = await online(owner.local);
    let remote = await online(owner.remote);
    const push = await connectPush(server.server.port, owner.client.cookie ?? "");
    clock = new Date(MONDAY_BEFORE_NINE);

    try {
      const response = await owner.client.post(`/api/bots/${owner.botId}/routines`, {
        name: "排本周计划",
        instruction: "排本周计划",
        triggers: [{ kind: "cron", expr: "0 9 * * 1" }],
        onFailure: "stop_and_tell",
      });
      expect(response.status).toBe(201);
      const routineId = RoutineResponse.parse(await response.json()).routine.id;
      await server.server.routines.tick();

      await tickAt("2030-01-07T09:00:00");
      expect(await runComputers(owner.groupId), "第一周两台都在线，走本机").toEqual([owner.local.computerId]);
      await finishRoutine(local, owner);
      await waitFor(async () => (await routineRuns(routineId))[0]?.status === "ok", "第一周记 ok");

      await offline(local, owner.local.computerId);
      await tickAt("2030-01-14T09:00:00");
      expect(await runComputers(owner.groupId), "第二周本机断开，走远程").toEqual([
        owner.local.computerId,
        owner.remote.computerId,
      ]);
      await finishRoutine(remote, owner);
      await waitFor(async () => (await routineRuns(routineId))[1]?.status === "ok", "第二周记 ok");
      expect(await errorNotices(owner), "前两周都派出去了").toEqual([]);
      // 连着三次没人看会自己停，这条用例看的是放置，第三周之前用户来看过一眼。
      expect((await owner.client.post(`/api/groups/${owner.groupId}/seen`, {})).status, "看过群").toBe(204);

      await offline(remote, owner.remote.computerId);
      await tickAt("2030-01-21T09:00:00");
      expect((await routineRuns(routineId))[2], "第三周两台都不在，记失败，看得出不止一台").toEqual({
        status: "failed",
        note: "你的电脑都不在线，没跑起来",
      });
      expect(await runComputers(owner.groupId), "第三周没有新 run").toHaveLength(2);
      expect(await errorNotices(owner), "群里恰好一句，看得出不止一台").toEqual([
        "你的电脑都不在线，这条没派出去，有一台回来后再说一次",
      ]);
      const stuck = (await noticesBeforeMarker(owner, push)).filter((n) => n.kind === "stuck").map((n) => n.text);
      expect(stuck, "从头到这里 stuck 恰好一条").toEqual(["例行任务「排本周计划」没跑：你的电脑都不在线"]);

      local = await online(owner.local);
      remote = await online(owner.remote);
      await tickAt("2030-01-21T09:05:00");
      await tickAt("2030-01-21T12:00:00");
      expect(await routineRuns(routineId), "电脑回来后同一周不补跑").toHaveLength(3);
      expect(await runComputers(owner.groupId), "电脑回来后同一周不补跑").toHaveLength(2);

      await tickAt("2030-01-28T09:00:00");
      expect(await runComputers(owner.groupId), "第四周照常走本机").toEqual([
        owner.local.computerId,
        owner.remote.computerId,
        owner.local.computerId,
      ]);
      await finishRoutine(local, owner);
      await waitFor(async () => (await routineRuns(routineId))[3]?.status === "ok", "第四周记 ok");
    } finally {
      push.close();
      local.close();
      remote.close();
    }
  });

  it("两台都不在时多 Bot 群里 @ 两个 Bot，群里只说一句", async () => {
    const owner = await ownerWithTwoComputers();
    const second = CreateBotResponse.parse(await (await owner.client.post("/api/bots", { name: "小销" })).json());
    const group = CreateGroupResponse.parse(
      await (await owner.client.post("/api/groups", { title: "两人群", botIds: [owner.botId, second.bot.id] })).json(),
    );
    await owner.client.post(`/api/groups/${group.group.id}/messages`, { text: "@小运 @小销 一起看看" });
    expect(await errorNotices(owner, group.group.id)).toEqual(["你的电脑都不在线，这条没派出去，有一台回来后再说一次"]);
  });
});
