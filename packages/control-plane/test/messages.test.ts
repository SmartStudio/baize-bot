import {
  ApiError,
  CreateBotResponse,
  MessageId,
  MessageListResponse,
  RunId,
  SendMessageResponse,
  type Message,
} from "@baize/shared";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendMessage, appendMessageWithId } from "../src/repo/messages.js";
import { helloAgent } from "./helpers/agent.js";
import { startTestServer, type TestServer } from "./helpers/client.js";
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

async function loggedInClient() {
  const user = await makeUser(database.db);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  return client;
}

async function clientWithGroup() {
  const client = await loggedInClient();
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", {})).json());
  return { client, groupId: created.group.id };
}

describe("发消息", () => {
  it("存下用户消息并回 201", async () => {
    const { client, groupId } = await clientWithGroup();
    const response = await client.post(`/api/groups/${groupId}/messages`, { text: "看看电脑里有哪些文件" });

    expect(response.status).toBe(201);
    const { message } = SendMessageResponse.parse(await response.json());
    expect(message.groupId).toBe(groupId);
    expect(message.body).toEqual({ kind: "user", text: "看看电脑里有哪些文件" });
  });

  it("推一条 ServerPush message 给这个用户的全部连接", async () => {
    const { client, groupId } = await clientWithGroup();
    const cookie = client.cookie ?? "";
    const one = await connectPush(server.server.port, cookie);
    const two = await connectPush(server.server.port, cookie);

    try {
      const { message } = SendMessageResponse.parse(
        await (await client.post(`/api/groups/${groupId}/messages`, { text: "派个活" })).json(),
      );

      for (const push of [await one.next(), await two.next()]) {
        expect(push.type).toBe("message");
        expect(push.type === "message" ? push.message : null).toEqual(message);
      }
    } finally {
      one.close();
      two.close();
    }
  });

  it("不推给别的用户", async () => {
    const { client, groupId } = await clientWithGroup();
    const bystander = await loggedInClient();
    const own = CreateBotResponse.parse(await (await bystander.post("/api/bots", {})).json());
    const listener = await connectPush(server.server.port, bystander.cookie ?? "");

    try {
      await client.post(`/api/groups/${groupId}/messages`, { text: "只给我自己看" });
      await bystander.post(`/api/groups/${own.group.id}/messages`, { text: "我自己的" });

      // 后发的自己那条先到，说明前面别人那条根本没进这条连接，不靠超时。
      const push = await listener.next();
      expect(push.type === "message" ? push.message.body : null).toEqual({
        kind: "user",
        text: "我自己的",
      });
    } finally {
      listener.close();
    }
  });

  it("空文本返回 400", async () => {
    const { client, groupId } = await clientWithGroup();
    const response = await client.post(`/api/groups/${groupId}/messages`, { text: "" });
    expect(response.status).toBe(400);
    ApiError.parse(await response.json());
  });
});

describe("读消息", () => {
  it("按时间正序返回，翻页用 before 往前取", async () => {
    const { client, groupId } = await clientWithGroup();
    // 直接写库排状态。走 POST 的话派活那一步还会在中间插系统消息，这里只想验翻页。
    for (const text of ["一", "二", "三", "四", "五"]) {
      await appendMessage(database.db, groupId, { kind: "user", text });
    }

    const page = MessageListResponse.parse(await (await client.get(`/api/groups/${groupId}/messages?limit=2`)).json());
    expect(page.messages.map(textOf)).toEqual(["四", "五"]);
    expect(page.hasMore).toBe(true);

    const older = MessageListResponse.parse(
      await (await client.get(`/api/groups/${groupId}/messages?limit=2&before=${page.messages[0]?.id}`)).json(),
    );
    expect(older.messages.map(textOf)).toEqual(["二", "三"]);
    expect(older.hasMore).toBe(true);

    const oldest = MessageListResponse.parse(
      await (await client.get(`/api/groups/${groupId}/messages?limit=2&before=${older.messages[0]?.id}`)).json(),
    );
    expect(oldest.messages.map(textOf)).toEqual(["一"]);
    expect(oldest.hasMore, "翻到头了就没有更多").toBe(false);
  });

  it("新群是空的", async () => {
    const { client, groupId } = await clientWithGroup();
    const page = MessageListResponse.parse(await (await client.get(`/api/groups/${groupId}/messages`)).json());
    expect(page).toEqual({ messages: [], hasMore: false, approvals: [], handoffs: [], drafts: [], plans: [] });
  });
});

describe("别人的群", () => {
  it("读和写都返回 404", async () => {
    const { client, groupId } = await clientWithGroup();
    await appendMessage(database.db, groupId, { kind: "user", text: "私密" });

    const stranger = await loggedInClient();
    const read = await stranger.get(`/api/groups/${groupId}/messages`);
    const write = await stranger.post(`/api/groups/${groupId}/messages`, { text: "插一句" });

    expect(read.status).toBe(404);
    ApiError.parse(await read.json());
    expect(write.status).toBe(404);
    ApiError.parse(await write.json());

    const mine = MessageListResponse.parse(await (await client.get(`/api/groups/${groupId}/messages`)).json());
    expect(mine.messages.map(textOf), "别人的写入不应当落进来").toEqual(["私密"]);
  });

  it("不存在的群返回 404", async () => {
    const client = await loggedInClient();
    const response = await client.get("/api/groups/00000000-0000-0000-0000-000000000000/messages");
    expect(response.status).toBe(404);
    ApiError.parse(await response.json());
  });
});

describe("跨群改消息", () => {
  it("拿别的群里那条消息的 id 发 bot_text，既改不动那条也不落进自己的群", async () => {
    const victimOwner = await makeUser(database.db);
    const victimClient = server.client();
    expect((await victimClient.login(victimOwner.email, PASSWORD)).status).toBe(200);
    const victimBot = CreateBotResponse.parse(await (await victimClient.post("/api/bots", {})).json());
    const victimMessageId = MessageId.parse(randomUUID());
    const victimBody = { kind: "bot", botId: victimBot.bot.id, text: "别人群里的正文", streaming: false } as const;
    await appendMessageWithId(database.db, victimMessageId, victimBot.group.id, victimBody);

    const attackerOwner = await makeUser(database.db);
    const computer = await makeComputer(database.db, attackerOwner.id);
    const attackerClient = server.client();
    expect((await attackerClient.login(attackerOwner.email, PASSWORD)).status).toBe(200);
    const attackerBot = CreateBotResponse.parse(await (await attackerClient.post("/api/bots", {})).json());
    const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
    const push = await connectPush(server.server.port, attackerClient.cookie ?? "");
    const ownMessageId = MessageId.parse(randomUUID());
    // 上行报文的 runId 要真属于这个 Bot 在这个群里，否则整条在归属校验那里就被丢掉，撞号这一关根本走不到。
    // 直接插一行而不是发条消息派活：派活会在攻击者群里留下一条用户消息，最后那句「只该有后发那条」就不成立了。
    const runId = RunId.parse(randomUUID());
    await database.sql`
      INSERT INTO runs (id, bot_id, group_id, computer_id, started_at)
      VALUES (${runId}, ${attackerBot.bot.id}, ${attackerBot.group.id}, ${computer.computerId}, now())
    `;

    try {
      agent.send({
        type: "bot_text",
        runId,
        botId: attackerBot.bot.id,
        groupId: attackerBot.group.id,
        messageId: victimMessageId,
        delta: "偷改",
        done: true,
      });
      // 后发的这条能落地，它先推出来就说明上一条什么也没做，不靠超时。
      agent.send({
        type: "bot_text",
        runId,
        botId: attackerBot.bot.id,
        groupId: attackerBot.group.id,
        messageId: ownMessageId,
        delta: "自己的正文",
        done: true,
      });

      const pushes: Awaited<ReturnType<typeof push.next>>[] = [];
      for (;;) {
        const received = await push.next();
        pushes.push(received);
        // 等到收尾那一片再读库，不然读到的是刚插进去、正文还空着的空壳。
        if (received.type === "message_delta" && received.messageId === ownMessageId && received.done) break;
      }
      const victimPage = MessageListResponse.parse(
        await (await victimClient.get(`/api/groups/${victimBot.group.id}/messages`)).json(),
      );
      expect(victimPage.messages.find((m) => m.id === victimMessageId)?.body, "别人群里那条一个字都不该变").toEqual(
        victimBody,
      );

      expect(
        pushes.filter(
          (p) =>
            (p.type === "message" ? p.message.id : p.type === "message_delta" ? p.messageId : null) === victimMessageId,
        ),
        "撞号那条不该推出任何东西",
      ).toEqual([]);

      const attackerPage = MessageListResponse.parse(
        await (await attackerClient.get(`/api/groups/${attackerBot.group.id}/messages`)).json(),
      );
      expect(
        attackerPage.messages.map((m) => m.id),
        "自己群里只该有后发那条，撞号那条整条丢掉",
      ).toEqual([ownMessageId]);
      expect(attackerPage.messages[0]?.body).toEqual({
        kind: "bot",
        botId: attackerBot.bot.id,
        text: "自己的正文",
        streaming: false,
      });
    } finally {
      agent.close();
      push.close();
    }
  });
});

function textOf(message: Message): string {
  return message.body.kind === "user" ? message.body.text : "";
}
