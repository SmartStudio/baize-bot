import { randomUUID } from "node:crypto";
import {
  CreateBotResponse,
  CreateGroupResponse,
  GroupResponse,
  MessageListResponse,
  type Bot,
  type ControlToAgent,
  type GroupId,
  type ServerPush,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NO_TARGET_NOTICE } from "../src/agent/dispatch.js";
import { dispatchFailedNotice } from "../src/agent/group-turn.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { startTestServer, type ApiClient, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, waitFor } from "./helpers/fixtures.js";
import { gatedDb } from "./helpers/gated-db.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

type Prompt = Extract<ControlToAgent, { type: "prompt" }>;

/** 派活建完 run 行、写上下文窗口之前的那条。拦在它前面，run 已提交，prompt 还没发。 */
const RECORD_CONTEXT = /^update "runs" set "unsettled_context"/;

/** 建 run 事务的头一条，拦在它前面，路由已经选好人、run 还没建，删 Bot 不用等任何锁。 */
const START_RUN = /^SELECT pg_advisory_xact_lock_shared/;

/** 派活开头认单聊的那条。拦在它后面，群还在的结论已经交回，名单还没读。 */
const SOLO_LOOKUP = /^select "solo_bot_id" from "groups"/;

/** 建群查成员归属的那条。修前在事务外，修后在事务里带锁，两种都从这条开头。 */
const GROUP_OWNERSHIP = /^select "id" from "bots" where \("bots"\."owner_id" = \$1 and "bots"\."id" in /;

/** 建群插成员。 */
const INSERT_MEMBERS = /^insert into "group_members"/;

/** 换经手先查新经手还在不在的那条。 */
const CURRENT_BOT_ALIVE = /^select "id" from "bots" where "bots"\."id" = \$1/;

/** 用户消息落库的那条。 */
const INSERT_MESSAGE = /^insert into "messages"/;

let database: TestDb;
let gate: ReturnType<typeof gatedDb>;
let server: TestServer;

beforeAll(async () => {
  database = await createTestDb();
  gate = gatedDb(database.sql);
  server = await startTestServer(gate.db);
});

afterAll(async () => {
  await server.close();
  await database.close();
});

async function lockWaiters(): Promise<number> {
  const rows = await database.sql<{ waiting: number }[]>`
    SELECT count(*)::int AS waiting FROM pg_stat_activity
    WHERE datname = ${database.databaseName} AND wait_event_type = 'Lock'`;
  return rows[0]?.waiting ?? 0;
}

type Team = {
  readonly client: ApiClient;
  readonly agent: AgentClient;
  readonly bots: readonly Bot[];
  readonly groupId: GroupId;
  close(): void;
};

async function team(names: readonly string[]): Promise<Team> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const bots: Bot[] = [];
  for (const name of names) {
    bots.push(CreateBotResponse.parse(await (await client.post("/api/bots", { name })).json()).bot);
  }
  const created = await client.post("/api/groups", { title: "双十一大促", botIds: bots.map((bot) => bot.id) });
  const groupId = CreateGroupResponse.parse(await created.json()).group.id;
  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  return { client, agent, bots, groupId, close: () => agent.close() };
}

type Solo = Omit<Team, "bots"> & { readonly bot: Bot };

/** 一个 Bot 和它自动建出来的单 Bot 群，代理在线。 */
async function solo(name: string): Promise<Solo> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name })).json());
  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  return { client, agent, bot: created.bot, groupId: created.group.id, close: () => agent.close() };
}

/** 群对外不可见（成员全没了或群本身没了）时，提示只能从库里看。 */
async function systemRows(groupId: GroupId): Promise<string[]> {
  const rows = await database.sql<{ text: string }[]>`
    SELECT body->>'text' AS text FROM messages WHERE group_id = ${groupId} AND body->>'kind' = 'system'`;
  return rows.map((row) => row.text);
}

function nth(bots: readonly Bot[], index: number): Bot {
  const bot = bots[index];
  if (bot === undefined) throw new Error(`没有第 ${index} 个 Bot`);
  return bot;
}

/**
 * 控制面发给这台电脑的帧按发出顺序到。请求恢复一个 Bot，下行一条 resume，
 * 收到它时，之前发出的帧都已经到了。返回这之前收到的派活。
 */
async function promptsBefore(live: Team, bot: Bot): Promise<Prompt[]> {
  expect((await live.client.post(`/api/bots/${bot.id}/resume`)).status).toBe(200);
  const prompts: Prompt[] = [];
  for (;;) {
    const frame = await live.agent.next();
    if (frame.type === "resume" && frame.botId === bot.id) return prompts;
    if (frame.type === "prompt") prompts.push(frame);
  }
}

async function groupOf(live: Team) {
  const response = await live.client.get(`/api/groups/${live.groupId}`);
  expect(response.status).toBe(200);
  return GroupResponse.parse(await response.json());
}

async function pageOf(live: Team) {
  const response = await live.client.get(`/api/groups/${live.groupId}/messages`);
  expect(response.status).toBe(200);
  return MessageListResponse.parse(await response.json());
}

function pushOf(live: Team): Promise<PushClient> {
  return connectPush(server.server.port, live.client.cookie ?? "");
}

/**
 * 屏障：不带 runId 的 agent_error 排在这台电脑此前所有帧后面，它那句 system 推出来，前面的帧就处理完了，
 * 成功和抛错都算。返回屏障之前收到的全部推送，group_turn 也留着。
 */
async function barrier(live: Team, push: PushClient): Promise<ServerPush[]> {
  const tag = `屏障 ${randomUUID()}`;
  live.agent.send({ type: "agent_error", code: "runner_failed", detail: tag, groupId: live.groupId });
  const before: ServerPush[] = [];
  for (;;) {
    const event = await push.nextRaw();
    if (event.type === "message" && event.message.body.kind === "system" && event.message.body.text.endsWith(tag)) {
      return before;
    }
    before.push(event);
  }
}

function turns(pushes: readonly ServerPush[], groupId: GroupId) {
  return pushes.flatMap((event) =>
    event.type === "group_turn" && event.groupId === groupId ? [{ current: event.current, next: event.next }] : [],
  );
}

function systemTexts(pushes: readonly ServerPush[]): string[] {
  return pushes.flatMap((event) =>
    event.type === "message" && event.message.body.kind === "system" ? [event.message.body.text] : [],
  );
}

function finish(live: Team, prompt: Prompt): Promise<void> {
  live.agent.send({
    type: "run_done",
    runId: prompt.runId,
    botId: prompt.botId,
    groupId: prompt.groupId,
    steps: 1,
    inputTokens: 0,
    outputTokens: 0,
  });
  return live.agent.ack(prompt.runId);
}

describe("删 Bot 和别的写并发", () => {
  it("删 Bot 与派活设经手并发：被 @ 的那位刚删掉，回 201 不回 500，经手不换，活落到原经手", async () => {
    const live = await team(["小销", "小服"]);
    const sales = nth(live.bots, 0);
    const service = nth(live.bots, 1);
    try {
      expect((await live.client.post(`/api/groups/${live.groupId}/messages`, { text: "@小销 看看库存" })).status).toBe(
        201,
      );
      expect((await live.agent.expect("prompt")).botId).toBe(sales.id);

      // 消息已落库、结果还没交回，这时删掉被 @ 的小服，派活接着走到换经手。
      const landed = gate.arm(INSERT_MESSAGE, "after");
      const posting = live.client.post(`/api/groups/${live.groupId}/messages`, { text: "@小服 回一下客户" });
      await landed.reached;
      const deleted = await live.client.delete(`/api/bots/${service.id}`);
      expect(deleted.status, await deleted.clone().text()).toBe(204);
      landed.release();
      const response = await posting;

      expect(response.status, await response.clone().text()).toBe(201);
      const { task } = await groupOf(live);
      expect(task.currentBotId, "经手不换成已删的小服").toBe(sales.id);
      const prompts = await promptsBefore(live, sales);
      expect(
        prompts.map((prompt) => prompt.botId),
        "像没 @ 到人一样落到原经手",
      ).toEqual([sales.id]);
      expect(prompts[0]?.members.map((member) => member.id)).toEqual([sales.id]);
    } finally {
      live.close();
    }
  });

  it("名单读完、换经手认人之前被 @ 的那位被删：路由用设完经手后的新名单，活落到原经手，理由是 current", async () => {
    const live = await team(["小销", "小服"]);
    const sales = nth(live.bots, 0);
    const service = nth(live.bots, 1);
    let alive: ReturnType<typeof gate.arm> | undefined;
    try {
      expect((await live.client.post(`/api/groups/${live.groupId}/messages`, { text: "@小销 先干" })).status).toBe(201);
      expect((await live.agent.expect("prompt")).botId).toBe(sales.id);

      // 第一条消息把经手设成小销时也查这条，所以拦截要等它过去再装。
      alive = gate.arm(CURRENT_BOT_ALIVE, "before");
      const posting = live.client.post(`/api/groups/${live.groupId}/messages`, { text: "@小服 回客户" });
      await alive.reached;
      expect((await live.client.delete(`/api/bots/${service.id}`)).status).toBe(204);
      alive.release();
      const response = await posting;

      expect(response.status, await response.clone().text()).toBe(201);
      expect((await groupOf(live)).task.currentBotId).toBe(sales.id);
      const prompts = await promptsBefore(live, sales);
      expect(
        prompts.map((prompt) => [prompt.botId, prompt.reason]),
        "被 @ 的人没了就当没 @，落到原经手，不是没人接",
      ).toEqual([[sales.id, "current"]]);
      expect(prompts[0]?.members.map((member) => member.id)).toEqual([sales.id]);
    } finally {
      alive?.release();
      live.close();
    }
  });

  it("路由选好人、建 run 之前被 @ 的那位被删：排着的人全跳过后再路由一次，没有经手可退就留提示，不扩到全员", async () => {
    const live = await team(["小销", "小服"]);
    const sales = nth(live.bots, 0);
    const service = nth(live.bots, 1);
    let starting: ReturnType<typeof gate.arm> | undefined;
    try {
      expect((await live.client.post(`/api/groups/${live.groupId}/messages`, { text: "@小销 先干" })).status).toBe(201);
      expect((await live.agent.expect("prompt")).botId).toBe(sales.id);

      starting = gate.arm(START_RUN, "before");
      const posting = live.client.post(`/api/groups/${live.groupId}/messages`, { text: "@小服 回客户" });
      await starting.reached;
      expect((await live.client.delete(`/api/bots/${service.id}`)).status).toBe(204);
      starting.release();
      const response = await posting;

      expect(response.status, await response.clone().text()).toBe(201);
      // 经手已经换成小服，随删除置空，第二次路由没有组长也没有经手可退，不替用户挑小销，留提示让人再 @。
      expect((await groupOf(live)).task.currentBotId).toBeNull();
      expect(
        (await pageOf(live)).messages.flatMap((message) => (message.body.kind === "system" ? [message.body.text] : [])),
        "没派出去任何人，不静默",
      ).toEqual([NO_TARGET_NOTICE]);
      expect(
        (await promptsBefore(live, sales)).map((prompt) => prompt.botId),
        "没有再派给剩下的小销",
      ).toEqual([]);
    } finally {
      starting?.release();
      live.close();
    }
  });

  it("建 run 之前群里的人全被删：再路由也没人，群里留一句 @ 一个 Bot 派活，消息仍回 201", async () => {
    const live = await team(["小销", "小服"]);
    const sales = nth(live.bots, 0);
    const service = nth(live.bots, 1);
    const starting = gate.arm(START_RUN, "before");
    try {
      const posting = live.client.post(`/api/groups/${live.groupId}/messages`, { text: "@小服 回客户" });
      await starting.reached;
      expect((await live.client.delete(`/api/bots/${service.id}`)).status).toBe(204);
      expect((await live.client.delete(`/api/bots/${sales.id}`)).status).toBe(204);
      starting.release();
      const response = await posting;

      expect(response.status, await response.clone().text()).toBe(201);
      // 成员全没了的群对外已经不可见，提示只能从库里看。回 201 之前派活已经走完，这条已经落了。
      const texts = await database.sql<{ text: string }[]>`
        SELECT body->>'text' AS text FROM messages WHERE group_id = ${live.groupId} AND body->>'kind' = 'system'`;
      expect(
        texts.map((row) => row.text),
        "没人接不能静默",
      ).toEqual([NO_TARGET_NOTICE]);
      expect(live.agent.received().filter((frame) => frame.type === "prompt")).toEqual([]);
    } finally {
      starting.release();
      live.close();
    }
  });

  it("单 Bot 群建 run 之前 Bot 被删，群随它没了：消息已落库仍回 201，不往消失的群里写提示", async () => {
    const live = await solo("小销");
    const starting = gate.arm(START_RUN, "before");
    try {
      const posting = live.client.post(`/api/groups/${live.groupId}/messages`, { text: "看看库存" });
      await starting.reached;
      expect((await live.client.delete(`/api/bots/${live.bot.id}`)).status).toBe(204);
      starting.release();
      const response = await posting;

      expect(response.status, await response.clone().text()).toBe(201);
      expect((await live.client.get(`/api/groups/${live.groupId}`)).status, "单聊随 Bot 删掉").toBe(404);
      expect(await systemRows(live.groupId), "消失的群里没有任何提示").toEqual([]);
      expect(live.agent.received().filter((frame) => frame.type === "prompt")).toEqual([]);
    } finally {
      starting.release();
      live.close();
    }
  });

  it("单 Bot 群读名单之前 Bot 被删，群随它没了：名单为空也不往消失的群里写提示，消息仍回 201", async () => {
    const live = await solo("小销");
    const looked = gate.arm(SOLO_LOOKUP, "after");
    try {
      const posting = live.client.post(`/api/groups/${live.groupId}/messages`, { text: "看看库存" });
      await looked.reached;
      expect((await live.client.delete(`/api/bots/${live.bot.id}`)).status).toBe(204);
      looked.release();
      const response = await posting;

      expect(response.status, await response.clone().text()).toBe(201);
      expect(await systemRows(live.groupId), "消失的群里没有任何提示").toEqual([]);
      expect(live.agent.received().filter((frame) => frame.type === "prompt")).toEqual([]);
    } finally {
      looked.release();
      live.close();
    }
  });

  it("换经手已经认过被 @ 的那位之后才删它：删除等换经手提交，消息回 201，删除回 204，经手随删除置空", async () => {
    const live = await team(["小销", "小服"]);
    const service = nth(live.bots, 1);
    try {
      const alive = gate.arm(CURRENT_BOT_ALIVE, "after");
      const posting = live.client.post(`/api/groups/${live.groupId}/messages`, { text: "@小服 回一下客户" });
      await alive.reached;
      const deleting = live.client.delete(`/api/bots/${service.id}`);
      let deletedFirst = false;
      void deleting.then(() => (deletedFirst = true));
      // 有锁时删除在 Bot 行上等换经手；没锁时删除当场提交，换经手写任务卡撞外键。
      await waitFor(async () => deletedFirst || (await lockWaiters()) > 0, "删除走到删 Bot 行");
      alive.release();

      const response = await posting;
      expect(response.status, await response.clone().text()).toBe(201);
      expect((await deleting).status).toBe(204);
      expect((await groupOf(live)).task.currentBotId).toBeNull();
    } finally {
      live.close();
    }
  });

  it("建群查完归属之前成员被删：回 404 不回 500，库里没有半截群", async () => {
    const live = await team(["小销", "小服"]);
    const sales = nth(live.bots, 0);
    const service = nth(live.bots, 1);
    try {
      const checking = gate.arm(GROUP_OWNERSHIP, "before");
      const creating = live.client.post("/api/groups", { title: "新群", botIds: [sales.id, service.id] });
      await checking.reached;
      expect((await live.client.delete(`/api/bots/${service.id}`)).status).toBe(204);
      checking.release();
      const response = await creating;

      expect(response.status, await response.clone().text()).toBe(404);
      const opened = await database.sql`
        SELECT g.id FROM groups g JOIN tasks t ON t.group_id = g.id
        WHERE t.title = '新群' AND g.owner_id = (SELECT owner_id FROM bots WHERE id = ${sales.id})`;
      expect(opened, "整条事务回滚，没有建出新群").toEqual([]);
    } finally {
      live.close();
    }
  });

  it("建群查完归属之后才删成员：删除等建群提交，建群回 201，删除回 204，群里只剩另一位", async () => {
    const live = await team(["小销", "小服"]);
    const sales = nth(live.bots, 0);
    const service = nth(live.bots, 1);
    const inserting = gate.arm(INSERT_MEMBERS, "before");
    try {
      const creating = live.client.post("/api/groups", { title: "新群", botIds: [sales.id, service.id] });
      await inserting.reached;
      const deleting = live.client.delete(`/api/bots/${service.id}`);
      let deletedFirst = false;
      void deleting.then(() => (deletedFirst = true));
      // 有锁时删除在 Bot 行上等建群；没锁时删除当场提交。
      await waitFor(async () => deletedFirst || (await lockWaiters()) > 0, "删除走到删 Bot 行");
      inserting.release();

      const response = await creating;
      expect(response.status, await response.clone().text()).toBe(201);
      expect((await deleting).status).toBe(204);
      const groupId = CreateGroupResponse.parse(await response.json()).group.id;
      const group = await live.client.get(`/api/groups/${groupId}`);
      expect(GroupResponse.parse(await group.json()).group.botIds).toEqual([sales.id]);
    } finally {
      inserting.release();
      live.close();
    }
  });
});

describe("删掉回合里的 Bot", () => {
  it("删正在回合里说话的 Bot 后回合推进到下一位", async () => {
    const live = await team(["小销", "小服"]);
    const sales = nth(live.bots, 0);
    const service = nth(live.bots, 1);
    try {
      const posted = await live.client.post(`/api/groups/${live.groupId}/messages`, { text: "@小销 @小服 一起看看" });
      expect(posted.status).toBe(201);
      expect((await live.agent.expect("prompt")).botId).toBe(sales.id);

      expect((await live.client.delete(`/api/bots/${sales.id}`)).status).toBe(204);

      const prompts = await promptsBefore(live, service);
      expect(
        prompts.map((prompt) => prompt.botId),
        "不等被删那位的 run_done，轮到小服",
      ).toEqual([service.id]);
    } finally {
      live.close();
    }
  });

  it("跳过被删的 Bot 后下一位的成员名单里没有它", async () => {
    const live = await team(["小销", "小服", "小运"]);
    const sales = nth(live.bots, 0);
    const service = nth(live.bots, 1);
    const ops = nth(live.bots, 2);
    try {
      const posted = await live.client.post(`/api/groups/${live.groupId}/messages`, {
        text: "@小销 @小服 @小运 一起看看",
      });
      expect(posted.status).toBe(201);
      const first = await live.agent.expect("prompt");
      expect(first.botId).toBe(sales.id);
      expect((await live.client.delete(`/api/bots/${service.id}`)).status).toBe(204);

      live.agent.send({
        type: "run_done",
        runId: first.runId,
        botId: sales.id,
        groupId: live.groupId,
        steps: 1,
        inputTokens: 0,
        outputTokens: 0,
      });
      await live.agent.ack(first.runId);

      const prompts = await promptsBefore(live, ops);
      expect(prompts.map((prompt) => prompt.botId)).toEqual([ops.id]);
      expect(
        prompts[0]?.members.map((member) => member.id),
        "名单是派活这一刻的成员",
      ).toEqual([sales.id, ops.id]);
    } finally {
      live.close();
    }
  });

  it("run 已建、prompt 还没发时删掉这一位：回合不把它设成当前说话的，接着派下一位", async () => {
    const live = await team(["小销", "小服"]);
    const sales = nth(live.bots, 0);
    const service = nth(live.bots, 1);
    const recording = gate.arm(RECORD_CONTEXT, "before");
    try {
      const posting = live.client.post(`/api/groups/${live.groupId}/messages`, { text: "@小销 @小服 一起干" });
      await recording.reached;
      expect((await live.client.delete(`/api/bots/${sales.id}`)).status).toBe(204);
      recording.release();
      expect((await posting).status).toBe(201);

      const prompts = await promptsBefore(live, service);
      expect(
        prompts.filter((prompt) => prompt.botId === service.id),
        "小服恰好派到一次",
      ).toHaveLength(1);
      // 小销的 run 在删除前已提交，那条 prompt 可能已经发出去，运行器那边随 config 换掉它，这里当它跑完了。
      for (const orphan of prompts.filter((prompt) => prompt.botId === sales.id)) await finish(live, orphan);

      const push = await pushOf(live);
      try {
        const snapshot = turns(await barrier(live, push), live.groupId);
        expect(snapshot, "当前说话的是小服，不是已删的小销").toEqual([{ current: service.id, next: [] }]);
      } finally {
        push.close();
      }
    } finally {
      recording.release();
      live.close();
    }
  });

  it("删掉交出交接的那位：排着的交接随卡一起作废，接手方不会收到带已删 handoffId 的 prompt", async () => {
    const live = await team(["小销", "小服"]);
    const sales = nth(live.bots, 0);
    const service = nth(live.bots, 1);
    const push = await pushOf(live);
    try {
      expect((await live.client.post(`/api/groups/${live.groupId}/messages`, { text: "@小销 开始" })).status).toBe(201);
      const first = await live.agent.expect("prompt");
      expect(first.botId).toBe(sales.id);
      live.agent.send({
        type: "handoff",
        runId: first.runId,
        botId: sales.id,
        groupId: live.groupId,
        toBotId: service.id,
        done: "库存查完",
        notDone: "客户未回复",
        next: "回客户",
        checklistIndex: null,
      });
      const queued = turns(await barrier(live, push), live.groupId);
      expect(queued.at(-1), "交接已排在小销后面").toEqual({ current: sales.id, next: [service.id] });
      expect((await pageOf(live)).handoffs).toHaveLength(1);

      expect((await live.client.delete(`/api/bots/${sales.id}`)).status).toBe(204);

      const prompts = await promptsBefore(live, service);
      expect(prompts, "卡已随小销删掉，接手方没有活可接").toEqual([]);
      expect((await pageOf(live)).handoffs).toEqual([]);
      const closed = turns(await barrier(live, push), live.groupId);
      expect(closed.at(-1)).toEqual({ current: null, next: [] });
    } finally {
      push.close();
      live.close();
    }
  });

  it("下一位派活抛错：回合收掉，群里留一句派活失败，run_done 仍然确认，下一位没派到", async () => {
    const live = await team(["小销", "小服"]);
    const sales = nth(live.bots, 0);
    const push = await pushOf(live);
    const unhook = () =>
      database.sql.unsafe(
        "DROP TRIGGER IF EXISTS bot_delete_reject_run ON runs; DROP FUNCTION IF EXISTS bot_delete_reject_run();",
      );
    try {
      expect(
        (await live.client.post(`/api/groups/${live.groupId}/messages`, { text: "@小销 @小服 一起看看" })).status,
      ).toBe(201);
      const first = await live.agent.expect("prompt");
      expect(first.botId).toBe(sales.id);
      // 库约束当测试钩子：下一位建 run 的那条 INSERT 抛错，产品代码不知道有它。
      await database.sql.unsafe(`
        CREATE FUNCTION bot_delete_reject_run() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION '测试钩子：下一位的 run 建不出来'; END $$ LANGUAGE plpgsql;
        CREATE TRIGGER bot_delete_reject_run BEFORE INSERT ON runs FOR EACH ROW EXECUTE FUNCTION bot_delete_reject_run();
      `);

      await finish(live, first);
      const pushes = await barrier(live, push);
      expect(systemTexts(pushes), "群里说清楚派给小服的活没发出去").toContain(dispatchFailedNotice("小服"));
      expect(turns(pushes, live.groupId).at(-1), "回合收掉，没有人悬在当前").toEqual({ current: null, next: [] });
      expect(
        live.agent.received().filter((frame) => frame.type === "prompt"),
        "小服没派到",
      ).toEqual([]);
    } finally {
      await unhook();
      push.close();
      live.close();
    }
  });
});
