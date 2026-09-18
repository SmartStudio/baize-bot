import { randomUUID } from "node:crypto";
import {
  ApiError,
  CreateBotResponse,
  CreateGroupResponse,
  GroupListResponse,
  GroupResponse,
  UpdateTaskResponse,
  type Bot,
  type BotId,
  type Group,
  type TopicTask,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HUE_ROTATION } from "../src/naming.js";
import { appendMessage } from "../src/repo/messages.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser } from "./helpers/fixtures.js";
import { connectPush } from "./helpers/ws.js";

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

async function loggedInClient(): Promise<ApiClient> {
  const user = await makeUser(database.db);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  return client;
}

/** 电脑要在这个用户第一次登录之前建，token 明文只在那一刻拿得到。 */
async function loggedInClientWithAgent(): Promise<{ readonly client: ApiClient; readonly agent: AgentClient }> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  return { client, agent };
}

async function makeBot(client: ApiClient, name: string): Promise<Bot> {
  const response = await client.post("/api/bots", { name });
  expect(response.status).toBe(201);
  return CreateBotResponse.parse(await response.json()).bot;
}

type OpenedGroup = { readonly group: Group; readonly task: TopicTask };

async function openGroup(client: ApiClient, body: Record<string, unknown>): Promise<OpenedGroup> {
  const response = await client.post("/api/groups", body);
  expect(response.status).toBe(201);
  return CreateGroupResponse.parse(await response.json());
}

function taskNumberValue(number: string): number {
  const digits = /^T-(\d{4})$/.exec(number)?.[1];
  if (digits === undefined) throw new Error(`任务编号 ${number} 不是 T- 四位`);
  return Number(digits);
}

describe("建群", () => {
  it("返回 201，成员顺序按请求给的来，任务是一条崭新的待办", async () => {
    const client = await loggedInClient();
    const sales = await makeBot(client, "小销");
    const buyer = await makeBot(client, "小采");

    const { group, task } = await openGroup(client, {
      title: "双十一大促",
      botIds: [buyer.id, sales.id],
      summary: "先定价再备货",
    });

    expect(group.botIds, "成员顺序就是请求里的顺序").toEqual([buyer.id, sales.id]);
    expect(group.taskId).toBe(task.id);
    expect(task.groupId).toBe(group.id);
    expect(task.number).toMatch(/^T-\d{4}$/);
    expect(task.title).toBe("双十一大促");
    expect(task.summary).toBe("先定价再备货");
    expect(task.dueAt, "没给期限就是没有期限").toBeNull();
    expect(task.currentBotId, "刚建的群还没人经手").toBeNull();
    expect(task.checklist).toEqual([]);
    expect(task.handled).toEqual([]);
    expect(task.status).toBe("active");
  });

  it("同一个用户连建两个群，编号递增 1", async () => {
    const client = await loggedInClient();
    const sales = await makeBot(client, "小销");
    const buyer = await makeBot(client, "小采");
    const botIds = [sales.id, buyer.id];

    const first = await openGroup(client, { title: "第一件事", botIds });
    const second = await openGroup(client, { title: "第二件事", botIds });

    expect(taskNumberValue(second.task.number)).toBe(taskNumberValue(first.task.number) + 1);
  });

  it("全新用户的第一个 Bot 拿 T-1001，它的单 Bot 群也查得到", async () => {
    const client = await loggedInClient();
    const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小服" })).json());

    const response = await client.get(`/api/groups/${created.group.id}`);
    expect(response.status, "单 Bot 群不显示任务卡，但查得到").toBe(200);
    const detail = GroupResponse.parse(await response.json());
    expect(detail.task.number, "编号计数器从 T-1001 起").toBe("T-1001");
    expect(detail.bots.map((bot) => bot.id)).toEqual([created.bot.id]);
  });

  it("拉别人的 Bot 进群返回 404", async () => {
    const owner = await loggedInClient();
    const his = await makeBot(owner, "小销");

    const stranger = await loggedInClient();
    const mine = await makeBot(stranger, "小采");
    const response = await stranger.post("/api/groups", { title: "混编", botIds: [mine.id, his.id] });

    expect(response.status, "别人的 Bot 和不存在的 Bot 一样是 404").toBe(404);
    ApiError.parse(await response.json());
  });

  it("不存在的 Bot id 返回 404", async () => {
    const client = await loggedInClient();
    const sales = await makeBot(client, "小销");
    const response = await client.post("/api/groups", { title: "凑不齐", botIds: [sales.id, randomUUID()] });
    expect(response.status).toBe(404);
    ApiError.parse(await response.json());
  });

  it("同一个 Bot 重复拉进群返回 400", async () => {
    const client = await loggedInClient();
    const sales = await makeBot(client, "小销");
    const response = await client.post("/api/groups", { title: "重了", botIds: [sales.id, sales.id] });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "同一个 Bot 不能重复拉进群" });
  });

  it("只有一个成员或者超过六个成员都返回 400", async () => {
    const client = await loggedInClient();
    const sales = await makeBot(client, "小销");

    const single = await client.post("/api/groups", { title: "一个人", botIds: [sales.id] });
    expect(single.status, "单 Bot 群不走这个接口").toBe(400);
    ApiError.parse(await single.json());

    const seven = await client.post("/api/groups", {
      title: "七个人",
      botIds: [0, 1, 2, 3, 4, 5, 6].map(() => randomUUID()),
    });
    expect(seven.status, "一个群最多六个 Bot").toBe(400);
    ApiError.parse(await seven.json());
  });

  it("空标题和超过 60 字的标题都返回 400", async () => {
    const client = await loggedInClient();
    const sales = await makeBot(client, "小销");
    const buyer = await makeBot(client, "小采");
    const botIds = [sales.id, buyer.id];

    expect((await client.post("/api/groups", { title: "", botIds })).status).toBe(400);
    expect((await client.post("/api/groups", { title: "长".repeat(61), botIds })).status).toBe(400);
  });

  it("建群不占色相，下一个 Bot 不跳色", async () => {
    const client = await loggedInClient();
    const first = await makeBot(client, "小销");
    const second = await makeBot(client, "小采");
    await openGroup(client, { title: "不该动色相", botIds: [first.id, second.id] });

    const third = await makeBot(client, "小服");
    expect([first.hue, second.hue]).toEqual([HUE_ROTATION[0], HUE_ROTATION[1]]);
    expect(third.hue, "建群不分配色相，跟着推进计数器的话这里会跳过一个").toBe(HUE_ROTATION[2]);
  });

  it("建群不重发 config", async () => {
    const { client, agent } = await loggedInClientWithAgent();

    try {
      const sales = await makeBot(client, "小销");
      await agent.expect("config");
      const buyer = await makeBot(client, "小采");
      await agent.expect("config");

      const created = await openGroup(client, { title: "开个群", botIds: [sales.id, buyer.id] });

      // 紧跟一条确定会下发的报文，它先到就说明建群什么都没往电脑发，不靠超时。
      // 新群还没有当前经手，不 @ 人就没人可派，所以这里点名。
      await client.post(`/api/groups/${created.group.id}/messages`, { text: "@小销 开工" });
      const next = await agent.next();
      expect(next.type, "config 里只有 Bot 列表，建群没有改它").toBe("prompt");
    } finally {
      agent.close();
    }
  });

  it("建群推一条 group_created 给这个用户", async () => {
    const client = await loggedInClient();
    const sales = await makeBot(client, "小销");
    const buyer = await makeBot(client, "小采");
    const push = await connectPush(server.server.port, client.cookie ?? "");

    try {
      const created = await openGroup(client, { title: "对齐排期", botIds: [sales.id, buyer.id] });
      const pushed = await push.next();
      expect(pushed.type).toBe("group_created");
      expect(pushed.type === "group_created" ? pushed.group.id : null).toBe(created.group.id);
      expect(pushed.type === "group_created" ? pushed.task.number : null).toBe(created.task.number);
    } finally {
      push.close();
    }
  });
});

describe("群列表", () => {
  it("只列多 Bot 群，建 Bot 时自动建的单 Bot 群不在里面", async () => {
    const client = await loggedInClient();
    const sales = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小销" })).json());
    const buyer = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小采" })).json());

    const created = await openGroup(client, { title: "定价", botIds: [sales.bot.id, buyer.bot.id] });

    const list = GroupListResponse.parse(await (await client.get("/api/groups")).json());
    expect(
      list.items.map((item) => item.group.id),
      "单 Bot 群在 /api/bots 里，不在这里",
    ).toEqual([created.group.id]);
    expect(list.items[0]?.task.title).toBe("定价");
  });

  it("带上最近一条消息和待批审批数", async () => {
    const client = await loggedInClient();
    const sales = await makeBot(client, "小销");
    const buyer = await makeBot(client, "小采");
    const created = await openGroup(client, { title: "比价", botIds: [sales.id, buyer.id] });

    // 直接写库排状态。走 POST 的话电脑不在线那条系统消息会变成最近一条。
    await appendMessage(database.db, created.group.id, { kind: "user", text: "先比个价" });
    await appendMessage(database.db, created.group.id, { kind: "user", text: "再看交期" });

    const list = GroupListResponse.parse(await (await client.get("/api/groups")).json());
    const item = list.items.find((entry) => entry.group.id === created.group.id);
    expect(item?.lastMessage?.body, "最近一条应当是后发的那条").toEqual({ kind: "user", text: "再看交期" });
    expect(item?.pendingApprovals).toBe(0);
  });

  it("没发过消息的群的 lastMessage 是 null", async () => {
    const client = await loggedInClient();
    const sales = await makeBot(client, "小销");
    const buyer = await makeBot(client, "小采");
    await openGroup(client, { title: "还没说话", botIds: [sales.id, buyer.id] });

    const list = GroupListResponse.parse(await (await client.get("/api/groups")).json());
    expect(list.items[0]?.lastMessage).toBeNull();
  });

  it("只列自己的群", async () => {
    const mine = await loggedInClient();
    const a = await makeBot(mine, "小销");
    const b = await makeBot(mine, "小采");
    const created = await openGroup(mine, { title: "我的事", botIds: [a.id, b.id] });

    const other = await loggedInClient();
    const c = await makeBot(other, "小研");
    const d = await makeBot(other, "小测");
    await openGroup(other, { title: "别人的事", botIds: [c.id, d.id] });

    const list = GroupListResponse.parse(await (await mine.get("/api/groups")).json());
    expect(list.items.map((item) => item.group.id)).toEqual([created.group.id]);
  });
});

describe("群详情", () => {
  it("回群、任务和按 position 排的成员", async () => {
    const client = await loggedInClient();
    const sales = await makeBot(client, "小销");
    const buyer = await makeBot(client, "小采");
    const clerk = await makeBot(client, "小服");
    const created = await openGroup(client, { title: "三个人的事", botIds: [clerk.id, sales.id, buyer.id] });

    const detail = GroupResponse.parse(await (await client.get(`/api/groups/${created.group.id}`)).json());
    expect(detail.group.id).toBe(created.group.id);
    expect(detail.task.number).toBe(created.task.number);
    expect(
      detail.bots.map((bot) => bot.id),
      "成员按入群时的位置排",
    ).toEqual([clerk.id, sales.id, buyer.id]);
    expect(detail.group.botIds).toEqual([clerk.id, sales.id, buyer.id]);
    expect(detail.bots.map((bot) => bot.name)).toEqual(["小服", "小销", "小采"]);
  });

  it("别人的群和不存在的群都返回 404", async () => {
    const owner = await loggedInClient();
    const a = await makeBot(owner, "小销");
    const b = await makeBot(owner, "小采");
    const created = await openGroup(owner, { title: "我的事", botIds: [a.id, b.id] });

    const stranger = await loggedInClient();
    expect((await stranger.get(`/api/groups/${created.group.id}`)).status).toBe(404);
    expect((await owner.get(`/api/groups/${randomUUID()}`)).status).toBe(404);
  });
});

describe("改任务", () => {
  async function taskToEdit(client: ApiClient): Promise<{ readonly created: OpenedGroup; readonly owner: BotId }> {
    const sales = await makeBot(client, "小销");
    const buyer = await makeBot(client, "小采");
    const created = await openGroup(client, {
      title: "老标题",
      botIds: [sales.id, buyer.id],
      summary: "这句不该被动",
    });
    return { created, owner: sales.id };
  }

  it("改标题和清单，没给的字段不动，并推一条 task_updated", async () => {
    const client = await loggedInClient();
    const { created, owner } = await taskToEdit(client);
    const push = await connectPush(server.server.port, client.cookie ?? "");

    try {
      const checklist = [
        { text: "比三家价", done: true, ownerBotId: owner },
        { text: "定交期", done: false, ownerBotId: null },
      ];
      const response = await client.patch(`/api/tasks/${created.task.id}`, { title: "新标题", checklist });
      expect(response.status).toBe(200);
      const { task } = UpdateTaskResponse.parse(await response.json());

      expect(task.title).toBe("新标题");
      expect(task.checklist, "清单是整份替换").toEqual(checklist);
      expect(task.summary, "没传的字段不动").toBe("这句不该被动");
      expect(task.status).toBe("active");

      const pushed = await push.next();
      expect(pushed.type).toBe("task_updated");
      expect(pushed.type === "task_updated" ? pushed.task.title : null).toBe("新标题");
    } finally {
      push.close();
    }
  });

  it("改期限和状态，期限能设也能清掉", async () => {
    const client = await loggedInClient();
    const { created } = await taskToEdit(client);

    const due = "2026-10-01T09:00:00.000Z";
    const set = UpdateTaskResponse.parse(
      await (await client.patch(`/api/tasks/${created.task.id}`, { dueAt: due, status: "done" })).json(),
    );
    expect(set.task.dueAt).toBe(due);
    expect(set.task.status).toBe("done");

    const cleared = UpdateTaskResponse.parse(
      await (await client.patch(`/api/tasks/${created.task.id}`, { dueAt: null })).json(),
    );
    expect(cleared.task.dueAt, "给 null 就是清掉期限").toBeNull();
    expect(cleared.task.status, "没传的字段不动").toBe("done");
  });

  it("改别人的任务返回 404 且原任务没被改到", async () => {
    const owner = await loggedInClient();
    const { created } = await taskToEdit(owner);

    const stranger = await loggedInClient();
    const response = await stranger.patch(`/api/tasks/${created.task.id}`, { title: "抢过来" });
    expect(response.status).toBe(404);
    ApiError.parse(await response.json());

    const detail = GroupResponse.parse(await (await owner.get(`/api/groups/${created.group.id}`)).json());
    expect(detail.task.title, "别人的 PATCH 不应当改到数据").toBe("老标题");
  });

  it("不存在的任务返回 404", async () => {
    const client = await loggedInClient();
    expect((await client.patch(`/api/tasks/${randomUUID()}`, { title: "无主" })).status).toBe(404);
  });
});
