import { BotResponse, CreateBotResponse, type BotId, type ControlToAgent } from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureComputer } from "../src/repo/computers.js";
import * as toolsRepo from "../src/repo/tools.js";
import { helloAgent, openAgent, sendHello } from "./helpers/agent.js";
import { startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser } from "./helpers/fixtures.js";

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

describe("hello 握手", () => {
  it("暂停落在 hello 查工具、skill 的途中：补发按落库之后的状态，不按更早的快照", async () => {
    const user = await makeUser(database.db);
    const computer = await makeComputer(database.db, user.id);
    const client = server.client();
    expect((await client.login(user.email, PASSWORD)).status).toBe(200);
    const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小服" })).json());

    // 把 hello 卡在 sendConfig 的第一批查询里。listBots 若是在这一批之前查的，暂停之后补发的还是 resume。
    const original = toolsRepo.listToolConfigs;
    let reached!: () => void;
    const atGate = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const spy = vi.spyOn(toolsRepo, "listToolConfigs").mockImplementation(async (...args) => {
      reached();
      await gate;
      return original(...args);
    });
    const agent = await openAgent(server.server.port);
    try {
      sendHello(agent, computer.computerId, computer.token);
      await agent.expect("welcome");
      await atGate;

      const paused = await client.post(`/api/bots/${created.bot.id}/pause`);
      expect(BotResponse.parse(await paused.json()).bot.runState).toBe("paused");
      release();

      const downlinks: ControlToAgent[] = [];
      for (let next = await agent.next(); ; next = await agent.next()) {
        downlinks.push(next);
        if (next.type === "config") break;
      }
      const config = downlinks.at(-1);
      if (config?.type !== "config") throw new Error("没等到 config");
      for (let index = 0; index < config.bots.length; index += 1) downlinks.push(await agent.next());

      const lastStateOf = (botId: BotId) =>
        downlinks.findLast((item) => (item.type === "pause" || item.type === "resume") && item.botId === botId)?.type;
      expect(
        lastStateOf(created.bot.id),
        `暂停之后 config 跟着的补发要和库一致，实际下行顺序是 ${downlinks.map((item) => item.type).join("、")}`,
      ).toBe("pause");
    } finally {
      spy.mockRestore();
      release();
      agent.close();
    }
  });

  it("hello 补建主助理：这个用户已在线的另一台电脑收到带主助理的新 config", async () => {
    const user = await makeUser(database.db);
    const local = await makeComputer(database.db, user.id);
    const ensured = await ensureComputer(database.db, user.id, "remote");
    if (ensured.token === null) throw new Error("远程电脑应当是新建的");
    const remoteToken = ensured.token;

    const first = await helloAgent(server.server.port, local.computerId, local.token);
    try {
      expect(
        first.config.bots.map((bot) => bot.role),
        "本机先连时主助理已在",
      ).toEqual(["assistant"]);
      // 删掉主助理行造出老用户：本机已经连着，不会再走一次登录。
      await database.sql`DELETE FROM bots WHERE owner_id = ${user.id} AND role = 'assistant'`;

      const second = await helloAgent(server.server.port, ensured.computer.id, remoteToken);
      try {
        expect(
          second.config.bots.map((bot) => bot.role),
          "新连上来的这台自己的 config 就带主助理",
        ).toEqual(["assistant"]);
        const refreshed = await first.agent.expect("config");
        expect(
          refreshed.bots.map((bot) => bot.id),
          "补建发生在别的电脑的 hello 里，已在线的这台只能靠这次重发才认识主助理",
        ).toEqual(second.config.bots.map((bot) => bot.id));
        expect(refreshed.generation, "是本机这条连接的第二代 config").toBe(first.config.generation + 1);
      } finally {
        second.agent.close();
      }
    } finally {
      first.agent.close();
    }
  });
});
