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
import { BOT_MESSAGE_LIMIT, MENTION_LOOP_NOTICE } from "../src/agent/group-turn.js";
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
  server = await startTestServer(database.db, { priceInputPerM: 3, priceOutputPerM: 15 });
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

async function usageOf(runId: RunId): Promise<{
  steps: number;
  inputTokens: number;
  outputTokens: number;
  amount: string;
}> {
  const rows = await database.sql<
    { steps: number; input_tokens: number; output_tokens: number; amount: string }[]
  >`SELECT steps, input_tokens, output_tokens, amount FROM runs WHERE id = ${runId}`;
  const row = rows[0];
  if (row === undefined) throw new Error(`没有找到 run ${runId}`);
  return { steps: row.steps, inputTokens: row.input_tokens, outputTokens: row.output_tokens, amount: row.amount };
}

/** 派一次活，拿回这个目标这一次的 runId。上行报文的归属校验要求 runId 真是它的活。 */
async function runFor(team: Team, groupId: GroupId, text: string): Promise<RunId> {
  await say(team, groupId, text);
  const prompt = await team.agent.expect("prompt");
  return prompt.runId;
}

function finish(team: Team, runId: RunId, botId: BotId, groupId: GroupId = team.group.id): void {
  team.agent.send({ type: "run_done", runId, botId, groupId, steps: 1, inputTokens: 0, outputTokens: 0 });
}

function reply(team: Team, runId: RunId, botId: BotId, text: string, groupId: GroupId = team.group.id): void {
  team.agent.send({
    type: "bot_text",
    runId,
    botId,
    groupId,
    messageId: MessageId.parse(randomUUID()),
    delta: text,
    done: true,
  });
}

function item(text: string, done: boolean, ownerBotId: BotId | null): ChecklistItem {
  return { text, done, ownerBotId };
}

describe("多 Bot 群派活", () => {
  it("@小服 @小销 串行，小销的 context 含小服刚才的回复", async () => {
    const team = await makeTeam();

    try {
      await say(team, team.group.id, "@小服 @小销 一起看");
      const first = await team.agent.expect("prompt");
      for (;;) {
        const push = await team.push.nextRaw();
        if (push.type === "group_turn" && push.current === team.service.id) {
          expect(push.next).toEqual([team.sales.id]);
          break;
        }
      }
      reply(team, first.runId, team.service.id, "小服先答了");
      finish(team, first.runId, team.service.id);
      const second = await team.agent.expect("prompt");
      for (;;) {
        const push = await team.push.nextRaw();
        if (push.type === "group_turn" && push.current === team.sales.id) {
          expect(push.next).toEqual([]);
          break;
        }
      }

      expect(first.botId, "正文先 @ 小服，所以第一条 prompt 先到小服").toBe(team.service.id);
      expect(second.botId, "第二条 prompt 再到小销").toBe(team.sales.id);
      expect(second.context).toContainEqual({ from: "小服 · 客服", text: "小服先答了" });
      expect(
        first.members.map((member) => member.name),
        "成员表仍按群成员位置，小销在前",
      ).toEqual(["小销", "小服"]);
      expect(first.task?.currentBotId, "第一条 prompt 带更新后的经手").toBe(team.service.id);
      expect(second.task?.currentBotId, "第二条 prompt 也带同一个经手").toBe(team.service.id);
      expect((await storedTask(team.group.id)).currentBotId, "正文第一个 @ 的小服成为经手").toBe(team.service.id);
    } finally {
      team.close();
    }
  });

  it("@ 谁就派给谁，当前经手跟着换", async () => {
    const team = await makeTeam();

    try {
      await say(team, team.group.id, "@小销 查一下");
      const first = await team.agent.expect("prompt");
      expect(first.botId, "被 @ 的是小销").toBe(team.sales.id);
      expect(first.text).toBe("@小销 查一下");
      expect(first.task?.number, "多 Bot 群的 prompt 带的是这个群的任务卡").toBe(team.task.number);
      expect(first.task?.currentBotId, "任务卡是改完经手之后的那份").toBe(team.sales.id);
      expect(first.members, "成员名单是全体成员，按位置顺序，带 tag 和描述，没设首席时都是普通成员").toEqual([
        { id: team.sales.id, name: "小销", tag: "销售", description: "", role: "member" },
        { id: team.service.id, name: "小服", tag: "客服", description: "", role: "member" },
      ]);
      expect(first.origin, "用户手打的消息").toEqual({ kind: "user" });
      expect(first.reason, "派活原因是被 @").toBe("mentioned");
      expect(first.group, "群标签取自任务卡，多 Bot 群是 team").toEqual({
        id: team.group.id,
        number: team.task.number,
        title: "双十一大促",
        kind: "team",
      });

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

  it("不 @、无首席和经手时按成员顺序全员说；有经手时只派经手", async () => {
    const team = await makeTeam();

    try {
      await say(team, team.group.id, "先看看这件事");
      const first = await team.agent.expect("prompt");
      expect(first.botId).toBe(team.sales.id);
      expect(first.reason).toBe("everyone");
      finish(team, first.runId, team.sales.id);
      const second = await team.agent.expect("prompt");
      expect(second.botId).toBe(team.service.id);
      expect(second.reason).toBe("everyone");
      finish(team, second.runId, team.service.id);
      expect(await runCount(team.group.id)).toBe(2);

      await say(team, team.group.id, "@小服 你来");
      expect((await team.agent.expect("prompt")).botId).toBe(team.service.id);

      await say(team, team.group.id, "接着弄");
      const followUp = await team.agent.expect("prompt");
      expect(followUp.botId, "没 @ 人就归当前经手").toBe(team.service.id);
      expect(followUp.reason).toBe("current");
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
      expect(prompt.members).toEqual([
        { id: team.service.id, name: "小服", tag: "客服", description: "", role: "member" },
      ]);
      expect(prompt.reason, "单 Bot 群的派活原因").toBe("solo");
      expect(prompt.group, "单 Bot 群的任务卡不下发，但群标签仍取它的编号，标题就是 Bot 名").toEqual({
        id: team.soloGroupId,
        number: expect.stringMatching(/^T-\d{4}$/),
        title: "小服",
        kind: "solo",
      });
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

  it("@所有人 按成员表顺序串行派全员", async () => {
    const team = await makeTeam();
    try {
      await say(team, team.group.id, "@所有人 一起看");
      const first = await team.agent.expect("prompt");
      expect(first.botId).toBe(team.sales.id);
      expect(first.reason).toBe("mentioned");
      finish(team, first.runId, team.sales.id);
      const second = await team.agent.expect("prompt");
      expect(second.botId).toBe(team.service.id);
      expect(second.reason).toBe("mentioned");
    } finally {
      team.close();
    }
  });

  it("设首席后没 @ 只派首席，首席 @ 队友要等本次 run_done", async () => {
    const team = await makeTeam();
    try {
      const setupRun = await runFor(team, team.group.id, "@小服 你当首席");
      team.agent.send({
        type: "set_chief",
        runId: setupRun,
        botId: team.service.id,
        groupId: team.group.id,
        targetBotId: team.sales.id,
      });
      for (;;) {
        const push = await team.push.next();
        if (push.type === "group_updated") {
          expect(push.group.chiefBotId).toBe(team.sales.id);
          break;
        }
      }
      finish(team, setupRun, team.service.id);
      await say(team, team.group.id, "接着处理");
      const chief = await team.agent.expect("prompt");
      expect(chief.botId).toBe(team.sales.id);
      expect(chief.reason).toBe("chief");
      expect(chief.members.find((member) => member.id === team.sales.id)?.role).toBe("chief");
      team.agent.send({
        type: "mention",
        runId: chief.runId,
        botId: team.sales.id,
        groupId: team.group.id,
        targetBotId: team.service.id,
        text: "@小服 请补充售后",
      });
      for (;;) {
        const push = await team.push.next();
        if (push.type === "message" && push.message.body.kind === "bot") break;
      }
      expect(await runCount(team.group.id), "Bot @ 先落消息，当前 run 没结束就不建下一条 run").toBe(2);
      finish(team, chief.runId, team.sales.id);
      const teammate = await team.agent.expect("prompt");
      expect(teammate.botId).toBe(team.service.id);
      expect(teammate.reason).toBe("mentioned");
      expect(teammate.text).toBe("@小服 请补充售后");
    } finally {
      team.close();
    }
  });

  it("一轮没人 @ 时结束并推 group_turn current null", async () => {
    const team = await makeTeam();
    try {
      const runId = await runFor(team, team.group.id, "@小销 回答");
      finish(team, runId, team.sales.id);
      for (;;) {
        const push = await team.push.nextRaw();
        if (push.type === "group_turn" && push.current === null) {
          expect(push.groupId).toBe(team.group.id);
          expect(push.next).toEqual([]);
          break;
        }
      }
    } finally {
      team.close();
    }
  });

  it("一个回合里有人回话、有人 (pass) 时只留一条花费，金额是两次之和", async () => {
    const team = await makeTeam();
    try {
      await say(team, team.group.id, "先看看这件事");
      const first = await team.agent.expect("prompt");
      expect(first.botId, "没人点名时先派成员表里的第一位").toBe(team.sales.id);
      reply(team, first.runId, team.sales.id, "我来答");
      team.agent.send({
        type: "run_done",
        runId: first.runId,
        botId: team.sales.id,
        groupId: team.group.id,
        steps: 2,
        inputTokens: 1_000_000,
        outputTokens: 0,
      });
      const second = await team.agent.expect("prompt");
      expect(second.botId).toBe(team.service.id);
      reply(team, second.runId, team.service.id, "(pass)");
      team.agent.send({
        type: "run_done",
        runId: second.runId,
        botId: team.service.id,
        groupId: team.group.id,
        steps: 4,
        inputTokens: 0,
        outputTokens: 1_000_000,
      });
      for (;;) {
        const push = await team.push.nextRaw();
        if (push.type === "group_turn" && push.current === null) break;
      }
      const messages = await messagesIn(team, team.group.id);
      const costs = messages.flatMap((message) => (message.body.kind === "cost" ? [message.body] : []));
      expect(
        messages.filter((message) => message.body.kind === "bot"),
        "(pass) 不落 Bot 消息",
      ).toHaveLength(1);
      expect(costs, "两次调用并成一条花费").toEqual([
        { kind: "cost", runId: first.runId, botId: team.sales.id, steps: 6, amount: 18 },
      ]);
    } finally {
      team.close();
    }
  });

  it("整轮全 pass 不写花费行", async () => {
    const team = await makeTeam();
    try {
      await say(team, team.group.id, "先看看这件事");
      const first = await team.agent.expect("prompt");
      reply(team, first.runId, team.sales.id, "(pass)");
      team.agent.send({
        type: "run_done",
        runId: first.runId,
        botId: team.sales.id,
        groupId: team.group.id,
        steps: 2,
        inputTokens: 1_000_000,
        outputTokens: 0,
      });
      const second = await team.agent.expect("prompt");
      reply(team, second.runId, team.service.id, "（pass）");
      team.agent.send({
        type: "run_done",
        runId: second.runId,
        botId: team.service.id,
        groupId: team.group.id,
        steps: 4,
        inputTokens: 0,
        outputTokens: 1_000_000,
      });
      team.agent.send({
        type: "bot_tool_call",
        runId: second.runId,
        botId: team.service.id,
        groupId: team.group.id,
        callId: "all-pass-settled",
        tool: "test.sentinel",
        argsSummary: "全员 pass 已处理",
        status: "ok",
        durationMs: 0,
      });
      for (;;) {
        const push = await team.push.next();
        if (
          push.type === "message" &&
          push.message.body.kind === "tool_call" &&
          push.message.body.argsSummary === "全员 pass 已处理"
        )
          break;
      }

      const messages = await messagesIn(team, team.group.id);
      expect(
        messages.filter((message) => message.body.kind === "bot"),
        "全轮的 pass 都不落 Bot 消息",
      ).toHaveLength(0);
      expect(
        messages.filter((message) => message.body.kind === "cost"),
        "全轮没有可挂的 Bot 回复时也不写纯金额行",
      ).toHaveLength(0);
      expect(await usageOf(first.runId), "第一位的用量仍记在 runs").toEqual({
        steps: 2,
        inputTokens: 1_000_000,
        outputTokens: 0,
        amount: "3.000000",
      });
      expect(await usageOf(second.runId), "第二位的用量仍记在 runs").toEqual({
        steps: 4,
        inputTokens: 0,
        outputTokens: 1_000_000,
        amount: "15.000000",
      });
    } finally {
      team.close();
    }
  });

  it("(pass) 和全角括号版本不落 Bot 消息，也不推 message 或 delta", async () => {
    const team = await makeTeam();
    try {
      for (const [index, prefix] of ["(pass)", "（pass）"].entries()) {
        const runId = await runFor(team, team.group.id, "@小销 看看");
        const messageId = MessageId.parse(randomUUID());
        team.agent.send({
          type: "bot_text",
          runId,
          botId: team.sales.id,
          groupId: team.group.id,
          messageId,
          delta: prefix.slice(0, 3),
          done: false,
        });
        team.agent.send({
          type: "bot_text",
          runId,
          botId: team.sales.id,
          groupId: team.group.id,
          messageId,
          delta: `${prefix.slice(3)} 第 ${index + 1} 次`,
          done: true,
        });
        finish(team, runId, team.sales.id);
        team.agent.send({
          type: "bot_tool_call",
          runId,
          botId: team.sales.id,
          groupId: team.group.id,
          callId: `pass-settled-${index}`,
          tool: "test.sentinel",
          argsSummary: `第 ${index + 1} 次 pass 已处理`,
          status: "ok",
          durationMs: 0,
        });
        for (;;) {
          const push = await team.push.next();
          expect(push.type === "message_delta" ? push.messageId : null).not.toBe(messageId);
          expect(push.type === "message" ? push.message.id : null).not.toBe(messageId);
          if (
            push.type === "message" &&
            push.message.body.kind === "tool_call" &&
            push.message.body.argsSummary === `第 ${index + 1} 次 pass 已处理`
          )
            break;
        }
      }
      expect((await messagesIn(team, team.group.id)).filter((message) => message.body.kind === "bot")).toHaveLength(0);
    } finally {
      team.close();
    }
  });

  it("用户中途说话换 epoch，旧 run 落消息但不再推进", async () => {
    const team = await makeTeam();
    try {
      await say(team, team.group.id, "@小服 @小销 先讨论");
      const oldRun = await team.agent.expect("prompt");
      await say(team, team.group.id, "@小销 换个问题");
      const newRun = await team.agent.expect("prompt");
      expect(newRun.botId).toBe(team.sales.id);
      reply(team, oldRun.runId, team.service.id, "旧问题的回复");
      finish(team, oldRun.runId, team.service.id);
      finish(team, newRun.runId, team.sales.id);
      for (;;) {
        const push = await team.push.next();
        if (push.type === "message" && push.message.body.kind === "cost" && push.message.body.runId === newRun.runId)
          break;
      }
      expect(await runCount(team.group.id), "旧回合的第二位不该再建 run").toBe(2);
      expect(
        (await messagesIn(team, team.group.id)).some(
          (message) => message.body.kind === "bot" && message.body.text === "旧问题的回复",
        ),
      ).toBe(true);
    } finally {
      team.close();
    }
  });

  it("重连 /api/ws 会收到正在进行的 group_turn 快照", async () => {
    const team = await makeTeam();
    const second = await (async () => {
      await say(team, team.group.id, "@小服 @小销 一起看");
      await team.agent.expect("prompt");
      return connectPush(server.server.port, team.client.cookie ?? "");
    })();
    try {
      const snapshot = await second.nextRaw();
      expect(snapshot.type).toBe("group_turn");
      if (snapshot.type === "group_turn") {
        expect(snapshot.groupId).toBe(team.group.id);
        expect(snapshot.epoch).toBeGreaterThan(0);
        expect(snapshot.current).toBe(team.service.id);
        expect(snapshot.next).toEqual([team.sales.id]);
      }
    } finally {
      second.close();
      team.close();
    }
  });
});

describe("上行 set_chief", () => {
  it("群外目标整条丢弃；卸任推 group_updated 且只落一条系统消息", async () => {
    const team = await makeTeam();
    try {
      const runId = await runFor(team, team.group.id, "@小销 设置首席");
      const outsider = (await makeBot(team.client, "小采", "采购")).bot;
      await team.agent.expect("config");
      const sendChief = (targetBotId: BotId | null) =>
        team.agent.send({
          type: "set_chief",
          runId,
          botId: team.sales.id,
          groupId: team.group.id,
          targetBotId,
        });
      sendChief(outsider.id);
      sendChief(team.sales.id);
      for (;;) {
        const push = await team.push.next();
        if (push.type === "group_updated") {
          expect(push.group.chiefBotId).toBe(team.sales.id);
          break;
        }
      }
      sendChief(team.sales.id);
      sendChief(null);
      for (;;) {
        const push = await team.push.next();
        if (push.type === "group_updated") {
          expect(push.group.chiefBotId).toBeNull();
          break;
        }
      }
      for (;;) {
        const push = await team.push.next();
        if (push.type === "message" && push.message.body.kind === "system" && push.message.body.text === "小销卸任首席")
          break;
      }
      const systems = (await messagesIn(team, team.group.id)).flatMap((message) =>
        message.body.kind === "system" ? [message.body] : [],
      );
      expect(systems).toEqual([
        { kind: "system", text: "小销成为首席" },
        { kind: "system", text: "小销卸任首席" },
      ]);
      const detail = GroupResponse.parse(await (await team.client.get(`/api/groups/${team.group.id}`)).json());
      expect(detail.group.chiefBotId).toBeNull();
    } finally {
      team.close();
    }
  });

  it("单 Bot 群的 set_chief 整条丢弃", async () => {
    const team = await makeTeam();
    try {
      const runId = await runFor(team, team.soloGroupId, "我来");
      team.agent.send({
        type: "set_chief",
        runId,
        botId: team.service.id,
        groupId: team.soloGroupId,
        targetBotId: team.service.id,
      });
      finish(team, runId, team.service.id, team.soloGroupId);
      for (;;) {
        const push = await team.push.next();
        if (push.type === "message" && push.message.body.kind === "cost" && push.message.body.runId === runId) break;
        expect(push.type).not.toBe("group_updated");
      }
      const detail = GroupResponse.parse(await (await team.client.get(`/api/groups/${team.soloGroupId}`)).json());
      expect(detail.group.chiefBotId).toBeNull();
      expect(
        (await messagesIn(team, team.soloGroupId)).filter((message) => message.body.kind === "system"),
      ).toHaveLength(0);
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
      await mentioned(team, team.sales.id);

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
      await mentioned(team, team.sales.id);
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
      expect((await team.push.next()).type, "单 Bot 群只推用户那条消息，没有经手可言").toBe("message");

      team.agent.send({
        type: "task_checklist",
        runId: soloRunId,
        botId: team.service.id,
        groupId: team.group.id,
        checklist: [item("借道插一条", false, null)],
      });
      const groupRunId = await runFor(team, team.group.id, "@小销 记一下");
      await mentioned(team, team.sales.id);
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
/** @ 了人之后控制面先推用户那条消息，再推经手换人的任务卡。两条都收掉，断言经手是被 @ 的那个。 */
async function mentioned(team: Team, botId: BotId): Promise<void> {
  expect((await team.push.next()).type, "先收掉用户那条消息的推送").toBe("message");
  const updated = await team.push.next();
  expect(updated.type, "@ 谁谁就成为经手，任务卡紧跟着推").toBe("task_updated");
  expect(updated.type === "task_updated" ? updated.task.currentBotId : null).toBe(botId);
}

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
      finish(team, runId, team.sales.id);

      // 小销要是也收到了，按成员顺序它那条会排在前面，所以这里读到小服就说明只派了一个。
      const prompt = await team.agent.expect("prompt");
      expect(prompt.botId).toBe(team.service.id);
      expect(prompt.text).toBe("@小服 这单退款你看下");
      expect(prompt.origin, "队友 @ 来的活要带发信人，运行器据此提醒模型这不是用户说的").toEqual({
        kind: "bot",
        id: team.sales.id,
        name: "小销",
        tag: "销售",
      });

      const bodies = (await messagesIn(team, team.group.id)).map((message) => message.body);
      expect(bodies.find((body) => body.kind === "bot")).toEqual({
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
      finish(team, runId, team.sales.id);

      const prompt = await team.agent.expect("prompt");
      expect(prompt.botId).toBe(team.service.id);
      expect((await messagesIn(team, team.group.id)).filter((message) => message.body.kind === "bot")).toHaveLength(1);
    } finally {
      team.close();
    }
  });

  it("Bot 消息累计到 10 条就留一句提示并停止派发", async () => {
    const team = await makeTeam();
    try {
      const runId = await runFor(team, team.group.id, "@小销 开个头");
      for (let i = 0; i < BOT_MESSAGE_LIMIT; i += 1) reply(team, runId, team.sales.id, `第 ${i + 1} 条`);
      await waitForSystemPush(team, MENTION_LOOP_NOTICE);
      finish(team, runId, team.sales.id);
      const bodies = (await messagesIn(team, team.group.id)).map((message) => message.body);
      expect(bodies.filter((body) => body.kind === "bot")).toHaveLength(BOT_MESSAGE_LIMIT);
      expect(bodies.filter((body) => body.kind === "system" && body.text === MENTION_LOOP_NOTICE)).toHaveLength(1);
      await say(team, team.group.id, "@小服 新一轮");
      expect((await team.agent.expect("prompt")).botId).toBe(team.service.id);
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
