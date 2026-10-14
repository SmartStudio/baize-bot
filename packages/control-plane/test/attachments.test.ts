import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import {
  ATTACHMENT_MAX_BYTES,
  AttachmentMime,
  AttachmentUploadResponse,
  ComputerTokenResponse,
  CreateBotResponse,
  CreateGroupResponse,
  RegisterResponse,
  type BotId,
  type GroupId,
} from "@baize/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";

let database: TestDb;
let server: TestServer;
const agents: AgentClient[] = [];
const IMAGE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1EAAAAASUVORK5CYII=",
  "base64",
);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

beforeAll(async () => {
  database = await createTestDb();
  server = await startTestServer(database.db);
});

afterEach(() => {
  for (const agent of agents.splice(0)) agent.close();
});

afterAll(async () => {
  await server.close();
  await database.close();
});

async function owner() {
  const client = server.client();
  const registered = await client.post("/api/register", {
    name: "附件测试",
    email: `${randomUUID()}@baize.dev`,
    password: "baize-dev",
  });
  expect(registered.status).toBe(201);
  const { user } = RegisterResponse.parse(await registered.json());
  const paired = await client.post("/api/computers/local");
  expect(paired.status).toBe(200);
  const computer = ComputerTokenResponse.parse(await paired.json());
  const created = await client.post("/api/bots", { name: "配图员" });
  expect(created.status).toBe(201);
  const { bot, group } = CreateBotResponse.parse(await created.json());
  const { agent, config } = await helloAgent(server.server.port, computer.computerId, computer.token);
  agents.push(agent);
  return { user, client, computer, bot, group, agent, config };
}

type Owner = Awaited<ReturnType<typeof owner>>;

function upload(
  who: Owner,
  options: {
    readonly bytes?: Uint8Array;
    readonly mime?: string;
    readonly sha256?: string;
    readonly botId?: BotId;
    readonly groupId?: GroupId;
    readonly key?: string;
    readonly cookie?: string;
  } = {},
) {
  const bytes = options.bytes ?? IMAGE;
  const headers: Record<string, string> = {
    "content-type": options.mime ?? "image/png",
    "x-baize-sha256": options.sha256 ?? digest(bytes),
  };
  if (options.key !== "") headers["authorization"] = `Bearer ${options.key ?? who.config.modelGateway.apiKey}`;
  if (options.cookie !== undefined) headers["cookie"] = options.cookie;
  const query = new URLSearchParams({ botId: options.botId ?? who.bot.id, groupId: options.groupId ?? who.group.id });
  return fetch(`${who.config.hub.baseUrl}/attachments?${query}`, {
    method: "PUT",
    headers,
    body: new Uint8Array(bytes),
  });
}

function download(who: Owner, id: string, key = who.config.modelGateway.apiKey) {
  return fetch(`${who.config.hub.baseUrl}/attachments/${id}`, { headers: { authorization: `Bearer ${key}` } });
}

async function saved(who: Owner) {
  const response = await upload(who);
  expect(response.status).toBe(200);
  return AttachmentUploadResponse.parse(await response.json());
}

async function attachmentCount(ownerId: string) {
  const [row] = await database.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM attachments WHERE owner_id = ${ownerId}
  `;
  return row?.n;
}

describe("控制面附件", () => {
  it("config 给出 /hub/v1；成功保存原始字节，串行和并发重复上传都回同一个 id", async () => {
    const who = await owner();
    expect(who.config.hub.baseUrl).toBe(`${who.client.origin}/hub/v1`);
    const first = await saved(who);
    const responses = await Promise.all([upload(who), upload(who), upload(who)]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(AttachmentUploadResponse.parse(await response.json())).toEqual(first);
    }
    expect(first.sha256).toBe(digest(IMAGE));
    const rows = await database.sql<{ mime: string; size: number; bytes: Buffer }[]>`
      SELECT mime, size, bytes FROM attachments WHERE owner_id = ${who.user.id}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.mime).toBe("image/png");
    expect(rows[0]?.size).toBe(IMAGE.length);
    expect(rows[0]?.bytes).toEqual(IMAGE);
    const fetched = await download(who, first.attachmentId);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await fetched.arrayBuffer())).toEqual(IMAGE);
  });

  it.each(AttachmentMime.options)("允许 %s 并按上传时的 MIME 返回", async (mime) => {
    const who = await owner();
    const response = await upload(who, { mime });
    expect(response.status).toBe(200);
    const { attachmentId } = AttachmentUploadResponse.parse(await response.json());
    expect((await download(who, attachmentId)).headers.get("content-type")).toBe(mime);
  });

  it("相同内容在不同 Bot 或群分别存储", async () => {
    const who = await owner();
    const first = await saved(who);
    const created = await who.client.post("/api/bots", { name: "另一位配图员" });
    const secondBot = CreateBotResponse.parse(await created.json());
    const groupResponse = await who.client.post("/api/groups", {
      title: "配图项目",
      botIds: [who.bot.id, secondBot.bot.id],
    });
    expect(groupResponse.status).toBe(201);
    const { group } = CreateGroupResponse.parse(await groupResponse.json());
    const second = AttachmentUploadResponse.parse(await (await upload(who, { groupId: group.id })).json());
    const third = AttachmentUploadResponse.parse(
      await (await upload(who, { botId: secondBot.bot.id, groupId: group.id })).json(),
    );
    expect(new Set([first.attachmentId, second.attachmentId, third.attachmentId]).size).toBe(3);
    expect(await attachmentCount(who.user.id)).toBe(3);
  });

  it("声明哈希不匹配或格式不对回 400，附件不落库", async () => {
    const who = await owner();
    for (const sha256 of ["0".repeat(64), "not-a-hash"]) {
      expect((await upload(who, { sha256 })).status).toBe(400);
    }
    expect(await attachmentCount(who.user.id)).toBe(0);
  });

  it("恰好 20 MiB 可上传，多一个字节回 413，超限内容不落库", async () => {
    const who = await owner();
    const bytes = Buffer.alloc(ATTACHMENT_MAX_BYTES);
    expect((await upload(who, { bytes })).status).toBe(200);
    expect((await upload(who, { bytes: Buffer.alloc(ATTACHMENT_MAX_BYTES + 1) })).status).toBe(413);
    expect(await attachmentCount(who.user.id)).toBe(1);
  });

  it("没有 Content-Length 的分块请求在超限时立即回 413，不等请求体结束", async () => {
    const who = await owner();
    const query = new URLSearchParams({ botId: who.bot.id, groupId: who.group.id });
    let req: ReturnType<typeof request>;
    const response = new Promise<number>((resolve, reject) => {
      req = request(
        `${who.config.hub.baseUrl}/attachments?${query}`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${who.config.modelGateway.apiKey}`,
            "content-type": "image/png",
            "x-baize-sha256": "0".repeat(64),
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
    });
    try {
      const chunk = Buffer.alloc(1024 * 1024);
      for (let sent = 0; sent < ATTACHMENT_MAX_BYTES; sent += chunk.length) {
        if (!req!.write(chunk)) await once(req!, "drain");
      }
      req!.write(Buffer.from([1]));
      expect(await response).toBe(413);
      expect(req!.writableEnded, "服务器在客户端结束上传前就拒绝超限请求").toBe(false);
      expect(await attachmentCount(who.user.id)).toBe(0);
    } finally {
      req!.destroy();
    }
  });

  it("非白名单的 Content-Type 回 415", async () => {
    const who = await owner();
    expect((await upload(who, { mime: "image/svg+xml" })).status).toBe(415);
    expect(await attachmentCount(who.user.id)).toBe(0);
  });

  it("别人的 Bot 回 404", async () => {
    const who = await owner();
    const other = await owner();
    expect((await upload(who, { botId: other.bot.id, groupId: other.group.id })).status).toBe(404);
    expect(await attachmentCount(who.user.id)).toBe(0);
  });

  it("同一归属人的 Bot 不在指定群回 404", async () => {
    const who = await owner();
    const created = await who.client.post("/api/bots", { name: "不在群里的 Bot" });
    const { bot } = CreateBotResponse.parse(await created.json());
    expect((await upload(who, { botId: bot.id })).status).toBe(404);
    expect(await attachmentCount(who.user.id)).toBe(0);
  });

  it("没有 Bearer 回 401", async () => {
    const who = await owner();
    expect((await upload(who, { key: "" })).status).toBe(401);
    expect(await attachmentCount(who.user.id)).toBe(0);
  });

  it("cookie 登录会话不能替代 Bearer，上传和下载都回 401", async () => {
    const who = await owner();
    const attachment = await saved(who);
    expect(who.client.cookie).not.toBeNull();
    expect((await upload(who, { key: "", cookie: who.client.cookie! })).status).toBe(401);
    expect((await who.client.get(`/hub/v1/attachments/${attachment.attachmentId}`)).status).toBe(401);
  });

  it("同一归属人的远程电脑可读取本机上传的附件", async () => {
    const who = await owner();
    const attachment = await saved(who);
    const paired = await who.client.post("/api/computers/remote");
    expect(paired.status).toBe(200);
    const computer = ComputerTokenResponse.parse(await paired.json());
    const remote = await helloAgent(server.server.port, computer.computerId, computer.token);
    agents.push(remote.agent);
    expect(remote.welcome.kind).toBe("remote");
    const response = await download(who, attachment.attachmentId, remote.config.modelGateway.apiKey);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(IMAGE);
  });

  it("别人的附件、不存在的 id 和非法 id 均回 404", async () => {
    const who = await owner();
    const other = await owner();
    const attachment = await saved(who);
    for (const id of [attachment.attachmentId, randomUUID(), "bad-id"]) {
      expect((await download(other, id)).status).toBe(404);
    }
  });

  it("hello 轮换网关 key 后旧 key 上传下载都拒绝，新 key 仍可用", async () => {
    const who = await owner();
    const attachment = await saved(who);
    const replacement = await helloAgent(server.server.port, who.computer.computerId, who.computer.token);
    agents.push(replacement.agent);
    expect(replacement.config.modelGateway.apiKey).not.toBe(who.config.modelGateway.apiKey);
    expect((await upload(who)).status).toBe(401);
    expect((await download(who, attachment.attachmentId)).status).toBe(401);
    expect((await download(who, attachment.attachmentId, replacement.config.modelGateway.apiKey)).status).toBe(200);
    expect((await upload(who, { key: replacement.config.modelGateway.apiKey })).status).toBe(200);
  });

  it("删 Bot 后它的单聊群和按 Bot、群归属的附件都级联消失", async () => {
    const who = await owner();
    const attachment = await saved(who);
    expect((await who.client.delete(`/api/bots/${who.bot.id}`)).status).toBe(204);
    const [row] = await database.sql<{ bots: number; groups: number; attachments: number }[]>`
      SELECT
        (SELECT count(*)::int FROM bots WHERE id = ${who.bot.id}) AS bots,
        (SELECT count(*)::int FROM groups WHERE id = ${who.group.id}) AS groups,
        (SELECT count(*)::int FROM attachments WHERE bot_id = ${who.bot.id} OR group_id = ${who.group.id}) AS attachments
    `;
    expect(row).toEqual({ bots: 0, groups: 0, attachments: 0 });
    expect((await download(who, attachment.attachmentId)).status).toBe(404);
  });

  it("删 Bot 时团队群仍在，属于这个 Bot 的附件单独级联删除", async () => {
    const who = await owner();
    const created = await who.client.post("/api/bots", { name: "留在群里的 Bot" });
    const { bot } = CreateBotResponse.parse(await created.json());
    const grouped = await who.client.post("/api/groups", { title: "保留的团队群", botIds: [who.bot.id, bot.id] });
    expect(grouped.status).toBe(201);
    const { group } = CreateGroupResponse.parse(await grouped.json());
    expect((await upload(who, { groupId: group.id })).status).toBe(200);
    expect((await who.client.delete(`/api/bots/${who.bot.id}`)).status).toBe(204);
    expect((await who.client.get(`/api/groups/${group.id}`)).status).toBe(200);
    const [row] = await database.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM attachments WHERE bot_id = ${who.bot.id} OR group_id = ${group.id}
    `;
    expect(row?.n).toBe(0);
  });

  it("删账号后附件一并删除", async () => {
    const who = await owner();
    await saved(who);
    expect((await who.client.request("DELETE", "/api/me", { email: who.user.email })).status).toBe(204);
    expect(await attachmentCount(who.user.id)).toBe(0);
  });

  it("迁移创建 bytea 列、三个 ON DELETE CASCADE 外键和内容唯一索引", async () => {
    const fks = await database.sql<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid = 'attachments'::regclass AND contype = 'f'
    `;
    expect(fks.map((row) => row.definition).toSorted()).toEqual([
      "FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE",
      "FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE",
      "FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE",
    ]);
    const [column] = await database.sql<{ data_type: string }[]>`
      SELECT data_type FROM information_schema.columns WHERE table_name = 'attachments' AND column_name = 'bytes'
    `;
    expect(column?.data_type).toBe("bytea");
    const [index] = await database.sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'attachments_owner_bot_group_sha256_idx'
    `;
    expect(index?.indexdef).toContain("UNIQUE INDEX");
    expect(index?.indexdef).toContain("(owner_id, bot_id, group_id, sha256)");
  });
});
