import { randomUUID } from "node:crypto";
import {
  CreateBotResponse,
  CreateGroupResponse,
  GroupListResponse,
  PokerTableResponse,
  type Bot,
  type ControlToAgent,
  type GroupId,
  type ServerPush,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { startTestServer, type ApiClient, type TestServer } from "./helpers/client.js";
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

type Owner = {
  readonly client: ApiClient;
  readonly agent: AgentClient;
  readonly push: PushClient;
  readonly ownerId: string;
  close(): void;
};

async function owner(): Promise<Owner> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  const push = await connectPush(server.server.port, client.cookie ?? "");
  return {
    client,
    agent,
    push,
    ownerId: user.id,
    close: () => {
      agent.close();
      push.close();
    },
  };
}

async function createBot(me: Owner, name: string): Promise<Bot> {
  return CreateBotResponse.parse(await (await me.client.post("/api/bots", { name })).json()).bot;
}

async function team(me: Owner): Promise<{ readonly groupId: GroupId; readonly bots: readonly [Bot, Bot] }> {
  const bots = [await createBot(me, "小一"), await createBot(me, "小二")] as const;
  const created = await me.client.post("/api/groups", { title: "双十一大促", botIds: bots.map((bot) => bot.id) });
  expect(created.status).toBe(201);
  return { groupId: CreateGroupResponse.parse(await created.json()).group.id, bots };
}

/** 建 Bot、建群都会再下发 config，跳过它们等指定类型的那条下行。 */
async function frame<T extends ControlToAgent["type"]>(
  agent: AgentClient,
  type: T,
): Promise<Extract<ControlToAgent, { type: T }>> {
  for (;;) {
    const next = await agent.next();
    if (next.type === type) return next as Extract<ControlToAgent, { type: T }>;
  }
}

/** 收推送直到 group_archived，返回这之前收到的全部。 */
async function pushesUntilArchived(push: PushClient, groupId: GroupId): Promise<ServerPush[]> {
  const seen: ServerPush[] = [];
  for (;;) {
    const next = await push.next();
    if (next.type === "group_archived" && next.groupId === groupId) return seen;
    seen.push(next);
  }
}

async function listedGroupIds(client: ApiClient): Promise<string[]> {
  const response = await client.get("/api/groups");
  expect(response.status).toBe(200);
  return GroupListResponse.parse(await response.json()).items.map((item) => item.group.id);
}

describe("解散群", () => {
  it("解散后群从列表消失，按 id 读、读写消息都 404，再解散一次仍是 204", async () => {
    const me = await owner();
    try {
      const { groupId } = await team(me);
      expect(await listedGroupIds(me.client)).toContain(groupId);

      expect((await me.client.post(`/api/groups/${groupId}/archive`)).status).toBe(204);
      await pushesUntilArchived(me.push, groupId);

      expect(await listedGroupIds(me.client)).not.toContain(groupId);
      expect((await me.client.get(`/api/groups/${groupId}`)).status).toBe(404);
      expect((await me.client.get(`/api/groups/${groupId}/messages`)).status).toBe(404);
      expect((await me.client.post(`/api/groups/${groupId}/messages`, { text: "还在吗" })).status).toBe(404);
      expect((await me.client.post(`/api/groups/${groupId}/archive`)).status).toBe(204);
    } finally {
      me.close();
    }
  });

  it("单聊不能解散，回 409 并说明原因，群照常可见", async () => {
    const me = await owner();
    try {
      const created = CreateBotResponse.parse(await (await me.client.post("/api/bots", { name: "小单" })).json());
      const response = await me.client.post(`/api/groups/${created.group.id}/archive`);
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toMatch(/单聊不能解散/);
      expect((await me.client.get(`/api/groups/${created.group.id}`)).status).toBe(200);
    } finally {
      me.close();
    }
  });

  it("别人的群解散不了，回 404", async () => {
    const mine = await owner();
    const theirs = await owner();
    try {
      const { groupId } = await team(mine);
      expect((await theirs.client.post(`/api/groups/${groupId}/archive`)).status).toBe(404);
      expect(await listedGroupIds(mine.client)).toContain(groupId);
    } finally {
      mine.close();
      theirs.close();
    }
  });

  it("正在跑的活被取消，挂着的审批变过期", async () => {
    const me = await owner();
    try {
      const { groupId, bots } = await team(me);
      expect((await me.client.post(`/api/groups/${groupId}/messages`, { text: "@小一 退款" })).status).toBe(201);
      const prompt = await frame(me.agent, "prompt");
      expect(prompt.botId).toBe(bots[0].id);

      me.agent.send({
        type: "approval_request",
        runId: prompt.runId,
        botId: bots[0].id,
        groupId,
        callId: "call-1",
        tool: "shop.refund",
        action: "spend",
        target: null,
        view: { kind: "mcp", server: "", tool: "shop.refund", params: [], raw: "给这单退 120 块" },
      });
      let pending: string | undefined;
      while (pending === undefined) {
        const next = await me.push.next();
        if (next.type === "approval_updated" && next.approval.status === "pending") pending = next.approval.id;
      }

      expect((await me.client.post(`/api/groups/${groupId}/archive`)).status).toBe(204);
      const before = await pushesUntilArchived(me.push, groupId);
      const expired = before.find((push) => push.type === "approval_updated" && push.approval.id === pending);
      expect(expired?.type === "approval_updated" && expired.approval.status).toBe("expired");

      const cancel = await frame(me.agent, "cancel");
      expect(cancel.lane).toEqual({ botId: bots[0].id, groupId });

      const runs = await database.sql<{ ended: boolean }[]>`
        SELECT ended_at IS NOT NULL AS ended FROM runs WHERE id = ${prompt.runId}`;
      expect(runs).toEqual([{ ended: true }]);
    } finally {
      me.close();
    }
  });

  it("牌桌解散时进行中的那手作废，牌桌读不到也不在列表里", async () => {
    const me = await owner();
    try {
      const created = await me.client.post("/api/poker/tables", { requestId: randomUUID() });
      expect(created.status).toBe(201);
      const groupId = PokerTableResponse.parse(await created.json()).table.groupId;
      expect((await me.client.post(`/api/poker/tables/${groupId}/hands`)).status).toBe(201);

      expect((await me.client.post(`/api/groups/${groupId}/archive`)).status).toBe(204);
      await pushesUntilArchived(me.push, groupId);

      expect((await me.client.get(`/api/poker/tables/${groupId}`)).status).toBe(404);
      expect((await me.client.post(`/api/poker/tables/${groupId}/hands`)).status).toBe(404);
      const list = (await (await me.client.get("/api/poker/tables")).json()) as { tables: { groupId: string }[] };
      expect(list.tables.map((entry) => entry.groupId)).not.toContain(groupId);
      expect(await listedGroupIds(me.client)).not.toContain(groupId);

      // 手和场次的结局对外读不到了，只能从库里看。
      const hands = await database.sql<
        { status: string }[]
      >`SELECT status FROM poker_hands WHERE group_id = ${groupId}`;
      expect(hands).toEqual([{ status: "abandoned" }]);
      const sessions = await database.sql<{ ended: boolean }[]>`
        SELECT ended_at IS NOT NULL AS ended FROM poker_sessions WHERE group_id = ${groupId}`;
      expect(sessions.every((row) => row.ended)).toBe(true);
      expect(sessions.length).toBeGreaterThan(0);
    } finally {
      me.close();
    }
  });
});
