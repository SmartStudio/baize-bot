import { randomUUID } from "node:crypto";
import {
  CreateBotResponse,
  CreateGroupResponse,
  GroupResponse,
  MessageId,
  MessageListResponse,
  type Bot,
  type BotId,
  type ChecklistItem,
  type Group,
  type GroupId,
  type Message,
  type RunId,
  type TopicTask,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MENTION_LOOP_LIMIT } from "../src/agent/mention-loop.js";
import { MENTION_LOOP_NOTICE, NO_TARGET_NOTICE } from "../src/agent/dispatch.js";
import { appendMessage } from "../src/repo/messages.js";
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

type Team = {
  readonly client: ApiClient;
  readonly agent: AgentClient;
  readonly push: PushClient;
  readonly sales: Bot;
  readonly service: Bot;
  /** 小服的单 Bot 群，建 Bot 时自动建的那个。 */
  readonly soloGroupId: GroupId;
  readonly group: Group;
  readonly task: TopicTask;
  close(): void;
};

type SoloBot = { readonly bot: Bot; readonly groupId: GroupId };

async function makeBot(client: ApiClient, name: string, tag: string): Promise<SoloBot> {
  const response = await client.post("/api/bots", { name, tag });
  expect(response.status).toBe(201);
  const created = CreateBotResponse.parse(await response.json());
  return { bot: created.bot, groupId: created.group.id };
}

/** 一个用户、一台在线的电脑、两个 Bot 和它们的二人群。推送在建群之后才连，收到的第一条就是用户消息。 */
async function makeTeam(): Promise<Team> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);

  const sales = await makeBot(client, "小销", "销售");
  const service = await makeBot(client, "小服", "客服");
  const response = await client.post("/api/groups", { title: "双十一大促", botIds: [sales.bot.id, service.bot.id] });
  expect(response.status).toBe(201);
  const created = CreateGroupResponse.parse(await response.json());

  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  const push = await connectPush(server.server.port, client.cookie ?? "");

  return {
    client,
    agent,
    push,
    sales: sales.bot,
    service: service.bot,
    soloGroupId: service.groupId,
    group: created.group,
    task: created.task,
    close: () => {
      agent.close();
      push.close();
    },
  };
}

async function say(team: Team, groupId: GroupId, text: string): Promise<void> {
  const response = await team.client.post(`/api/groups/${groupId}/messages`, { text });
  expect(response.status).toBe(201);
}

async function messagesIn(team: Team, groupId: GroupId): Promise<Message[]> {
  const page = MessageListResponse.parse(await (await team.client.get(`/api/groups/${groupId}/messages`)).json());
  return page.messages;
}

async function taskOf(team: Team, groupId: GroupId): Promise<TopicTask> {
  return GroupResponse.parse(await (await team.client.get(`/api/groups/${groupId}`)).json()).task;
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

async function runCount(groupId: GroupId): Promise<number> {
  const rows = await database.sql<{ n: string }[]>`SELECT count(*) AS n FROM runs WHERE group_id = ${groupId}`;
  return Number(rows[0]?.n ?? "0");
}

/** 派一次活，拿回这个目标这一次的 runId。上行报文的归属校验要求 runId 真是它的活。 */
async function runFor(team: Team, groupId: GroupId, text: string): Promise<RunId> {
  await say(team, groupId, text);
  const prompt = await team.agent.expect("prompt");
  return prompt.runId;
}

function item(text: string, done: boolean, ownerBotId: BotId | null): ChecklistItem {
  return { text, done, ownerBotId };
}

describe("多 Bot 群派活", () => {
  it("@ 谁就派给谁，当前经手跟着换", async () => {
    const team = await makeTeam();

    try {
      await say(team, team.group.id, "@小销 查一下");
      const first = await team.agent.expect("prompt");
      expect(first.botId, "被 @ 的是小销").toBe(team.sales.id);
      expect(first.text).toBe("@小销 查一下");
      expect(first.task?.number, "多 Bot 群的 prompt 带的是这个群的任务卡").toBe(team.task.number);
      expect(first.task?.currentBotId, "任务卡是改完经手之后的那份").toBe(team.sales.id);
      expect(first.members, "成员名单是全体成员，按位置顺序").toEqual([
        { id: team.sales.id, name: "小销" },
        { id: team.service.id, name: "小服" },
      ]);

      const afterFirst = await storedTask(team.group.id);
      expect(afterFirst.currentBotId).toBe(team.sales.id);
      expect(afterFirst.handled).toHaveLength(1);
      expect(afterFirst.handled[0]?.botId).toBe(team.sales.id);
      expect(afterFirst.handled[0]?.to, "还在小销手上").toBeNull();

      await say(team, team.group.id, "@小服 换你");
      // 小销要是也收到了，这里先读到的就是多出来的那一条，不靠超时。
      const second = await team.agent.expect("prompt");
      expect(second.botId, "换成小服之后只派给小服").toBe(team.service.id);
      expect(second.task?.currentBotId).toBe(team.service.id);

      const afterSecond = await storedTask(team.group.id);
      expect(afterSecond.currentBotId).toBe(team.service.id);
      expect(afterSecond.handled.map((row) => row.botId)).toEqual([team.sales.id, team.service.id]);
      expect(afterSecond.handled[0]?.to, "小销那一条要补上交出去的时刻").not.toBeNull();
      expect(afterSecond.handled[1]?.to, "现在在小服手上").toBeNull();
    } finally {
      team.close();
    }
  });

  it("不 @ 人时派给当前经手，没有当前经手就留一句话不建 run", async () => {
    const team = await makeTeam();

    try {
      await say(team, team.group.id, "先看看这件事");
      const bodies = (await messagesIn(team, team.group.id)).map((message) => message.body);
      expect(bodies, "谁都没 @，群里只该多一句提示").toEqual([
        { kind: "user", text: "先看看这件事" },
        { kind: "system", text: NO_TARGET_NOTICE },
      ]);
      expect(await runCount(team.group.id), "没派出去的活不该在用量表里留行").toBe(0);

      await say(team, team.group.id, "@小服 你来");
      expect((await team.agent.expect("prompt")).botId).toBe(team.service.id);

      await say(team, team.group.id, "接着弄");
      const followUp = await team.agent.expect("prompt");
      expect(followUp.botId, "没 @ 人就归当前经手").toBe(team.service.id);
      expect(followUp.text).toBe("接着弄");
    } finally {
      team.close();
    }
  });

  it("单 Bot 群照旧总是收到，任务卡不出边界", async () => {
    const team = await makeTeam();

    try {
      await say(team, team.soloGroupId, "@小销 帮个忙");
      const prompt = await team.agent.expect("prompt");
      expect(prompt.botId, "单 Bot 群 @ 谁都派给它").toBe(team.service.id);
      expect(prompt.task, "单 Bot 群不带任务卡").toBeNull();
      expect(prompt.members).toEqual([{ id: team.service.id, name: "小服" }]);
    } finally {
      team.close();
    }
  });

  it("上下文里别人的话带 tag，自己的话只有名字", async () => {
    const team = await makeTeam();

    try {
      await appendMessage(database.db, team.group.id, {
        kind: "bot",
        botId: team.sales.id,
        text: "价格我定好了",
        streaming: false,
      });
      await appendMessage(database.db, team.group.id, {
        kind: "bot",
        botId: team.service.id,
        text: "退货政策也写了",
        streaming: false,
      });

      await say(team, team.group.id, "@小销 继续");
      const prompt = await team.agent.expect("prompt");
      expect(prompt.botId).toBe(team.sales.id);
      expect(prompt.context, "收件人是小销，所以小销署自己的名字，小服带上 tag").toEqual([
        { from: "小销", text: "价格我定好了" },
        { from: "小服 · 客服", text: "退货政策也写了" },
      ]);
    } finally {
      team.close();
    }
  });
});

describe("上行 task_checklist", () => {
  it("整份替换，推 task_updated 并在群里留一句", async () => {
    const team = await makeTeam();

    try {
      const runId = await runFor(team, team.group.id, "@小销 记一下");
      expect((await team.push.next()).type, "先收掉用户那条消息的推送").toBe("message");

      const checklist = [item("定价", true, team.sales.id), item("备货", false, null)];
      team.agent.send({ type: "task_checklist", runId, botId: team.sales.id, groupId: team.group.id, checklist });

      const updated = await team.push.next();
      expect(updated.type).toBe("task_updated");
      expect(updated.type === "task_updated" ? updated.task.checklist : null, "清单和发上去的一模一样").toEqual(
        checklist,
      );

      const card = await team.push.next();
      expect(card.type === "message" ? card.message.body : null).toEqual({
        kind: "system",
        text: "小销更新了清单，1/2 完成",
      });
    } finally {
      team.close();
    }
  });

  it("清单里有非群成员的 ownerBotId 就整条丢掉", async () => {
    const team = await makeTeam();

    try {
      const runId = await runFor(team, team.group.id, "@小销 记一下");
      const outsider = (await makeBot(team.client, "小采", "采购")).bot;

      team.agent.send({
        type: "task_checklist",
        runId,
        botId: team.sales.id,
        groupId: team.group.id,
        checklist: [item("找小采盯", false, outsider.id)],
      });
      // 再发一条确定会落地的，它先推出来就说明上一条什么也没做，不靠超时。
      team.agent.send({
        type: "task_checklist",
        runId,
        botId: team.sales.id,
        groupId: team.group.id,
        checklist: [item("定价", false, null)],
      });

      await waitForTaskUpdated(team);
      expect((await taskOf(team, team.group.id)).checklist, "越权那条一项都不该落").toEqual([
        item("定价", false, null),
      ]);
    } finally {
      team.close();
    }
  });

  it("runId 不是这个群里的活就整条丢掉", async () => {
    const team = await makeTeam();

    try {
      const soloRunId = await runFor(team, team.soloGroupId, "自己群里先干着");

      team.agent.send({
        type: "task_checklist",
        runId: soloRunId,
        botId: team.service.id,
        groupId: team.group.id,
        checklist: [item("借道插一条", false, null)],
      });
      const groupRunId = await runFor(team, team.group.id, "@小销 记一下");
      team.agent.send({
        type: "task_checklist",
        runId: groupRunId,
        botId: team.sales.id,
        groupId: team.group.id,
        checklist: [item("定价", false, null)],
      });

      await waitForTaskUpdated(team);
      expect((await taskOf(team, team.group.id)).checklist, "对不上群的那条一项都不该落").toEqual([
        item("定价", false, null),
      ]);
    } finally {
      team.close();
    }
  });
});

/** 等到那条 system 消息推出来。它到了就说明发它的那一步已经处理完了。 */
async function waitForSystemPush(team: Team, text: string): Promise<void> {
  for (;;) {
    const push = await team.push.next();
    if (push.type === "message" && push.message.body.kind === "system" && push.message.body.text === text) return;
  }
}

/** 等到 task_updated 那一条推出来。它之前的推送都是这一步之前就该有的。 */
async function waitForTaskUpdated(team: Team): Promise<void> {
  for (;;) {
    const push = await team.push.next();
    if (push.type === "task_updated") return;
  }
}

describe("上行 mention", () => {
  it("只派给被 @ 的那个，消息里记下 mentions", async () => {
    const team = await makeTeam();

    try {
      const runId = await runFor(team, team.group.id, "@小销 开个头");

      team.agent.send({
        type: "mention",
        runId,
        botId: team.sales.id,
        groupId: team.group.id,
        targetBotId: team.service.id,
        text: "@小服 这单退款你看下",
      });

      // 小销要是也收到了，按成员顺序它那条会排在前面，所以这里读到小服就说明只派了一个。
      const prompt = await team.agent.expect("prompt");
      expect(prompt.botId).toBe(team.service.id);
      expect(prompt.text).toBe("@小服 这单退款你看下");

      const bodies = (await messagesIn(team, team.group.id)).map((message) => message.body);
      expect(bodies.at(-1)).toEqual({
        kind: "bot",
        botId: team.sales.id,
        text: "@小服 这单退款你看下",
        streaming: false,
        mentions: [team.service.id],
      });
      expect(await storedTask(team.group.id).then((task) => task.currentBotId), "Bot 之间 @ 不改经手").toBe(
        team.sales.id,
      );
    } finally {
      team.close();
    }
  });

  it("目标不是群里的别人就整条丢掉", async () => {
    const team = await makeTeam();

    try {
      const runId = await runFor(team, team.group.id, "@小销 开个头");
      const outsider = (await makeBot(team.client, "小采", "采购")).bot;
      // 建 Bot 会重发一遍 config，先收掉它，后面读到的才是派活。
      await team.agent.expect("config");
      const before = (await messagesIn(team, team.group.id)).length;

      team.agent.send({
        type: "mention",
        runId,
        botId: team.sales.id,
        groupId: team.group.id,
        targetBotId: outsider.id,
        text: "@小采 你来",
      });
      team.agent.send({
        type: "mention",
        runId,
        botId: team.sales.id,
        groupId: team.group.id,
        targetBotId: team.sales.id,
        text: "自己 @ 自己",
      });
      // 一条能落地的报文排在后面，它先派出来就说明上面两条都没走完，不靠超时。
      team.agent.send({
        type: "mention",
        runId,
        botId: team.sales.id,
        groupId: team.group.id,
        targetBotId: team.service.id,
        text: "@小服 还是你来",
      });

      const prompt = await team.agent.expect("prompt");
      expect(prompt.botId).toBe(team.service.id);
      expect((await messagesIn(team, team.group.id)).length, "丢掉的两条一条消息都不该留").toBe(before + 1);
    } finally {
      team.close();
    }
  });

  it("两条用户消息之间 Bot 发起的 @ 到了上限就停下", async () => {
    const team = await makeTeam();

    try {
      const runId = await runFor(team, team.group.id, "@小销 开个头");
      const mention = (text: string) =>
        team.agent.send({
          type: "mention",
          runId,
          botId: team.sales.id,
          groupId: team.group.id,
          targetBotId: team.service.id,
          text,
        });

      for (let round = 1; round <= MENTION_LOOP_LIMIT + 1; round += 1) mention(`@小服 第 ${round} 遍`);
      for (let round = 1; round <= MENTION_LOOP_LIMIT; round += 1) {
        const prompt = await team.agent.expect("prompt");
        expect(prompt.text, "前十条各派一次").toBe(`@小服 第 ${round} 遍`);
      }

      // 越线那条在群里留的话推出来，就说明它已经处理完了，下面那条用户消息不会赶在它前面把计数清掉。
      await waitForSystemPush(team, MENTION_LOOP_NOTICE);
      const texts = (await messagesIn(team, team.group.id)).flatMap((message) =>
        message.body.kind === "system" ? [message.body.text] : [],
      );
      expect(texts, "越线的第一条留一句话，越线之后的不再重复").toEqual([MENTION_LOOP_NOTICE]);

      // 越线那条要是也派了，它会排在这条用户消息的派活前面。
      await say(team, team.group.id, "@小销 我来说一句");
      const afterUser = await team.agent.expect("prompt");
      expect(afterUser.botId, "第十一条没派出去").toBe(team.sales.id);

      mention("@小服 用户说完了再来");
      const revived = await team.agent.expect("prompt");
      expect(revived.botId, "用户一说话计数就归零，Bot 又能 @ 了").toBe(team.service.id);
      expect(revived.text).toBe("@小服 用户说完了再来");
    } finally {
      team.close();
    }
  });
});

describe("runId 归属", () => {
  it("拿这个群的 runId 往另一个群发 bot_text，整条丢掉且连接不断", async () => {
    const team = await makeTeam();

    try {
      const second = await team.client.post("/api/groups", {
        title: "年货节",
        botIds: [team.sales.id, team.service.id],
      });
      expect(second.status).toBe(201);
      const other = CreateGroupResponse.parse(await second.json()).group;
      const runId = await runFor(team, team.group.id, "@小销 开个头");

      team.agent.send({
        type: "bot_text",
        runId,
        botId: team.sales.id,
        groupId: other.id,
        messageId: MessageId.parse(randomUUID()),
        delta: "插到另一个群里",
        done: true,
      });
      // 随后这条正常报文照常处理，它先到就说明上面那条被丢掉了，不靠超时。
      await say(team, other.id, "@小服 这个群正常说话");
      const prompt = await team.agent.expect("prompt");
      expect(prompt.groupId).toBe(other.id);
      expect(prompt.botId).toBe(team.service.id);

      const bodies = (await messagesIn(team, other.id)).map((message) => message.body.kind);
      expect(bodies, "另一个群里不该多出 Bot 的话").toEqual(["user"]);
      expect(team.agent.socket.readyState, "丢弃要安静，连接不能断").toBe(team.agent.socket.OPEN);
    } finally {
      team.close();
    }
  });
});
