import { ApiError, BotListResponse, CreateBotResponse, UpdateBotResponse, type BotHue } from "@baize/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { groupMembers, tasks } from "../src/db/schema.js";
import { HUE_ROTATION } from "../src/naming.js";
import { startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeUser } from "./helpers/fixtures.js";
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

async function loggedInClient() {
  const user = await makeUser(database.db);
  const client = server.client();
  const response = await client.login(user.email, PASSWORD);
  expect(response.status).toBe(200);
  return client;
}

describe("建 Bot", () => {
  it("同步建单 Bot 群和一条主题任务，编号从 T-1001 起按用户递增", async () => {
    const client = await loggedInClient();

    const numbers: string[] = [];
    for (const _ of [0, 1, 2]) {
      const response = await client.post("/api/bots", {});
      expect(response.status).toBe(201);
      const { bot, group } = CreateBotResponse.parse(await response.json());

      expect(group.botIds, "单 Bot 群的成员只有它自己").toEqual([bot.id]);
      const members = await database.db.select().from(groupMembers).where(eq(groupMembers.groupId, group.id));
      expect(members.map((m) => m.botId)).toEqual([bot.id]);

      const [task] = await database.db.select().from(tasks).where(eq(tasks.id, group.taskId));
      expect(task, "群必须带一条主题任务").toBeDefined();
      expect(task?.groupId).toBe(group.id);
      expect(task?.title, "单 Bot 群的任务标题默认是 Bot 名").toBe(bot.name);
      expect(task?.status).toBe("active");
      numbers.push(task?.number ?? "");
    }

    expect(numbers).toEqual(["T-1001", "T-1002", "T-1003"]);
  });

  it("另一个用户的编号也从 T-1001 起", async () => {
    const client = await loggedInClient();
    const { group } = CreateBotResponse.parse(await (await client.post("/api/bots", {})).json());
    const [task] = await database.db.select().from(tasks).where(eq(tasks.id, group.taskId));
    expect(task?.number).toBe("T-1001");
  });

  it("不给名字时系统起「小」加一个字，色相按七个轮流分配", async () => {
    const client = await loggedInClient();

    const hues: BotHue[] = [];
    for (let i = 0; i < HUE_ROTATION.length + 1; i += 1) {
      const { bot } = CreateBotResponse.parse(await (await client.post("/api/bots", {})).json());
      expect(bot.name, "系统起的名字是「小」加一个汉字").toMatch(/^小[一-龥]$/);
      expect(bot.tag).toBe("");
      expect(bot.notify).toBe(true);
      hues.push(bot.hue);
    }

    expect(hues.slice(0, HUE_ROTATION.length)).toEqual([...HUE_ROTATION]);
    expect(hues[HUE_ROTATION.length], "第八个 Bot 转回第一个色相").toBe(HUE_ROTATION[0]);
  });

  it("给了字段就用给的", async () => {
    const client = await loggedInClient();
    const response = await client.post("/api/bots", {
      name: "小服",
      tag: "客服",
      description: "退款先找我点头。",
      hue: "violet",
    });
    const { bot } = CreateBotResponse.parse(await response.json());
    expect(bot).toMatchObject({
      name: "小服",
      tag: "客服",
      description: "退款先找我点头。",
      hue: "violet",
    });
  });

  it("名字超过 20 字返回 400", async () => {
    const client = await loggedInClient();
    const response = await client.post("/api/bots", { name: "小".repeat(21) });
    expect(response.status).toBe(400);
    ApiError.parse(await response.json());
  });
});

describe("Bot 列表", () => {
  it("只列自己的 Bot，带上它的单 Bot 群和最近一条消息", async () => {
    const mine = await loggedInClient();
    const created = CreateBotResponse.parse(await (await mine.post("/api/bots", { name: "小采" })).json());
    await mine.post(`/api/groups/${created.group.id}/messages`, { text: "先比个价" });
    await mine.post(`/api/groups/${created.group.id}/messages`, { text: "再看交期" });

    const other = await loggedInClient();
    await other.post("/api/bots", { name: "别人的" });

    const list = BotListResponse.parse(await (await mine.get("/api/bots")).json());
    expect(list.items.map((i) => i.bot.name)).toEqual(["小采"]);

    const item = list.items[0];
    expect(item?.groupId).toBe(created.group.id);
    expect(item?.lastMessage?.body, "最近一条应当是后发的那条").toEqual({
      kind: "user",
      text: "再看交期",
    });
    expect(item?.pendingApprovals).toBe(0);
  });

  it("没发过消息的 Bot 的 lastMessage 是 null", async () => {
    const client = await loggedInClient();
    await client.post("/api/bots", { name: "小销" });
    const list = BotListResponse.parse(await (await client.get("/api/bots")).json());
    expect(list.items[0]?.lastMessage).toBeNull();
  });
});

describe("改 Bot", () => {
  it("只改传了的字段", async () => {
    const client = await loggedInClient();
    const { bot } = CreateBotResponse.parse(
      await (await client.post("/api/bots", { name: "小销", tag: "销售", description: "原描述" })).json(),
    );

    const response = await client.patch(`/api/bots/${bot.id}`, { description: "新描述", notify: false });
    expect(response.status).toBe(200);
    const updated = UpdateBotResponse.parse(await response.json()).bot;

    expect(updated.description).toBe("新描述");
    expect(updated.notify).toBe(false);
    expect(updated.name, "没传的字段不动").toBe("小销");
    expect(updated.tag).toBe("销售");
    expect(updated.hue).toBe(bot.hue);
  });

  it("改别人的 Bot 返回 404", async () => {
    const owner = await loggedInClient();
    const { bot } = CreateBotResponse.parse(await (await owner.post("/api/bots", {})).json());

    const stranger = await loggedInClient();
    const response = await stranger.patch(`/api/bots/${bot.id}`, { name: "抢过来" });
    expect(response.status).toBe(404);
    ApiError.parse(await response.json());

    const still = BotListResponse.parse(await (await owner.get("/api/bots")).json());
    expect(still.items[0]?.bot.name, "别人的 PATCH 不应当改到数据").toBe(bot.name);
  });
});

describe("删 Bot", () => {
  it("删完列表里不含它，它的群也跟着没了", async () => {
    const client = await loggedInClient();
    const keep = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "留着" })).json());
    const drop = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "删掉" })).json());

    const response = await client.delete(`/api/bots/${drop.bot.id}`);
    expect(response.status).toBe(204);

    const list = BotListResponse.parse(await (await client.get("/api/bots")).json());
    expect(list.items.map((i) => i.bot.id)).toEqual([keep.bot.id]);

    const messages = await client.get(`/api/groups/${drop.group.id}/messages`);
    expect(messages.status, "群随 Bot 一起删掉").toBe(404);

    const leftoverTasks = await database.db.select().from(tasks).where(eq(tasks.id, drop.group.taskId));
    expect(leftoverTasks, "主题任务也应当级联删掉").toEqual([]);
  });

  it("删别人的 Bot 返回 404 且对方还在", async () => {
    const owner = await loggedInClient();
    const { bot } = CreateBotResponse.parse(await (await owner.post("/api/bots", {})).json());

    const stranger = await loggedInClient();
    expect((await stranger.delete(`/api/bots/${bot.id}`)).status).toBe(404);

    const list = BotListResponse.parse(await (await owner.get("/api/bots")).json());
    expect(list.items.map((i) => i.bot.id)).toContain(bot.id);
  });

  it("同一个 Bot 删两次，第二次 404 且不再推 bot_deleted", async () => {
    const client = await loggedInClient();
    const { bot } = CreateBotResponse.parse(await (await client.post("/api/bots", {})).json());
    const push = await connectPush(server.server.port, client.cookie ?? "");

    try {
      expect((await client.delete(`/api/bots/${bot.id}`)).status).toBe(204);
      expect((await push.next()).type).toBe("bot_deleted");

      expect((await client.delete(`/api/bots/${bot.id}`)).status).toBe(404);

      // 再建一个并等它的推送。先到的是建出来的那条 bot_updated，说明第二次删没推。
      const next = CreateBotResponse.parse(await (await client.post("/api/bots", {})).json());
      await client.patch(`/api/bots/${next.bot.id}`, { tag: "标记" });
      expect((await push.next()).type).toBe("bot_updated");
    } finally {
      push.close();
    }
  });

  it("删不存在的 Bot 返回 404", async () => {
    const client = await loggedInClient();
    const response = await client.delete("/api/bots/00000000-0000-0000-0000-000000000000");
    expect(response.status).toBe(404);
    ApiError.parse(await response.json());
  });
});

describe("Bot 变更的 WebSocket 推送", () => {
  it("改和删各推一条给这个用户", async () => {
    const client = await loggedInClient();
    const { bot } = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小测" })).json());
    const push = await connectPush(server.server.port, client.cookie ?? "");

    try {
      await client.patch(`/api/bots/${bot.id}`, { tag: "测试" });
      const updated = await push.next();
      expect(updated.type).toBe("bot_updated");
      expect(updated.type === "bot_updated" ? updated.bot.tag : null).toBe("测试");

      await client.delete(`/api/bots/${bot.id}`);
      const deleted = await push.next();
      expect(deleted.type).toBe("bot_deleted");
      expect(deleted.type === "bot_deleted" ? deleted.botId : null).toBe(bot.id);
    } finally {
      push.close();
    }
  });
});

describe("并发建 Bot", () => {
  it("五个请求同时进来，编号和色相都不重复", async () => {
    const client = await loggedInClient();
    const responses = await Promise.all([0, 1, 2, 3, 4].map(() => client.post("/api/bots", {})));
    const created = await Promise.all(
      responses.map(async (r) => {
        expect(r.status).toBe(201);
        return CreateBotResponse.parse(await r.json());
      }),
    );

    const numbers = await Promise.all(
      created.map(async ({ group }) => {
        const [task] = await database.db.select().from(tasks).where(eq(tasks.id, group.taskId));
        return task?.number ?? "";
      }),
    );
    expect(numbers.toSorted()).toEqual(["T-1001", "T-1002", "T-1003", "T-1004", "T-1005"]);
    expect(new Set(created.map((c) => c.bot.hue)).size, "五个自动分配的色相互不相同").toBe(5);
  });
});
