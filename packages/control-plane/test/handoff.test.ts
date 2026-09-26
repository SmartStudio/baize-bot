import { randomUUID } from "node:crypto";
import {
  CreateBotResponse,
  CreateGroupResponse,
  GroupListResponse,
  MessageListResponse,
  MessageId,
  type Bot,
  type BotId,
  type Group,
  type GroupId,
  type Handoff,
  type HandoffId,
  type RunId,
  type TopicTask,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BOT_MESSAGE_LIMIT, HANDOFF_LIMIT_NOTICE, MENTION_LOOP_NOTICE } from "../src/agent/group-turn.js";
import { STALE_HANDOFF_MS, remindStaleHandoffs } from "../src/repo/handoffs.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser } from "./helpers/fixtures.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

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

const DONE = "退款政策那一版写完了";
const NOT_DONE = "还没跟仓库对过库存";
const NEXT = "找仓库确认双十一的备货量";

type Team = {
  readonly client: ApiClient;
  readonly agent: AgentClient;
  readonly push: PushClient;
  readonly sales: Bot;
  readonly service: Bot;
  readonly group: Group;
  readonly task: TopicTask;
  close(): void;
};

async function makeBot(client: ApiClient, name: string, tag: string): Promise<Bot> {
  const response = await client.post("/api/bots", { name, tag });
  expect(response.status).toBe(201);
  return CreateBotResponse.parse(await response.json()).bot;
}

/** 一个用户、一台在线的电脑、小销和小服的二人群。推送在建群之后才连，收到的第一条就是用户消息。 */
async function makeTeam(): Promise<Team> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);

  const sales = await makeBot(client, "小销", "销售");
  const service = await makeBot(client, "小服", "客服");
  const response = await client.post("/api/groups", { title: "双十一大促", botIds: [sales.id, service.id] });
  expect(response.status).toBe(201);
  const created = CreateGroupResponse.parse(await response.json());

  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  const push = await connectPush(server.server.port, client.cookie ?? "");

  return {
    client,
    agent,
    push,
    sales,
    service,
    group: created.group,
    task: created.task,
    close: () => {
      agent.close();
      push.close();
    },
  };
}

/** 派一次活，拿回这个目标这一次的 runId。上行报文的归属校验要求 runId 真是它的活。 */
async function runFor(team: Team, text: string): Promise<RunId> {
  expect((await team.client.post(`/api/groups/${team.group.id}/messages`, { text })).status).toBe(201);
  const prompt = await team.agent.expect("prompt");
  return prompt.runId;
}

function finish(team: Team, runId: RunId, botId: BotId): void {
  team.agent.send({
    type: "run_done",
    runId,
    botId,
    groupId: team.group.id,
    steps: 1,
    inputTokens: 0,
    outputTokens: 0,
  });
}

type HandoffFrom = {
  readonly runId: RunId;
  readonly botId: BotId;
  readonly toBotId: BotId;
  readonly checklistIndex?: number | null;
};

function sendHandoff(team: Team, input: HandoffFrom): void {
  team.agent.send({
    type: "handoff",
    runId: input.runId,
    botId: input.botId,
    groupId: team.group.id,
    toBotId: input.toBotId,
    done: DONE,
    notDone: NOT_DONE,
    next: NEXT,
    checklistIndex: input.checklistIndex ?? null,
  });
}

/** 群里那一页消息，以及这一页引用到的交接报文。 */
async function page(
  team: Team,
  groupId: GroupId = team.group.id,
): Promise<ReturnType<typeof MessageListResponse.parse>> {
  return MessageListResponse.parse(await (await team.client.get(`/api/groups/${groupId}/messages`)).json());
}

type HandledRow = { readonly botId: string; readonly from: string; readonly to: string | null };

async function storedTask(groupId: GroupId): Promise<{ currentBotId: string | null; handled: HandledRow[] }> {
  const rows = await database.sql<{ current_bot_id: string | null; handled: HandledRow[] }[]>`
    SELECT current_bot_id, handled FROM tasks WHERE group_id = ${groupId}
  `;
  const row = rows[0];
  if (row === undefined) throw new Error(`群 ${groupId} 没有任务卡`);
  return { currentBotId: row.current_bot_id, handled: row.handled };
}

async function pendingBadge(team: Team): Promise<number> {
  const list = GroupListResponse.parse(await (await team.client.get("/api/groups")).json());
  return list.items.find((entry) => entry.group.id === team.group.id)?.pendingHandoffs ?? -1;
}

async function runCount(groupId: GroupId): Promise<number> {
  const rows = await database.sql<{ n: string }[]>`SELECT count(*) AS n FROM runs WHERE group_id = ${groupId}`;
  return Number(rows[0]?.n ?? "0");
}

/** 等到下一条 handoff_updated。它之前的推送都是这一步之前就该有的。 */
async function waitForHandoffUpdated(team: Team): Promise<Handoff> {
  for (;;) {
    const push = await team.push.next();
    if (push.type === "handoff_updated") return push.handoff;
  }
}

/** 小销拿到活、发出一份交接给小服。返回报文本身和小服这一次的 runId。 */
async function handedOver(team: Team): Promise<{ handoff: Handoff; targetRunId: RunId }> {
  const runId = await runFor(team, "@小销 开个头");
  sendHandoff(team, { runId, botId: team.sales.id, toBotId: team.service.id });
  const handoff = await waitForHandoffUpdated(team);
  finish(team, runId, team.sales.id);
  const prompt = await team.agent.expect("prompt");
  expect(prompt.botId, "交接派活的目标是小服").toBe(team.service.id);
  return { handoff, targetRunId: prompt.runId };
}

function acceptWith(team: Team, runId: RunId, botId: BotId, handoffId: HandoffId): void {
  team.agent.send({ type: "handoff_accept", runId, botId, groupId: team.group.id, handoffId });
}

describe("上行 handoff", () => {
  it("回合被用户插话取消后，旧 run 发的交接仍派给目标", async () => {
    const team = await makeTeam();
    try {
      const oldRun = await runFor(team, "@小销 @小服 一起看");
      const fresh = await runFor(team, "@小销 换个问题");
      sendHandoff(team, { runId: oldRun, botId: team.sales.id, toBotId: team.service.id });
      const handoff = await waitForHandoffUpdated(team);
      finish(team, fresh, team.sales.id);
      let sawCost = false;
      for (;;) {
        const push = await team.push.nextRaw();
        if (push.type === "message" && push.message.body.kind === "cost" && push.message.body.runId === fresh) {
          sawCost = true;
        }
        if (sawCost && push.type === "group_turn") break;
      }
      expect((await team.client.post(`/api/groups/${team.group.id}/messages`, { text: "@小销 哨兵" })).status).toBe(
        201,
      );
      const prompt = await team.agent.expect("prompt");
      expect(prompt.reason, "被插话取消的回合里后到的交接仍要派给目标").toBe("handoff");
      expect(prompt.botId).toBe(team.service.id);
      expect(prompt.handoffId).toBe(handoff.id);
    } finally {
      team.close();
    }
  });

  it("交接目标排进下一回合后，那一回合又被插话取消，目标仍不丢", async () => {
    const team = await makeTeam();
    try {
      const oldRun = await runFor(team, "@小销 @小服 一起看");
      await runFor(team, "@小销 换个问题");
      sendHandoff(team, { runId: oldRun, botId: team.sales.id, toBotId: team.service.id });
      const handoff = await waitForHandoffUpdated(team);
      const third = await runFor(team, "@小销 再换一个");
      finish(team, third, team.sales.id);
      const prompt = await team.agent.expect("prompt");
      expect(prompt.reason, "卡已经建了，回合再被取消几次，目标也要等到这份交接").toBe("handoff");
      expect(prompt.botId).toBe(team.service.id);
      expect(prompt.handoffId).toBe(handoff.id);
    } finally {
      team.close();
    }
  });

  it("Bot 发言数到上限时不建交接卡，群里有一条说明", async () => {
    const team = await makeTeam();
    try {
      const runId = await runFor(team, "@小销 开个头");
      for (let i = 0; i < BOT_MESSAGE_LIMIT; i += 1) {
        team.agent.send({
          type: "bot_text",
          runId,
          botId: team.sales.id,
          groupId: team.group.id,
          messageId: MessageId.parse(randomUUID()),
          delta: `第 ${i + 1} 条`,
          done: true,
        });
      }
      for (;;) {
        const push = await team.push.next();
        if (
          push.type === "message" &&
          push.message.body.kind === "system" &&
          push.message.body.text === MENTION_LOOP_NOTICE
        ) {
          break;
        }
      }
      sendHandoff(team, { runId, botId: team.sales.id, toBotId: team.service.id });
      finish(team, runId, team.sales.id);
      for (;;) {
        const push = await team.push.next();
        if (push.type === "message" && push.message.body.kind === "cost" && push.message.body.runId === runId) break;
      }
      const stored = await page(team);
      expect(stored.handoffs, "到上限后不再建交接卡").toHaveLength(0);
      expect(
        stored.messages.flatMap((message) => (message.body.kind === "system" ? [message.body.text] : [])),
        "到上限后要说明为什么没把交接交出去",
      ).toContain(HANDOFF_LIMIT_NOTICE);
    } finally {
      team.close();
    }
  });

  it("Bot 消息达到上限后交接不落卡", async () => {
    const team = await makeTeam();
    try {
      const runId = await runFor(team, "@小销 开个头");
      for (let i = 0; i < BOT_MESSAGE_LIMIT; i += 1) {
        team.agent.send({
          type: "bot_text",
          runId,
          botId: team.sales.id,
          groupId: team.group.id,
          messageId: MessageId.parse(randomUUID()),
          delta: `第 ${i + 1} 条`,
          done: true,
        });
      }
      for (;;) {
        const push = await team.push.next();
        if (
          push.type === "message" &&
          push.message.body.kind === "system" &&
          push.message.body.text === MENTION_LOOP_NOTICE
        )
          break;
      }
      sendHandoff(team, { runId, botId: team.sales.id, toBotId: team.service.id });
      finish(team, runId, team.sales.id);
      await team.client.post(`/api/groups/${team.group.id}/messages`, { text: "@小服 新一轮" });
      expect((await team.agent.expect("prompt")).botId).toBe(team.service.id);
      expect((await page(team)).handoffs).toHaveLength(0);
    } finally {
      team.close();
    }
  });

  it("连续交接累计到 10 张卡后停下，只留一条提示", async () => {
    const team = await makeTeam();
    try {
      let runId = await runFor(team, "@小销 开个头");
      let fromBotId = team.sales.id;
      let toBotId = team.service.id;
      for (let i = 0; i < BOT_MESSAGE_LIMIT - 1; i += 1) {
        sendHandoff(team, { runId, botId: fromBotId, toBotId });
        const pending = await waitForHandoffUpdated(team);
        finish(team, runId, fromBotId);
        const prompt = await team.agent.expect("prompt");
        expect(prompt.botId).toBe(toBotId);
        acceptWith(team, prompt.runId, toBotId, pending.id);
        expect((await waitForHandoffUpdated(team)).status).toBe("accepted");
        runId = prompt.runId;
        [fromBotId, toBotId] = [toBotId, fromBotId];
      }
      sendHandoff(team, { runId, botId: fromBotId, toBotId });
      await waitForHandoffUpdated(team);
      for (;;) {
        const push = await team.push.next();
        if (
          push.type === "message" &&
          push.message.body.kind === "system" &&
          push.message.body.text === MENTION_LOOP_NOTICE
        )
          break;
      }
      sendHandoff(team, { runId, botId: fromBotId, toBotId });
      finish(team, runId, fromBotId);
      await team.client.post(`/api/groups/${team.group.id}/messages`, { text: "@小销 新一轮" });
      const next = await team.agent.expect("prompt");
      expect(next.text).toBe("@小销 新一轮");
      const stored = await page(team);
      expect(stored.handoffs).toHaveLength(BOT_MESSAGE_LIMIT);
      expect(
        stored.messages.filter(
          (message) => message.body.kind === "system" && message.body.text === MENTION_LOOP_NOTICE,
        ),
      ).toHaveLength(1);
    } finally {
      team.close();
    }
  });

  it("落一份报文和一张卡，先推报文再推卡，目标收到带 handoffId 的活", async () => {
    const team = await makeTeam();

    try {
      const runId = await runFor(team, "@小销 开个头");
      expect((await team.push.next()).type, "先收掉用户那条消息的推送").toBe("message");
      const claimed = await team.push.next();
      expect(claimed.type, "@ 谁谁就成为经手，任务卡紧跟着推").toBe("task_updated");
      expect(claimed.type === "task_updated" ? claimed.task.currentBotId : null).toBe(team.sales.id);

      sendHandoff(team, { runId, botId: team.sales.id, toBotId: team.service.id, checklistIndex: 2 });

      const first = await team.push.next();
      expect(first.type, "客户端画那张卡的时候状态得已经在手上，所以报文先推").toBe("handoff_updated");
      const handoff = first.type === "handoff_updated" ? first.handoff : null;
      expect(handoff?.status).toBe("pending");
      expect(handoff?.fromBotId).toBe(team.sales.id);
      expect(handoff?.toBotId).toBe(team.service.id);
      expect(handoff?.done).toBe(DONE);
      expect(handoff?.notDone).toBe(NOT_DONE);
      expect(handoff?.next).toBe(NEXT);
      expect(handoff?.checklistIndex).toBe(2);
      expect(handoff?.acceptedAt, "还没人确认").toBeNull();

      const second = await team.push.next();
      expect(second.type === "message" ? second.message.body : null).toEqual({
        kind: "handoff",
        handoffId: handoff?.id,
      });

      expect(await runCount(team.group.id), "当前 run 没结束前不建目标 run").toBe(1);
      finish(team, runId, team.sales.id);
      const prompt = await team.agent.expect("prompt");
      expect(prompt.botId, "活派给交接的目标").toBe(team.service.id);
      expect(prompt.reason).toBe("handoff");
      expect(prompt.handoffId, "带上编号，运行器才开得出 accept_handoff").toBe(handoff?.id);
      expect(prompt.messageId, "触发这次派活的是交接卡那条消息，不是报文编号，也不是用户那句").toBe(
        second.type === "message" ? second.message.id : null,
      );
      expect(prompt.text, "prompt 正文就是交接报文").toContain(DONE);
      expect(prompt.text).toContain(NOT_DONE);
      expect(prompt.text).toContain(NEXT);
      expect(prompt.text, "清单指针从 1 数起说给它听").toContain("第 3 条");
      expect(prompt.text, "报文要说清楚是谁交过来的").toContain("小销");
      expect(prompt.task?.currentBotId, "确认之前当前经手还是小销").toBe(team.sales.id);
      expect(prompt.origin, "交接报文是小销发的").toEqual({
        kind: "bot",
        id: team.sales.id,
        name: "小销",
        tag: "销售",
      });

      const stored = await page(team);
      expect(
        stored.messages.filter((m) => m.body.kind === "handoff"),
        "群里就该有这一张卡",
      ).toHaveLength(1);
      expect(
        stored.handoffs.map((one) => one.id),
        "这一页引用到的报文跟着一起回",
      ).toEqual([handoff?.id]);
    } finally {
      team.close();
    }
  });

  it("发起者不是当前经手就整条丢掉", async () => {
    const team = await makeTeam();

    try {
      // 小服先拿一次活拿到 runId，随后经手换成小销，小服这时再交接就是越权。
      const serviceRunId = await runFor(team, "@小服 你先来");
      await runFor(team, "@小销 换我来");

      sendHandoff(team, { runId: serviceRunId, botId: team.service.id, toBotId: team.sales.id });
      // 一条能落地的交接排在后面，它先派出来就说明上面那条什么也没做，不靠超时。
      const salesRunId = await runFor(team, "@小销 接着说");
      sendHandoff(team, { runId: salesRunId, botId: team.sales.id, toBotId: team.service.id });

      const handoff = await waitForHandoffUpdated(team);
      expect(handoff.fromBotId, "落下来的只该是小销那一份").toBe(team.sales.id);
      const stored = await page(team);
      expect(stored.handoffs, "越权那条一份报文都不该落").toHaveLength(1);
      expect(await storedTask(team.group.id).then((task) => task.currentBotId), "越权的交接不碰经手").toBe(
        team.sales.id,
      );
    } finally {
      team.close();
    }
  });

  it("目标不是群里的别人就整条丢掉", async () => {
    const team = await makeTeam();

    try {
      const runId = await runFor(team, "@小销 开个头");
      const outsider = await makeBot(team.client, "小采", "采购");
      // 建 Bot 会重发一遍 config，先收掉它，后面读到的才是派活。
      await team.agent.expect("config");

      sendHandoff(team, { runId, botId: team.sales.id, toBotId: outsider.id });
      sendHandoff(team, { runId, botId: team.sales.id, toBotId: team.sales.id });
      // 一条能落地的排在后面，它先派出来就说明上面两条都没走完，不靠超时。
      sendHandoff(team, { runId, botId: team.sales.id, toBotId: team.service.id });
      finish(team, runId, team.sales.id);

      const prompt = await team.agent.expect("prompt");
      expect(prompt.botId).toBe(team.service.id);
      expect((await page(team)).handoffs, "群外的和交给自己的都不该落").toHaveLength(1);
    } finally {
      team.close();
    }
  });
});

describe("上行 handoff_accept", () => {
  it("确认之后经手换人，报文和任务卡都推出来", async () => {
    const team = await makeTeam();

    try {
      const { handoff, targetRunId } = await handedOver(team);
      const before = await storedTask(team.group.id);
      expect(before.currentBotId, "确认之前还挂在小销身上").toBe(team.sales.id);

      acceptWith(team, targetRunId, team.service.id, handoff.id);

      const accepted = await waitForHandoffUpdated(team);
      expect(accepted.status).toBe("accepted");
      expect(accepted.acceptedAt, "卡上要显示接手时间").not.toBeNull();

      const updated = await team.push.next();
      expect(updated.type, "经手换了，任务页要跟着刷新").toBe("task_updated");
      expect(updated.type === "task_updated" ? updated.task.currentBotId : null).toBe(team.service.id);

      const after = await storedTask(team.group.id);
      expect(after.currentBotId).toBe(team.service.id);
      expect(after.handled.map((row) => row.botId)).toEqual([team.sales.id, team.service.id]);
      expect(after.handled[0]?.to, "小销那一条要补上交出去的时刻").toBe(accepted.acceptedAt);
      expect(after.handled[1]?.from, "小服那一条从接手时刻算起").toBe(accepted.acceptedAt);
      expect(after.handled[1]?.to, "现在在小服手上").toBeNull();
    } finally {
      team.close();
    }
  });

  it("确认之前群里的话还归小销，确认之后只归小服", async () => {
    const team = await makeTeam();

    try {
      const { handoff, targetRunId } = await handedOver(team);

      await team.client.post(`/api/groups/${team.group.id}/messages`, { text: "先问一句" });
      const beforeAccept = await team.agent.expect("prompt");
      expect(beforeAccept.botId, "还没确认，不 @ 人的话仍然派给小销").toBe(team.sales.id);

      acceptWith(team, targetRunId, team.service.id, handoff.id);
      await waitForHandoffUpdated(team);

      await team.client.post(`/api/groups/${team.group.id}/messages`, { text: "接着弄" });
      // 小销要是也收到了，按成员顺序它那条会排在前面，所以这里读到小服就说明它不再收群消息了。
      const afterAccept = await team.agent.expect("prompt");
      expect(afterAccept.botId, "换完经手，群里的话只落到小服身上").toBe(team.service.id);
      expect(afterAccept.text).toBe("接着弄");
    } finally {
      team.close();
    }
  });

  it("重复确认什么也不做，经手记录不堆第二条", async () => {
    const team = await makeTeam();

    try {
      const { handoff, targetRunId } = await handedOver(team);
      acceptWith(team, targetRunId, team.service.id, handoff.id);
      const accepted = await waitForHandoffUpdated(team);

      acceptWith(team, targetRunId, team.service.id, handoff.id);
      // 一条能落地的消息排在后面，它先派出来就说明第二条确认什么也没做，不靠超时。
      await team.client.post(`/api/groups/${team.group.id}/messages`, { text: "接着弄" });
      expect((await team.agent.expect("prompt")).text).toBe("接着弄");

      const after = await storedTask(team.group.id);
      expect(
        after.handled.map((row) => row.botId),
        "经手记录还是两条",
      ).toEqual([team.sales.id, team.service.id]);
      const stored = await page(team);
      expect(stored.handoffs[0]?.acceptedAt, "接手时刻不该被第二条确认改写").toBe(accepted.acceptedAt);
    } finally {
      team.close();
    }
  });

  it("不是交给它的那份，它确认不了", async () => {
    const team = await makeTeam();

    try {
      const { handoff } = await handedOver(team);
      const salesRunId = await runFor(team, "@小销 我再说一句");

      // 小销是交出去的那个，这份报文等的是小服。
      acceptWith(team, salesRunId, team.sales.id, handoff.id);
      await team.client.post(`/api/groups/${team.group.id}/messages`, { text: "接着弄" });
      expect((await team.agent.expect("prompt")).text).toBe("接着弄");

      expect((await page(team)).handoffs[0]?.status, "报文还等着小服").toBe("pending");
      expect(await storedTask(team.group.id).then((task) => task.currentBotId)).toBe(team.sales.id);
    } finally {
      team.close();
    }
  });
});

describe("侧栏角标", () => {
  it("pendingHandoffs 交接前 0，交接后 1，确认后回 0", async () => {
    const team = await makeTeam();

    try {
      expect(await pendingBadge(team)).toBe(0);
      const { handoff, targetRunId } = await handedOver(team);
      expect(await pendingBadge(team)).toBe(1);

      acceptWith(team, targetRunId, team.service.id, handoff.id);
      await waitForHandoffUpdated(team);
      expect(await pendingBadge(team), "确认了就不再等 Bot 点头").toBe(0);
    } finally {
      team.close();
    }
  });
});

describe("24 小时提醒", () => {
  it("过了一天补一条 system 提醒，再扫一遍不重复，不退回也不升级", async () => {
    const team = await makeTeam();

    try {
      await handedOver(team);
      const fresh = await remindStaleHandoffs(database.db, server.server.hub, new Date());
      expect(fresh, "刚交出去的还没到点").toBe(0);

      // 同一个库里别的用例也留着没确认的交接，所以这里只断言这个群补到了一条，不数全库扫中几行。
      const later = new Date(Date.now() + STALE_HANDOFF_MS + 60_000);
      await remindStaleHandoffs(database.db, server.server.hub, later);

      const again = await remindStaleHandoffs(database.db, server.server.hub, later);
      expect(again, "reminded_at 已经占住了，第二遍一行都不该命中").toBe(0);

      const stored = await page(team);
      const reminders = stored.messages.flatMap((m) => (m.body.kind === "system" ? [m.body.text] : []));
      expect(reminders, "提醒只该有一条").toHaveLength(1);
      expect(reminders[0], "提醒要说清楚在等谁、下一步是什么").toContain("小服");
      expect(reminders[0]).toContain(NEXT);
      expect(stored.messages.find((message) => message.body.kind === "system")?.body).toMatchObject({ tone: "info" });

      expect(stored.handoffs[0]?.status, "只提醒，不退回给小销也不升级").toBe("pending");
      expect(await storedTask(team.group.id).then((task) => task.currentBotId)).toBe(team.sales.id);
    } finally {
      team.close();
    }
  });
});
