import {
  BotListResponse,
  GroupListResponse,
  GroupResponse,
  MessageListResponse,
  POKER_PERSONAS,
  PokerTableResponse,
  type GroupId,
  type PokerPersona,
  type PokerTableView,
  type UserId,
} from "@baize/shared";
import { and, count, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bots, groupMembers, groups, pokerTables } from "../src/db/schema.js";
import { helloAgent } from "./helpers/agent.js";
import { startTestServer, type ApiClient, type TestServer } from "./helpers/client.js";
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

async function owner() {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  return { user, computer, client };
}

async function createTable(client: ApiClient, requestId: string): Promise<{ status: number; table: PokerTableView }> {
  const response = await client.post("/api/poker/tables", { requestId });
  return { status: response.status, table: PokerTableResponse.parse(await response.json()).table };
}

const personaAt = (table: PokerTableView, seat: number) => table.seats.find((entry) => entry.seat === seat)?.persona;
const botIdAt = (table: PokerTableView, seat: number) => table.seats.find((entry) => entry.seat === seat)?.botId;

async function presetBotId(ownerId: UserId, persona: PokerPersona): Promise<string> {
  const [row] = await database.db
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.ownerId, ownerId), eq(bots.preset, persona)));
  if (row === undefined) throw new Error(`${persona} 没建出来`);
  return row.id;
}

async function memberIds(groupId: GroupId): Promise<string[]> {
  const rows = await database.db
    .select({ botId: groupMembers.botId, position: groupMembers.position })
    .from(groupMembers)
    .where(eq(groupMembers.groupId, groupId))
    .orderBy(groupMembers.position);
  return rows.map((row) => row.botId);
}

describe("建桌", () => {
  it("建桌后群里是三个牌友加老白，用户在 4 号位，老白是首席", async () => {
    const { user, client } = await owner();

    const { status, table } = await createTable(client, "req-1");

    expect(status).toBe(201);
    expect(table.seats.map((seat) => seat.seat)).toEqual([1, 2, 3, 4]);
    expect(
      table.seats.map((seat) => seat.engineSeatId),
      "座位号到引擎座位 id 的对照由控制面给",
    ).toEqual(["1", "2", "3", "4"]);
    expect(table.reviewState, "还没散过场就没有复盘状态").toBeNull();
    expect([1, 2, 3].map((seat) => personaAt(table, seat))).toEqual(["leopard", "old_k", "jasmine"]);
    const you = table.seats.find((seat) => seat.seat === 4);
    expect(you).toMatchObject({ kind: "user", botId: null, persona: null, name: user.name });
    expect(
      table.seats.map((seat) => seat.stack),
      "每人起始 2000",
    ).toEqual([2000, 2000, 2000, 2000]);
    expect(table.status).toBe("idle");
    expect(table.hand).toBeNull();
    expect(table.host.name).toBe(POKER_PERSONAS.laobai.name);

    const detail = GroupResponse.parse(await (await client.get(`/api/groups/${table.groupId}`)).json());
    expect(detail.task.title).toBe("周末德州");
    expect(detail.bots.map((bot) => bot.name)).toEqual(["阿豹", "老K", "茉莉", "老白"]);
    expect(detail.group.kind === "team" ? detail.group.chiefBotId : null, "老白是首席").toBe(table.host.botId);

    const [row] = await database.db.select().from(pokerTables).where(eq(pokerTables.groupId, table.groupId));
    expect(row).toMatchObject({ ownerId: user.id, smallBlind: 10, bigBlind: 20, startingStack: 2000, status: "idle" });
  });

  it("同一个 requestId 点两次只建一张桌，第二次回同一张", async () => {
    const { user, client } = await owner();

    const first = await createTable(client, "same-request");
    const second = await createTable(client, "same-request");

    expect(second.status).toBe(200);
    expect(second.table.groupId).toBe(first.table.groupId);
    const [tables] = await database.db.select({ n: count() }).from(pokerTables).where(eq(pokerTables.ownerId, user.id));
    expect(tables?.n).toBe(1);
    const [teamGroups] = await database.db.select({ n: count() }).from(groups).where(eq(groups.ownerId, user.id));
    expect(teamGroups?.n, "主助理单聊加六个预置单聊加这一个牌桌群，第二次没有再多建群").toBe(1 + 6 + 1);
  });

  it("同一个 requestId 同时到两次也只建一张桌", async () => {
    const { user, client } = await owner();

    const [a, b] = await Promise.all([createTable(client, "racing"), createTable(client, "racing")]);

    expect(a.table.groupId).toBe(b.table.groupId);
    expect([a.status, b.status].toSorted()).toEqual([200, 201]);
    const [tables] = await database.db.select({ n: count() }).from(pokerTables).where(eq(pokerTables.ownerId, user.id));
    expect(tables?.n).toBe(1);
  });

  it("换一个 requestId 就是另一张桌，预置牌友还是同一套", async () => {
    const { user, client } = await owner();

    const first = await createTable(client, "one");
    const second = await createTable(client, "two");

    expect(second.table.groupId).not.toBe(first.table.groupId);
    expect(botIdAt(second.table, 1)).toBe(botIdAt(first.table, 1));
    const presets = await database.db
      .select({ id: bots.id })
      .from(bots)
      .where(and(eq(bots.ownerId, user.id), isNotNull(bots.preset)));
    expect(presets, "每个用户一套").toHaveLength(6);
  });

  it("建桌前后 GET /api/bots 都不含牌友", async () => {
    const { client } = await owner();
    const names = async () =>
      BotListResponse.parse(await (await client.get("/api/bots")).json()).items.map((item) => item.bot.name);

    const before = await names();
    await createTable(client, "bots-list");

    expect(before).toEqual(["主助理"]);
    expect(await names()).toEqual(["主助理"]);
  });

  it("建桌后侧栏群列表里没有预置牌友的单聊群，只有牌桌群", async () => {
    const { user, client } = await owner();
    const { table } = await createTable(client, "sidebar");

    const listed = GroupListResponse.parse(await (await client.get("/api/groups")).json());

    expect(listed.items.map((entry) => entry.group.id)).toEqual([table.groupId]);
    const presetSolo = await database.db
      .select({ id: groups.id })
      .from(groups)
      .innerJoin(bots, eq(bots.id, groups.soloBotId))
      .where(and(eq(groups.ownerId, user.id), isNotNull(bots.preset)));
    expect(presetSolo, "六个单聊群确实建出来了，只是不进侧栏").toHaveLength(6);
  });

  it("建桌把牌友和老白送进在线代理的 config", async () => {
    const { computer, client } = await owner();
    const { agent, config } = await helloAgent(server.server.port, computer.computerId, computer.token);
    try {
      expect(
        config.bots.filter((bot) => bot.preset !== null),
        "建桌之前 config 里没有牌友",
      ).toHaveLength(0);

      await createTable(client, "config-push");
      const changed = await agent.expect("config");
      expect(changed.bots.filter((bot) => bot.preset !== null).map((bot) => bot.name)).toHaveLength(6);
    } finally {
      agent.close();
    }
  });

  it("建桌给自己推 group_created 和 poker_table_updated", async () => {
    const { client } = await owner();
    const push = await connectPush(server.server.port, client.cookie ?? "");
    try {
      const { table } = await createTable(client, "push-create");
      const seen = new Map<string, unknown>();
      while (!seen.has("group_created") || !seen.has("poker_table_updated")) {
        const next = await push.next();
        seen.set(next.type, next);
      }
      const updated = seen.get("poker_table_updated") as { table: PokerTableView };
      expect(updated.table.groupId).toBe(table.groupId);
      expect(updated.table.version).toBe(table.version);
    } finally {
      push.close();
    }
  });
});

describe("看桌", () => {
  it("没登录先 401", async () => {
    const anonymous = server.client();
    expect((await anonymous.post("/api/poker/tables", { requestId: "x" })).status).toBe(401);
    expect((await anonymous.get("/api/poker/tables")).status).toBe(401);
    expect((await anonymous.get("/api/poker/tables/g-any")).status).toBe(401);
    expect((await anonymous.post("/api/poker/tables/g-any/seats/2", { persona: "dalu" })).status).toBe(401);
  });

  it("GET 单张桌和创建时的视图一致，列表里有这张桌", async () => {
    const { client } = await owner();
    const { table } = await createTable(client, "read");

    const one = PokerTableResponse.parse(await (await client.get(`/api/poker/tables/${table.groupId}`)).json());
    const list = (await (await client.get("/api/poker/tables")).json()) as { tables: PokerTableView[] };

    expect(one.table).toEqual(table);
    expect(list.tables.map((entry) => entry.groupId)).toEqual([table.groupId]);
  });

  it("别人的桌子查不到、换不了，也不进别人的列表", async () => {
    const mine = await owner();
    const theirs = await owner();
    const { table } = await createTable(mine.client, "private");

    expect((await theirs.client.get(`/api/poker/tables/${table.groupId}`)).status).toBe(404);
    expect((await theirs.client.post(`/api/poker/tables/${table.groupId}/seats/3`, { persona: "dalu" })).status).toBe(
      404,
    );
    const list = (await (await theirs.client.get("/api/poker/tables")).json()) as { tables: PokerTableView[] };
    expect(list.tables).toEqual([]);
    const after = PokerTableResponse.parse(await (await mine.client.get(`/api/poker/tables/${table.groupId}`)).json());
    expect(personaAt(after.table, 3), "没被别人换掉").toBe("jasmine");
  });
});

describe("赛前换人", () => {
  it("换人只改那个座位，其余座位的 Bot 不变，版本加一", async () => {
    const { user, client } = await owner();
    const { table } = await createTable(client, "swap-one");

    const response = await client.post(`/api/poker/tables/${table.groupId}/seats/3`, { persona: "dalu" });

    expect(response.status).toBe(200);
    const swapped = PokerTableResponse.parse(await response.json()).table;
    expect(swapped.seats.map((seat) => seat.persona)).toEqual(["leopard", "old_k", "dalu", null]);
    expect(botIdAt(swapped, 3)).toBe(await presetBotId(user.id, "dalu"));
    for (const seat of [1, 2, 4]) expect(botIdAt(swapped, seat), `${seat} 号位不变`).toBe(botIdAt(table, seat));
    expect(swapped.host).toEqual(table.host);
    expect(swapped.version).toBe(table.version + 1);
    const read = PokerTableResponse.parse(await (await client.get(`/api/poker/tables/${table.groupId}`)).json());
    expect(read.table, "库里也换了").toEqual(swapped);
  });

  it("换人后群成员里旧牌友没了，新牌友在原位置，老白还在末尾", async () => {
    const { user, client } = await owner();
    const { table } = await createTable(client, "swap-members");
    const before = await memberIds(table.groupId);

    await client.post(`/api/poker/tables/${table.groupId}/seats/2`, { persona: "xiaoqi" });

    const after = await memberIds(table.groupId);
    const newcomer = await presetBotId(user.id, "xiaoqi");
    expect(before[1]).toBe(botIdAt(table, 2));
    expect(after).toEqual([before[0], newcomer, before[2], before[3]]);
    expect(after).not.toContain(before[1]);
  });

  it("换上已在桌上的牌友回 400，桌子不变", async () => {
    const { client } = await owner();
    const { table } = await createTable(client, "swap-dup");

    const response = await client.post(`/api/poker/tables/${table.groupId}/seats/3`, { persona: "leopard" });

    expect(response.status).toBe(400);
    const read = PokerTableResponse.parse(await (await client.get(`/api/poker/tables/${table.groupId}`)).json());
    expect(read.table).toEqual(table);
  });

  it("老白不能上桌，你自己的 4 号位不能换，座位号不合法都回 400", async () => {
    const { client } = await owner();
    const { table } = await createTable(client, "swap-bad");
    const swap = (seat: string, body: unknown) => client.post(`/api/poker/tables/${table.groupId}/seats/${seat}`, body);

    expect((await swap("3", { persona: "laobai" })).status, "老白不入座").toBe(400);
    expect((await swap("4", { persona: "dalu" })).status, "4 号位是你自己").toBe(400);
    expect((await swap("9", { persona: "dalu" })).status).toBe(400);
    expect((await swap("x", { persona: "dalu" })).status).toBe(400);
    expect((await swap("3", {})).status).toBe(400);
  });

  it("换人后座位筹码沿用，不重置也不带走", async () => {
    const { client } = await owner();
    const { table } = await createTable(client, "swap-stack");
    await database.db
      .update(pokerTables)
      .set({
        seats: [
          { seat: 1, botId: botIdAt(table, 1) ?? null, stack: 2000 },
          { seat: 2, botId: botIdAt(table, 2) ?? null, stack: 2000 },
          { seat: 3, botId: botIdAt(table, 3) ?? null, stack: 1350 },
          { seat: 4, botId: null, stack: 2650 },
        ],
      })
      .where(eq(pokerTables.groupId, table.groupId));

    const response = await client.post(`/api/poker/tables/${table.groupId}/seats/3`, { persona: "dalu" });

    const swapped = PokerTableResponse.parse(await response.json()).table;
    expect(swapped.seats.map((seat) => seat.stack)).toEqual([2000, 2000, 1350, 2650]);
  });

  it("换人不在群里留话", async () => {
    const { client } = await owner();
    const { table } = await createTable(client, "swap-message");
    const before = MessageListResponse.parse(await (await client.get(`/api/groups/${table.groupId}/messages`)).json());

    expect((await client.post(`/api/poker/tables/${table.groupId}/seats/3`, { persona: "dalu" })).status).toBe(200);

    const after = MessageListResponse.parse(await (await client.get(`/api/groups/${table.groupId}/messages`)).json());
    expect(after.messages).toEqual(before.messages);
  });

  it("换人给自己推 group_updated 和 poker_table_updated", async () => {
    const { client } = await owner();
    const { table } = await createTable(client, "swap-push");
    const push = await connectPush(server.server.port, client.cookie ?? "");
    try {
      await client.post(`/api/poker/tables/${table.groupId}/seats/1`, { persona: "xiaoqi" });
      const types = new Set<string>();
      let updated: PokerTableView | null = null;
      while (!(types.has("group_updated") && updated !== null)) {
        const next = await push.next();
        types.add(next.type);
        if (next.type === "poker_table_updated") updated = next.table;
      }
      expect(updated).not.toBeNull();
      expect((updated as unknown as PokerTableView).seats[0]?.persona).toBe("xiaoqi");
    } finally {
      push.close();
    }
  });

  it("手进行中换人回 409，桌子不变；手打完回 idle 才能换", async () => {
    const { client } = await owner();
    const { table } = await createTable(client, "swap-in-hand");
    await database.db.update(pokerTables).set({ status: "in_hand" }).where(eq(pokerTables.groupId, table.groupId));

    const refused = await client.post(`/api/poker/tables/${table.groupId}/seats/3`, { persona: "dalu" });

    expect(refused.status).toBe(409);
    expect(await memberIds(table.groupId), "成员没动").toEqual(
      [1, 2, 3].map((seat) => botIdAt(table, seat) as string).concat(table.host.botId),
    );
    const read = PokerTableResponse.parse(await (await client.get(`/api/poker/tables/${table.groupId}`)).json());
    expect(read.table.status).toBe("in_hand");
    expect(personaAt(read.table, 3)).toBe("jasmine");

    await database.db.update(pokerTables).set({ status: "idle" }).where(eq(pokerTables.groupId, table.groupId));
    expect((await client.post(`/api/poker/tables/${table.groupId}/seats/3`, { persona: "dalu" })).status).toBe(200);
  });

  it("同时换同一个座位只成一次，另一个因为座位上已经不是原来的人而被挡下", async () => {
    const { client } = await owner();
    const { table } = await createTable(client, "swap-race");
    const swap = (persona: string) => client.post(`/api/poker/tables/${table.groupId}/seats/3`, { persona });

    const results = await Promise.all([swap("dalu"), swap("dalu")]);

    expect(results.map((r) => r.status).toSorted(), "第二个撞上「已在桌上」").toEqual([200, 400]);
    const [row] = await database.db.select().from(pokerTables).where(eq(pokerTables.groupId, table.groupId));
    expect(row?.version).toBe(1);
  });
});
