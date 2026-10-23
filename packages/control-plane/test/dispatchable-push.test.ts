import { CreateBotResponse, type BotId, type ComputerId, type GroupId, type ServerPush } from "@baize/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG, startServer, type RunningServer } from "../src/server.js";
import { ApiClient, TEST_CREDENTIALS_KEY } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./helpers/fixtures.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DISCONNECT_NOTICE = "电脑断过线，这次活没做完";

let database: TestDb;
let server: RunningServer;

beforeAll(async () => {
  database = await createTestDb();
  server = await startServer({
    db: database.db,
    port: 0,
    config: DEFAULT_RUNTIME_CONFIG,
    credentialsKey: TEST_CREDENTIALS_KEY,
    toolSecretKey: "a".repeat(64),
    scheduler: { now: () => new Date(), intervalMs: DAY_MS },
    publisher: { intervalMs: DAY_MS },
    disconnectGraceMs: 200,
  });
});

afterAll(async () => {
  await server.close();
  await database.close();
});

type Owner = {
  readonly client: ApiClient;
  readonly push: PushClient;
  readonly local: TestComputer;
  readonly groupId: GroupId;
  readonly botId: BotId;
};

async function owner(): Promise<Owner> {
  const user = await makeUser(database.db);
  const local = await makeComputer(database.db, user.id);
  const client = new ApiClient(server.port);
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小运" })).json());
  const push = await connectPush(server.port, client.cookie ?? "");
  return { client, push, local, groupId: created.group.id, botId: created.bot.id };
}

type Reach = { readonly status: string; readonly dispatchable: boolean };

/** 读推送直到 stop 认出的那条，返回沿途这台电脑的每条 computer_updated。 */
async function reachUntil(push: PushClient, computerId: ComputerId, stop: (item: ServerPush) => boolean) {
  const seen: Reach[] = [];
  for (;;) {
    const item = await push.next();
    if (item.type === "computer_updated" && item.computer.id === computerId)
      seen.push({ status: item.computer.status, dispatchable: item.computer.dispatchable });
    if (stop(item)) return seen;
  }
}

function systemSays(text: string): (item: ServerPush) => boolean {
  return (item) =>
    item.type === "message" && item.message.body.kind === "system" && item.message.body.text.includes(text);
}

/** 同一条连接的上行报文串行处理：这句报错落群推到的时候，前面那几条报文的推送都已经推完。 */
function barrier(agent: AgentClient, o: Owner, detail: string): void {
  agent.send({ type: "agent_error", code: "runner_failed", groupId: o.groupId, detail });
}

it("代理拒了当前这一代 config 推一条不能派；同一代再拒一次状态没变不推；收下新的一代再推一条能派", async () => {
  const o = await owner();
  const { agent, config } = await helloAgent(server.port, o.local.computerId, o.local.token);
  try {
    expect(
      await reachUntil(o.push, o.local.computerId, (item) => item.type === "computer_updated"),
      "上线那条就是能派",
    ).toEqual([{ status: "online", dispatchable: true }]);

    const rejected = {
      type: "agent_error",
      code: "config_rejected",
      generation: config.generation,
      detail: "测试",
    } as const;
    agent.send(rejected);
    expect(
      await reachUntil(o.push, o.local.computerId, (item) => item.type === "notify" && item.notice.kind === "stuck"),
      "连接还在、库里还是在线，但拒了 config 就派不过去，网页的圆点要在 stuck 通知之前先灭",
    ).toEqual([{ status: "online", dispatchable: false }]);

    agent.send(rejected);
    barrier(agent, o, "再拒一次之后的屏障");
    expect(await reachUntil(o.push, o.local.computerId, systemSays("再拒一次之后的屏障")), "已经是拒收状态").toEqual(
      [],
    );

    expect((await o.client.patch(`/api/bots/${o.botId}`, { name: "小运二号" })).status).toBe(200);
    const next = await agent.expect("config");
    agent.send({ type: "config_applied", generation: next.generation });
    barrier(agent, o, "收下之后的屏障");
    expect(
      await reachUntil(o.push, o.local.computerId, systemSays("收下之后的屏障")),
      "被拒之后收下新的一代，又能派了",
    ).toEqual([{ status: "online", dispatchable: true }]);

    agent.send({ type: "config_applied", generation: next.generation });
    barrier(agent, o, "重复回执之后的屏障");
    expect(
      await reachUntil(o.push, o.local.computerId, systemSays("重复回执之后的屏障")),
      "本来就能派，重复回执不推",
    ).toEqual([]);
  } finally {
    agent.close();
    o.push.close();
  }
});

it("断线那一拍还在宽限期里能派，宽限到期再推一条不能派，排在断线收尾那句之前", async () => {
  const o = await owner();
  const { agent } = await helloAgent(server.port, o.local.computerId, o.local.token);
  try {
    await reachUntil(o.push, o.local.computerId, (item) => item.type === "computer_updated");
    expect((await o.client.post(`/api/groups/${o.groupId}/messages`, { text: "没做完的活" })).status).toBe(201);
    await agent.expect("prompt");

    agent.close();
    expect(
      await reachUntil(o.push, o.local.computerId, systemSays(DISCONNECT_NOTICE)),
      "宽限期里发出去的活还能补送，过了宽限才真的派不过去",
    ).toEqual([
      { status: "sleeping", dispatchable: true },
      { status: "sleeping", dispatchable: false },
    ]);
  } finally {
    o.push.close();
  }
});
