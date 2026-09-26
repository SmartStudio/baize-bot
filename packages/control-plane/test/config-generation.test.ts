import { AccountResponse, CreateBotResponse, MessageListResponse, type GroupId, type ServerPush } from "@baize/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startTestServer, type ApiClient, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser } from "./helpers/fixtures.js";
import { gatedDb } from "./helpers/gated-db.js";
import { helloAgent } from "./helpers/agent.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

let database: TestDb;
let gated: ReturnType<typeof gatedDb>;
let server: TestServer;

beforeAll(async () => {
  database = await createTestDb();
  gated = gatedDb(database.sql);
  server = await startTestServer(gated.db);
});

afterAll(async () => {
  await server.close();
  await database.close();
});

async function ownerWithBot() {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小服" })).json());
  const account = AccountResponse.parse(
    await (await client.post("/api/accounts", { platform: "xiaohongshu", computerId: computer.computerId })).json(),
  ).account;
  return { computer, client, groupId: created.group.id, botId: created.bot.id, account };
}

async function systemTexts(client: ApiClient, groupId: GroupId): Promise<string[]> {
  const page = MessageListResponse.parse(await (await client.get(`/api/groups/${groupId}/messages`)).json());
  return page.messages.flatMap((message) => (message.body.kind === "system" ? [message.body.text] : []));
}

async function nextMatching(push: PushClient, match: (event: ServerPush) => boolean, what: string) {
  for (let seen = 0; seen < 20; seen += 1) {
    const event = await push.next();
    if (match(event)) return event;
  }
  throw new Error(`等了 20 条推送都没有${what}`);
}

it("config 带每台电脑单调递增的代际：hello 是 1，之后每次重发加一", async () => {
  const owner = await ownerWithBot();
  const { agent, config } = await helloAgent(server.server.port, owner.computer.computerId, owner.computer.token);
  try {
    expect(config.generation, "握手那条 config 从 1 起").toBe(1);
    expect((await owner.client.patch(`/api/accounts/${owner.account.id}`, { tier: "draft" })).status).toBe(200);
    expect((await agent.expect("config")).generation).toBe(2);
    expect((await owner.client.patch(`/api/bots/${owner.botId}`, { name: "小服二号" })).status).toBe(200);
    expect((await agent.expect("config")).generation).toBe(3);

    const again = await helloAgent(server.server.port, owner.computer.computerId, owner.computer.token);
    try {
      expect(again.config.generation, "代际按连接算，重连从 1 重新起").toBe(1);
    } finally {
      again.agent.close();
    }
  } finally {
    agent.close();
  }
});

it("两次 sendConfig 并发时，先开始读快照的那条代际小；晚发出的旧快照代际也小，代理据此丢掉它", async () => {
  const owner = await ownerWithBot();
  const { agent } = await helloAgent(server.server.port, owner.computer.computerId, owner.computer.token);
  try {
    // 改 Bot 名触发的重发停在最后一步 listBots 之前，这时它已经读过账号，档位还是旧的。
    const gate = gated.arm(/from "bots" inner join "groups"/);
    const renaming = owner.client.patch(`/api/bots/${owner.botId}`, { name: "小服二号" });
    await gate.reached;
    expect((await owner.client.patch(`/api/accounts/${owner.account.id}`, { tier: "draft" })).status).toBe(200);
    const fresh = await agent.expect("config");
    gate.release();
    expect((await renaming).status).toBe(200);
    const stale = await agent.expect("config");

    expect(fresh.accounts.find((one) => one.id === owner.account.id)?.tier, "先到的是新档位").toBe("draft");
    expect(stale.accounts.find((one) => one.id === owner.account.id)?.tier, "后到的是改档之前读的旧档位").toBe(
      "confirm_publish",
    );
    expect(
      [fresh.generation, stale.generation],
      "代际按开始读快照的先后编号：晚到的旧快照代际更小，电脑代理才能认出它是旧的",
    ).toEqual([3, 2]);
  } finally {
    agent.close();
  }
});

it("config 被拒后，旧代际的 config_applied 不能把电脑恢复成在线；只认当前那一代的回执", async () => {
  const owner = await ownerWithBot();
  const { agent, config } = await helloAgent(server.server.port, owner.computer.computerId, owner.computer.token);
  const push = await connectPush(server.server.port, owner.client.cookie ?? "");
  try {
    expect(config.generation).toBe(1);
    expect((await owner.client.patch(`/api/accounts/${owner.account.id}`, { tier: "draft" })).status).toBe(200);
    const second = await agent.expect("config");
    expect(second.generation).toBe(2);

    agent.send({
      type: "agent_error",
      code: "config_rejected",
      generation: second.generation,
      detail: "config 不合这个电脑代理的版本，校验不过的字段：accountsProxy",
    });
    await nextMatching(push, (event) => event.type === "notify" && event.notice.kind === "stuck", " stuck 通知");

    // 第一代的回执在网络上晚到：它确认的是被拒之前那份，不能当成新 config 收下了。
    agent.send({ type: "config_applied", generation: 1 });
    expect((await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "旧回执之后的活" })).status).toBe(
      201,
    );
    await nextMatching(
      push,
      (event) => event.type === "message" && event.message.body.kind === "system",
      "派不出去的那句系统话",
    );
    const texts = await systemTexts(owner.client, owner.groupId);
    expect(texts.at(-1), "旧代际的回执不算数，这台电脑仍是拒收状态，群里说清是配置被拒").toContain("电脑拒收了配置");

    agent.send({ type: "config_applied", generation: 2 });
    expect(
      (await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "对上代际之后的活" })).status,
    ).toBe(201);
    expect((await agent.expect("prompt")).text, "当前那一代的回执才让电脑恢复接活").toBe("对上代际之后的活");
  } finally {
    agent.close();
    push.close();
  }
});

async function eventsUntilBarrier(push: PushClient, barrier: string): Promise<ServerPush[]> {
  const seen: ServerPush[] = [];
  for (let count = 0; count < 20; count += 1) {
    const event = await push.next();
    seen.push(event);
    if (event.type === "message" && event.message.body.kind === "system" && event.message.body.text.includes(barrier))
      return seen;
  }
  throw new Error(`等了 20 条推送都没有屏障「${barrier}」`);
}

function stuckCount(events: ServerPush[]): number {
  return events.filter((event) => event.type === "notify" && event.notice.kind === "stuck").length;
}

it("新代际的回执到了之后，旧代际的拒收和不带代际的拒收都被忽略：不卡派活、不发通知；之后当前代际真拒收恰好通知一次", async () => {
  const owner = await ownerWithBot();
  const { agent } = await helloAgent(server.server.port, owner.computer.computerId, owner.computer.token);
  const push = await connectPush(server.server.port, owner.client.cookie ?? "");
  try {
    expect((await owner.client.patch(`/api/accounts/${owner.account.id}`, { tier: "draft" })).status).toBe(200);
    const second = await agent.expect("config");
    expect((await owner.client.patch(`/api/bots/${owner.botId}`, { name: "小服三号" })).status).toBe(200);
    const third = await agent.expect("config");
    agent.send({ type: "config_applied", generation: third.generation });
    agent.send({
      type: "agent_error",
      code: "config_rejected",
      generation: second.generation,
      detail: "晚到的旧快照不合版本",
    });
    // 不带代际的拒收是旧代理的报文。这条连接上已经有带代际的回执，它说的不可能是当前这一代。
    agent.send({ type: "agent_error", code: "config_rejected", detail: "不带代际的拒收" });
    // 同一条连接的报文串行处理，后发的报错落群时，前面两条拒收的副作用都已经推完。
    agent.send({ type: "agent_error", code: "runner_failed", groupId: owner.groupId, detail: "忽略拒收之后的屏障" });
    expect(stuckCount(await eventsUntilBarrier(push, "忽略拒收之后的屏障")), "被忽略的拒收不该告诉用户活派不出去").toBe(
      0,
    );

    expect((await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "旧拒收之后的活" })).status).toBe(
      201,
    );
    expect((await agent.expect("prompt", 1000)).text, "被忽略的拒收不覆盖已经应用的第三代").toBe("旧拒收之后的活");

    agent.send({
      type: "agent_error",
      code: "config_rejected",
      generation: third.generation,
      detail: "当前这一代确实不合版本",
    });
    agent.send({ type: "agent_error", code: "runner_failed", groupId: owner.groupId, detail: "真拒收之后的屏障" });
    expect(
      stuckCount(await eventsUntilBarrier(push, "真拒收之后的屏障")),
      "当前代际的拒收是真卡住，通知不能被前面忽略的拒收吞掉",
    ).toBe(1);
  } finally {
    agent.close();
    push.close();
  }
});
