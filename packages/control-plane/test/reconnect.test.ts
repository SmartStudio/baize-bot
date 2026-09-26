import { CreateBotResponse, MessageListResponse, type GroupId, type RunId, type ServerPush } from "@baize/shared";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { DEFAULT_RUNTIME_CONFIG, startServer, type RunningServer } from "../src/server.js";
import * as skillsRepo from "../src/repo/skills.js";
import { ApiClient, TEST_CREDENTIALS_KEY } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser } from "./helpers/fixtures.js";
import { helloAgent, openAgent, type AgentClient } from "./helpers/agent.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

let database: TestDb;
let server: RunningServer;

beforeAll(async () => {
  database = await createTestDb();
  server = await startServer({
    db: database.db,
    port: 0,
    config: DEFAULT_RUNTIME_CONFIG,
    credentialsKey: TEST_CREDENTIALS_KEY,
  });
});

afterAll(async () => {
  await server.close();
  await database.close();
});

async function ownerWithBot() {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = new ApiClient(server.port);
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小服" })).json());
  return { computer, client, groupId: created.group.id, botId: created.bot.id };
}

async function post(client: ApiClient, groupId: GroupId, text: string): Promise<void> {
  expect((await client.post(`/api/groups/${groupId}/messages`, { text })).status).toBe(201);
}

async function openRuns(groupId: GroupId): Promise<number> {
  const rows = await database.sql<{ n: string }[]>`
    SELECT count(*) AS n FROM runs WHERE group_id = ${groupId} AND ended_at IS NULL
  `;
  return Number(rows[0]?.n ?? "0");
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

it("重连握手里 config 还没发出时来的活不派给这条连接，config 发出之后才派", async () => {
  const owner = await ownerWithBot();
  const first = await helloAgent(server.port, owner.computer.computerId, owner.computer.token);
  first.agent.close();
  await first.agent.closed();

  let enterConfig!: () => void;
  const configEntered = new Promise<void>((resolve) => (enterConfig = resolve));
  let releaseConfig!: () => void;
  const configReleased = new Promise<void>((resolve) => (releaseConfig = resolve));
  const original = skillsRepo.listSkillsByOwner;
  let calls = 0;
  const spy = vi.spyOn(skillsRepo, "listSkillsByOwner").mockImplementation(async (db, ownerId) => {
    calls += 1;
    if (calls === 1) {
      enterConfig();
      await configReleased;
    }
    return original(db, ownerId);
  });

  let second: AgentClient | null = null;
  try {
    second = await openAgent(server.port);
    second.send({
      type: "hello",
      computerId: owner.computer.computerId,
      token: owner.computer.token,
      version: "test",
      activeRuns: [],
    });
    await second.expect("welcome");
    await configEntered;

    await post(owner.client, owner.groupId, "排一下本周");
    releaseConfig();

    const afterWelcome = await second.next();
    expect(afterWelcome.type, "config 发出之前这条连接不能收 prompt，代理那头还没有运行器，prompt 会被丢掉").toBe(
      "config",
    );
    expect(await openRuns(owner.groupId), "没派出去的活不能留一行永远 running 的 run").toBe(0);
    expect(await systemTexts(owner.client, owner.groupId), "群里要说一句为什么没派").toEqual([
      "电脑不在线，这条没派出去，电脑回来后再说一次",
    ]);

    const bots = afterWelcome.type === "config" ? afterWelcome.bots : [];
    for (const bot of bots) expect(await second.expect("resume")).toMatchObject({ botId: bot.id });
    await post(owner.client, owner.groupId, "再排一下");
    const prompt = await second.expect("prompt");
    expect(prompt.text, "config 发出之后这条连接照常接活").toBe("再排一下");
  } finally {
    releaseConfig();
    spy.mockRestore();
    second?.close();
  }
});

it("代理说某个 run 的 prompt 比 config 先到，控制面替它收尾：run 结束、群里一句、审批过期，重报不重复", async () => {
  const owner = await ownerWithBot();
  const { agent } = await helloAgent(server.port, owner.computer.computerId, owner.computer.token);
  const push = await connectPush(server.port, owner.client.cookie ?? "");
  try {
    await post(owner.client, owner.groupId, "做这件事");
    const { runId } = await agent.expect("prompt");
    agent.send({
      type: "approval_request",
      runId,
      botId: owner.botId,
      groupId: owner.groupId,
      callId: "early-approval",
      tool: "send_email",
      action: "message_person",
      target: null,
      view: { kind: "mcp", server: "", tool: "send_email", params: [], raw: "给客户发一封邮件" },
    });
    const created = await nextMatching(push, (event) => event.type === "approval_updated", " approval_updated");
    const approvalId = created.type === "approval_updated" ? created.approval.id : "";

    const early = {
      type: "agent_error",
      code: "prompt_before_config",
      detail: `run ${runId} 的 prompt 比 config 先到`,
      groupId: owner.groupId,
      runId,
    } as const;
    agent.send(early);
    await nextMatching(
      push,
      (event) =>
        event.type === "approval_updated" && event.approval.id === approvalId && event.approval.status === "expired",
      "审批过期",
    );
    expect(await openRuns(owner.groupId), "这个 run 在代理那头不会再跑，不能永远 running").toBe(0);

    agent.send(early);
    agent.send({ type: "agent_error", code: "unsupported", detail: "哨兵", groupId: owner.groupId });
    await nextMatching(
      push,
      (event) =>
        event.type === "message" && event.message.body.kind === "system" && event.message.body.text.includes("哨兵"),
      "哨兵那句",
    );
    const earlyNotes = (await systemTexts(owner.client, owner.groupId)).filter((text) =>
      text.includes("配置还没到就先接到了活"),
    );
    expect(earlyNotes, "同一个 run 报两次也只收尾一次、只说一句").toHaveLength(1);
  } finally {
    agent.close();
    push.close();
  }
});

it("agent_error 带的 runId 不是这台电脑的活，不收尾别人的 run", async () => {
  const victim = await ownerWithBot();
  const victimAgent = (await helloAgent(server.port, victim.computer.computerId, victim.computer.token)).agent;
  const other = await ownerWithBot();
  const otherAgent = (await helloAgent(server.port, other.computer.computerId, other.computer.token)).agent;
  const push = await connectPush(server.port, other.client.cookie ?? "");
  try {
    await post(victim.client, victim.groupId, "做这件事");
    const { runId } = await victimAgent.expect("prompt");
    const foreign: RunId = runId;

    otherAgent.send({
      type: "agent_error",
      code: "prompt_before_config",
      detail: "别人的 run",
      groupId: victim.groupId,
      runId: foreign,
    });
    otherAgent.send({ type: "agent_error", code: "unsupported", detail: "哨兵", groupId: other.groupId });
    await nextMatching(
      push,
      (event) =>
        event.type === "message" && event.message.body.kind === "system" && event.message.body.text.includes("哨兵"),
      "哨兵那句",
    );
    expect(await openRuns(victim.groupId), "别的电脑报的 runId 是外部输入，不能拿来收尾这台电脑的活").toBe(1);
  } finally {
    victimAgent.close();
    otherAgent.close();
    push.close();
  }
});

it("代理拒了 config：这台电脑不再接活，派出去的 run 按版本对不上收尾，推一条 stuck；代理收下下一条 config 后恢复", async () => {
  const owner = await ownerWithBot();
  const { agent } = await helloAgent(server.port, owner.computer.computerId, owner.computer.token);
  const push = await connectPush(server.port, owner.client.cookie ?? "");
  const MISMATCH = "电脑代理和控制面版本对不上，配置被拒";
  try {
    await post(owner.client, owner.groupId, "config 被拒之前派出去的活");
    const { runId } = await agent.expect("prompt");

    agent.send({
      type: "agent_error",
      code: "config_rejected",
      detail: "config 不合这个电脑代理的版本，校验不过的字段：accountsProxy",
    });
    const stuck = await nextMatching(push, (event) => event.type === "notify", " stuck 通知");
    expect(stuck.type === "notify" ? stuck.notice : null, "用户看到的是版本对不上，不是时序问题").toMatchObject({
      kind: "stuck",
      text: expect.stringContaining(MISMATCH),
    });

    agent.send({
      type: "agent_error",
      code: "prompt_before_config",
      detail: `run ${runId} 的 prompt 比 config 先到`,
      groupId: owner.groupId,
      runId,
    });
    await nextMatching(
      push,
      (event) =>
        event.type === "message" && event.message.body.kind === "system" && event.message.body.text.includes(MISMATCH),
      "按版本对不上收尾的那句",
    );
    expect(await openRuns(owner.groupId), "派出去的 run 收了尾").toBe(0);

    await post(owner.client, owner.groupId, "config 被拒之后的活");
    expect(await openRuns(owner.groupId), "被拒之后不再往这台电脑派活，也不留 running 的 run").toBe(0);
    expect(
      (await systemTexts(owner.client, owner.groupId)).at(-1),
      "被拒期间发的话，群里说的是配置被拒这个真实原因，不是电脑不在线",
    ).toContain("电脑拒收了配置");

    agent.send({ type: "config_applied", generation: 1 });
    await post(owner.client, owner.groupId, "收下新 config 之后的活");
    const resumed = await agent.expect("prompt");
    expect(resumed.text, "被拒期间那条没派出来，收下 config 之后照常接活").toBe("收下新 config 之后的活");

    const texts = await systemTexts(owner.client, owner.groupId);
    expect(
      texts.filter((text) => text.includes(MISMATCH)),
      "收尾那句说的是版本对不上",
    ).toHaveLength(1);
    expect(
      texts.some((text) => text.includes("配置还没到就先接到了活")),
      "不再误报成时序问题",
    ).toBe(false);
  } finally {
    agent.close();
    push.close();
  }
});
