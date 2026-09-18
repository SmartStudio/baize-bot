import { ApiError, CreateBotResponse, MessageListResponse, SendMessageResponse, type Message } from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    for (const text of ["一", "二", "三", "四", "五"]) {
      await client.post(`/api/groups/${groupId}/messages`, { text });
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
    expect(page).toEqual({ messages: [], hasMore: false });
  });
});

describe("别人的群", () => {
  it("读和写都返回 404", async () => {
    const { client, groupId } = await clientWithGroup();
    await client.post(`/api/groups/${groupId}/messages`, { text: "私密" });

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

function textOf(message: Message): string {
  return message.body.kind === "user" ? message.body.text : "";
}
