import {
  CliToolListResponse,
  CliToolResponse,
  CreateBotResponse,
  type BotId,
  type CliTool,
  type ControlToAgent,
} from "@baize/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cliToolEnv } from "../src/db/schema.js";
import { ensureComputer } from "../src/repo/computers.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./helpers/fixtures.js";

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

const KEY = "xai-0123456789abcdefWXYZ";
const NEW_KEY = "xai-fedcba9876543210QRST";

type Owner = {
  readonly client: ApiClient;
  readonly botId: BotId;
  readonly local: TestComputer;
  readonly remote: TestComputer;
};

async function owner(): Promise<Owner> {
  const user = await makeUser(database.db);
  const local = await makeComputer(database.db, user.id);
  const made = await ensureComputer(database.db, user.id, "remote");
  if (made.token === null) throw new Error("拿不到远程电脑的 token");
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const response = await client.post("/api/bots", { name: "小服" });
  expect(response.status).toBe(201);
  return {
    client,
    botId: CreateBotResponse.parse(await response.json()).bot.id,
    local,
    remote: { computerId: made.computer.id, token: made.token },
  };
}

const grok = (overrides: Record<string, unknown> = {}) => ({
  command: "grok",
  install: { manager: "npm", package: "@vibe-kit/grok-cli" },
  env: [{ name: "GROK_API_KEY", value: KEY }],
  computers: ["remote"],
  bots: null,
  ...overrides,
});

async function create(client: ApiClient, body: unknown): Promise<CliTool> {
  const response = await client.post("/api/cli-tools", body);
  expect(response.status).toBe(201);
  return CliToolResponse.parse(await response.json()).tool;
}

async function list(client: ApiClient): Promise<{ raw: string; items: CliTool[] }> {
  const response = await client.get("/api/cli-tools");
  expect(response.status).toBe(200);
  const raw = await response.text();
  return { raw, items: CliToolListResponse.parse(JSON.parse(raw)).items };
}

/** 读到下一条 config；建 Bot 之类别的改动也会插进来 config，所以按条件挑。 */
async function nextConfig(
  agent: AgentClient,
  accept: (config: Extract<ControlToAgent, { type: "config" }>) => boolean,
): Promise<Extract<ControlToAgent, { type: "config" }>> {
  for (let seen = 0; seen < 20; seen += 1) {
    const one = await agent.next();
    if (one.type === "config" && accept(one)) return one;
  }
  throw new Error("一直没收到想要的 config");
}

describe("命令行工具", () => {
  it("建好之后列表只有变量名和末四位，库里存的是密文，值不出现在任何响应里", async () => {
    const { client } = await owner();
    const createdResponse = await client.post("/api/cli-tools", grok());
    expect(createdResponse.status).toBe(201);
    const createdRaw = await createdResponse.text();
    expect(createdRaw, "建的响应里不能有值").not.toContain(KEY);
    const created = CliToolResponse.parse(JSON.parse(createdRaw)).tool;
    expect(created).toMatchObject({
      command: "grok",
      install: { manager: "npm", package: "@vibe-kit/grok-cli" },
      env: [{ name: "GROK_API_KEY", last4: "WXYZ" }],
      computers: ["remote"],
      bots: null,
    });

    const { raw, items } = await list(client);
    expect(raw, "列表里不能有值").not.toContain(KEY);
    expect(items).toEqual([created]);

    const [stored] = await database.db.select().from(cliToolEnv).where(eq(cliToolEnv.toolId, created.id));
    expect(stored?.valueEnc.startsWith("v1:"), "值按 seal 的格式加密存").toBe(true);
    expect(stored?.valueEnc).not.toContain(KEY);
  });

  it("不足 8 位的值不给末四位", async () => {
    const { client } = await owner();
    const tool = await create(client, grok({ env: [{ name: "GROK_API_KEY", value: "short12" }] }));
    expect(tool.env).toEqual([{ name: "GROK_API_KEY", last4: "" }]);
  });

  it("同一个命令登记第二次回 409", async () => {
    const { client } = await owner();
    await create(client, grok());
    const again = await client.post("/api/cli-tools", grok());
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "这个命令已经登记过了，去改原来那条" });
    expect((await list(client)).items).toHaveLength(1);
  });

  it("保留变量名、保留命令名、坏的装包名都回 400，什么都不建", async () => {
    const { client } = await owner();
    for (const body of [
      grok({ env: [{ name: "PATH", value: KEY }] }),
      grok({ env: [{ name: "LD_PRELOAD", value: KEY }] }),
      grok({ env: [{ name: "lower_case", value: KEY }] }),
      grok({ command: "bash" }),
      grok({ command: "python3" }),
      grok({ install: { manager: "npm", package: "x; rm -rf /" } }),
      grok({ computers: [] }),
    ]) {
      const response = await client.post("/api/cli-tools", body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect((await list(client)).items).toEqual([]);
  });

  it("改值换末四位，删变量，改装包、电脑、Bot；同一个变量既改又删回 400", async () => {
    const { client, botId } = await owner();
    const tool = await create(
      client,
      grok({
        env: [
          { name: "GROK_API_KEY", value: KEY },
          { name: "GROK_BASE_URL", value: "https://api.x.ai/v1" },
        ],
      }),
    );

    const both = await client.patch(`/api/cli-tools/${tool.id}`, {
      set: [{ name: "GROK_API_KEY", value: NEW_KEY }],
      remove: ["GROK_API_KEY"],
    });
    expect(both.status).toBe(400);

    const response = await client.patch(`/api/cli-tools/${tool.id}`, {
      set: [{ name: "GROK_API_KEY", value: NEW_KEY }],
      remove: ["GROK_BASE_URL"],
      install: null,
      computers: ["local", "remote"],
      bots: [botId],
    });
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain(NEW_KEY);
    expect(CliToolResponse.parse(JSON.parse(raw)).tool).toMatchObject({
      env: [{ name: "GROK_API_KEY", last4: "QRST" }],
      install: null,
      computers: ["local", "remote"],
      bots: [botId],
    });

    const untouched = await client.patch(`/api/cli-tools/${tool.id}`, { bots: null });
    expect(CliToolResponse.parse(await untouched.json()).tool).toMatchObject({
      env: [{ name: "GROK_API_KEY", last4: "QRST" }],
      bots: null,
    });
  });

  it("一个工具最多 10 个变量，超了整次改动不落", async () => {
    const { client } = await owner();
    const env = Array.from({ length: 10 }, (_, index) => ({ name: `KEY_${index}`, value: KEY }));
    const tool = await create(client, grok({ env }));
    const response = await client.patch(`/api/cli-tools/${tool.id}`, {
      set: [{ name: "KEY_EXTRA", value: KEY }],
      computers: ["local"],
    });
    expect(response.status).toBe(400);
    const [after] = (await list(client)).items;
    expect(after?.env).toHaveLength(10);
    expect(after?.computers).toEqual(["remote"]);
  });

  it("别人的工具看不到、改不了、删不掉，也不能把工具给别人的 Bot", async () => {
    const mine = await owner();
    const theirs = await owner();
    const tool = await create(mine.client, grok());

    expect((await list(theirs.client)).items).toEqual([]);
    expect((await theirs.client.patch(`/api/cli-tools/${tool.id}`, { bots: null })).status).toBe(404);
    expect((await theirs.client.request("DELETE", `/api/cli-tools/${tool.id}`)).status).toBe(404);

    const foreignBot = await mine.client.patch(`/api/cli-tools/${tool.id}`, { bots: [theirs.botId] });
    expect(foreignBot.status).toBe(400);
    const foreignCreate = await mine.client.post("/api/cli-tools", grok({ command: "grok2", bots: [theirs.botId] }));
    expect(foreignCreate.status).toBe(400);
    expect((await list(mine.client)).items.map((one) => one.command)).toEqual(["grok"]);
  });

  it("config 按电脑种类筛，值解密下发；改值、删除之后两台电脑都收到新的 config", async () => {
    const { client, botId, local, remote } = await owner();
    const localHello = await helloAgent(server.server.port, local.computerId, local.token);
    const remoteHello = await helloAgent(server.server.port, remote.computerId, remote.token);
    expect(localHello.config.cliTools, "没登记时也带空数组").toEqual([]);
    expect(remoteHello.config.cliTools).toEqual([]);
    const localAgent = localHello.agent;
    const remoteAgent = remoteHello.agent;

    try {
      const tool = await create(client, grok({ bots: [botId] }));
      const remoteConfig = await nextConfig(remoteAgent, (config) => config.cliTools.length > 0);
      expect(remoteConfig.cliTools).toEqual([
        {
          id: tool.id,
          command: "grok",
          install: { manager: "npm", package: "@vibe-kit/grok-cli" },
          env: [{ name: "GROK_API_KEY", value: KEY }],
          bots: [botId],
        },
      ]);
      const localConfig = await nextConfig(localAgent, () => true);
      expect(localConfig.cliTools, "只登记了云电脑，本机拿不到").toEqual([]);

      await client.patch(`/api/cli-tools/${tool.id}`, {
        set: [{ name: "GROK_API_KEY", value: NEW_KEY }],
        computers: ["local"],
        bots: null,
      });
      const movedLocal = await nextConfig(localAgent, () => true);
      expect(movedLocal.cliTools).toEqual([
        {
          id: tool.id,
          command: "grok",
          install: { manager: "npm", package: "@vibe-kit/grok-cli" },
          env: [{ name: "GROK_API_KEY", value: NEW_KEY }],
          bots: null,
        },
      ]);
      expect((await nextConfig(remoteAgent, () => true)).cliTools, "改到本机后云电脑收回").toEqual([]);

      expect((await client.request("DELETE", `/api/cli-tools/${tool.id}`)).status).toBe(204);
      expect((await nextConfig(localAgent, () => true)).cliTools).toEqual([]);
      expect((await list(client)).items).toEqual([]);
    } finally {
      localAgent.close();
      remoteAgent.close();
    }
  });
});
