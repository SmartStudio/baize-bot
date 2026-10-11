import { BotListResponse, POKER_PERSONAS, PokerPersona, type UserId } from "@baize/shared";
import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { helloAgent } from "./helpers/agent.js";
import { startTestServer, type ApiClient, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser } from "./helpers/fixtures.js";
import { connectPush } from "./helpers/ws.js";
import { bots, groups } from "../src/db/schema.js";
import { ensurePokerPresets } from "../src/repo/poker-presets.js";

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

async function ownerWithComputer() {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  return { user, computer, client };
}

async function listedBotNames(client: ApiClient): Promise<string[]> {
  const { items } = BotListResponse.parse(await (await client.get("/api/bots")).json());
  return items.map((item) => item.bot.name);
}

async function presetRows(ownerId: UserId) {
  return database.db
    .select()
    .from(bots)
    .where(and(eq(bots.ownerId, ownerId), isNotNull(bots.preset)));
}

const PRESET_NAMES = new Set(Object.values(POKER_PERSONAS).map((card) => card.name));

describe("牌友和老白的预置", () => {
  it("建桌前用户的 Bot 列表里没有牌友，只有他自己建的队员", async () => {
    const { user, client } = await ownerWithComputer();
    await client.post("/api/bots", { name: "小服" });

    expect(await listedBotNames(client), "登录时主助理已经在").toEqual(["主助理", "小服"]);
    expect(await presetRows(user.id), "建桌之前库里还没有预置").toEqual([]);
  });

  it("ensure 两次只有一套：第一次建出六位，第二次不再建，每位各一个单聊群", async () => {
    const { user } = await ownerWithComputer();

    const first = await ensurePokerPresets(database.db, user.id);
    const second = await ensurePokerPresets(database.db, user.id);

    expect(first.toSorted()).toEqual([...PokerPersona.options].toSorted());
    expect(second, "第二次没有新建的").toEqual([]);

    const rows = await presetRows(user.id);
    expect(rows.map((row) => row.preset).toSorted()).toEqual([...PokerPersona.options].toSorted());

    const solo = await database.db
      .select({ soloBotId: groups.soloBotId })
      .from(groups)
      .where(eq(groups.ownerId, user.id));
    const soloIds = new Set(solo.map((row) => row.soloBotId));
    for (const row of rows) expect(soloIds.has(row.id), `${row.preset} 必须有单聊群，否则进不了 config`).toBe(true);
  });

  it("GET /api/bots 不含 player 和 host，但库里确实有，过滤只在 HTTP 这一层", async () => {
    const { user, client } = await ownerWithComputer();
    await client.post("/api/bots", { name: "小服" });
    await ensurePokerPresets(database.db, user.id);

    const roles = (await presetRows(user.id)).map((row) => row.role);
    expect(roles.toSorted(), "库里六位在").toEqual(["host", "player", "player", "player", "player", "player"]);
    expect(await listedBotNames(client), "列表里只剩主助理和用户自己的队员").toEqual(["主助理", "小服"]);
  });

  it("config 里带全部预置牌友，role 和 preset 对得上，名字和色相取自人设表", async () => {
    const { user, computer } = await ownerWithComputer();
    await ensurePokerPresets(database.db, user.id);

    const { agent, config } = await helloAgent(server.server.port, computer.computerId, computer.token);
    try {
      const presets = config.bots.filter((bot) => bot.preset !== null);
      expect(presets, "六位都进 config").toHaveLength(6);
      for (const bot of presets) {
        const preset = PokerPersona.parse(bot.preset);
        expect(bot.role).toBe(preset === "laobai" ? "host" : "player");
        expect(bot.name).toBe(POKER_PERSONAS[preset].name);
        expect(bot.tags).toEqual([...POKER_PERSONAS[preset].tags]);
      }
      expect(config.bots.filter((bot) => PRESET_NAMES.has(bot.name))).toHaveLength(6);
    } finally {
      agent.close();
    }
  });

  it("预置牌友建出来时不推 bot_created，之后一条确定会落地的 bot_updated 先到", async () => {
    const { user, client } = await ownerWithComputer();
    const created = await client.post("/api/bots", { name: "小服" });
    const botId = (await created.json()).bot.id as string;

    const push = await connectPush(server.server.port, client.cookie ?? "");
    try {
      await ensurePokerPresets(database.db, user.id);
      expect((await client.patch(`/api/bots/${botId}`, { name: "小服二号" })).status).toBe(200);

      const next = await push.next();
      expect(next.type, "预置建出来时不推 bot_created，第一条应是改名的 bot_updated").toBe("bot_updated");
    } finally {
      push.close();
    }
  });

  it("删预置牌友被拒，库里还在", async () => {
    const { user, client } = await ownerWithComputer();
    await ensurePokerPresets(database.db, user.id);
    const rows = await presetRows(user.id);
    const player = rows.find((row) => row.preset === "leopard");
    const host = rows.find((row) => row.preset === "laobai");
    expect(player).toBeDefined();
    expect(host).toBeDefined();

    expect((await client.delete(`/api/bots/${player?.id}`)).status, "删牌友按不存在回 404").toBe(404);
    expect((await client.delete(`/api/bots/${host?.id}`)).status, "删老白按不存在回 404").toBe(404);
    expect(await presetRows(user.id), "两位都还在").toHaveLength(6);
  });

  it("改预置牌友被拒回 409，名字不变", async () => {
    const { user, client } = await ownerWithComputer();
    await ensurePokerPresets(database.db, user.id);
    const rows = await presetRows(user.id);
    const player = rows.find((row) => row.preset === "jasmine");
    const host = rows.find((row) => row.preset === "laobai");

    const renamed = await client.patch(`/api/bots/${player?.id}`, { name: "茉莉改名" });
    expect(renamed.status).toBe(409);
    expect((await client.patch(`/api/bots/${host?.id}`, { name: "老白改名" })).status).toBe(409);

    const after = await presetRows(user.id);
    expect(after.find((row) => row.preset === "jasmine")?.name).toBe(POKER_PERSONAS.jasmine.name);
    expect(after.find((row) => row.preset === "laobai")?.name).toBe(POKER_PERSONAS.laobai.name);
  });
});
