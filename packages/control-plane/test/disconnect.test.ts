import {
  ComputerListResponse,
  ComputerTokenResponse,
  CreateBotResponse,
  CreateGroupResponse,
  MessageListResponse,
  type Bot,
  type GroupId,
  type RunId,
} from "@baize/shared";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { DEFAULT_RUNTIME_CONFIG, startServer, type RunningServer } from "../src/server.js";
import * as runsRepo from "../src/repo/runs.js";
import { ApiClient, TEST_CREDENTIALS_KEY } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, waitFor, type TestComputer } from "./helpers/fixtures.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { queueHello } from "./helpers/queued-hello.js";
import { connectPush } from "./helpers/ws.js";

const notice = "电脑断过线，这次活没做完";
const graceMs = 200;
let database: TestDb;
let server: RunningServer;

beforeAll(async () => {
  database = await createTestDb();
  server = await startServer({
    db: database.db,
    port: 0,
    config: DEFAULT_RUNTIME_CONFIG,
    credentialsKey: TEST_CREDENTIALS_KEY,
    disconnectGraceMs: graceMs,
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

async function ownerWithTeam(): Promise<{
  computer: TestComputer;
  client: ApiClient;
  groupId: GroupId;
  sales: Bot;
  service: Bot;
}> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = new ApiClient(server.port);
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const sales = CreateBotResponse.parse(
    await (await client.post("/api/bots", { name: "小销", tag: "销售" })).json(),
  ).bot;
  const service = CreateBotResponse.parse(
    await (await client.post("/api/bots", { name: "小服", tag: "客服" })).json(),
  ).bot;
  const group = CreateGroupResponse.parse(
    await (await client.post("/api/groups", { title: "双十一大促", botIds: [sales.id, service.id] })).json(),
  ).group;
  return { computer, client, groupId: group.id, sales, service };
}

async function connect(computer: TestComputer, activeRuns: readonly RunId[] = []): Promise<AgentClient> {
  return (await helloAgent(server.port, computer.computerId, computer.token, activeRuns)).agent;
}

async function startRun(client: ApiClient, groupId: GroupId, agent: AgentClient): Promise<RunId> {
  expect((await client.post(`/api/groups/${groupId}/messages`, { text: "做这件事" })).status).toBe(201);
  const prompt = await agent.expect("prompt");
  return prompt.runId;
}

async function ended(runId: RunId): Promise<boolean> {
  const rows = await database.sql<{ ended_at: string | null }[]>`SELECT ended_at FROM runs WHERE id = ${runId}`;
  const row = rows[0];
  return row !== undefined && row.ended_at !== null;
}

async function notices(client: ApiClient, groupId: GroupId): Promise<number> {
  const page = MessageListResponse.parse(await (await client.get(`/api/groups/${groupId}/messages`)).json());
  return page.messages.filter((message) => message.body.kind === "system" && message.body.text === notice).length;
}

it("hello 只收尾 activeRuns 之外的 run，并推送失败消息", async () => {
  const owner = await ownerWithBot();
  const first = await connect(owner.computer);
  const push = await connectPush(server.port, owner.client.cookie ?? "");
  try {
    const alive = await startRun(owner.client, owner.groupId, first);
    const missing = await startRun(owner.client, owner.groupId, first);
    const second = await connect(owner.computer, [alive]);
    try {
      expect(await first.closed()).toBe(4000);
      await waitFor(() => ended(missing), "丢失的 run 收尾");
      expect(await ended(alive), "hello 报活着的 run 不能收尾").toBe(false);
      expect(await notices(owner.client, owner.groupId)).toBe(1);
      const received: string[] = [];
      while (received.length < 1) {
        const event = await push.next();
        if (event.type === "message" && event.message.body.kind === "system") {
          expect(event.message.body.tone).toBe("error");
          received.push(event.message.body.text);
        }
      }
      expect(received).toEqual([notice]);
    } finally {
      second.close();
    }
  } finally {
    first.close();
    push.close();
  }
});

it("宽限到期且电脑未重连时收尾", async () => {
  const owner = await ownerWithBot();
  const agent = await connect(owner.computer);
  const runId = await startRun(owner.client, owner.groupId, agent);
  agent.close();
  await agent.closed();
  await waitFor(() => ended(runId), "宽限到期后 run 收尾");
  expect(await notices(owner.client, owner.groupId)).toBe(1);
});

it("本机断线只收尾本机的 run", async () => {
  const owner = await ownerWithBot();
  const second = CreateBotResponse.parse(await (await owner.client.post("/api/bots", { name: "小销" })).json());
  const remoteResponse = await owner.client.post("/api/computers/remote");
  expect(remoteResponse.status).toBe(200);
  const remoteToken = ComputerTokenResponse.parse(await remoteResponse.json());
  const remote = { computerId: remoteToken.computerId, token: remoteToken.token };
  const localAgent = await connect(owner.computer);
  const remoteAgent = await connect(remote);

  try {
    const localRun = await startRun(owner.client, owner.groupId, localAgent);
    localAgent.close();
    await localAgent.closed();
    await waitFor(async () => {
      const rows = await database.sql<{ status: string }[]>`
        SELECT status FROM computers WHERE id = ${owner.computer.computerId}
      `;
      return rows[0]?.status === "sleeping";
    }, "本机变休眠");

    const remoteRun = await startRun(owner.client, second.group.id, remoteAgent);
    await waitFor(() => ended(localRun), "本机 run 收尾");
    expect(await ended(remoteRun), "远程电脑的 run 不能跟着本机收尾").toBe(false);
  } finally {
    localAgent.close();
    remoteAgent.close();
  }
});

it("电脑断线收尾后，挂着的审批变成已失效", async () => {
  const owner = await ownerWithBot();
  const agent = await connect(owner.computer);
  const push = await connectPush(server.port, owner.client.cookie ?? "");
  try {
    const runId = await startRun(owner.client, owner.groupId, agent);
    expect((await push.next()).type).toBe("message");
    agent.send({
      type: "approval_request",
      runId,
      botId: owner.botId,
      groupId: owner.groupId,
      callId: "disconnect-approval",
      tool: "send_email",
      action: "message_person",
      target: null,
      view: { kind: "mcp", server: "", tool: "send_email", params: [], raw: "给客户发一封邮件" },
    });
    const created = await push.next();
    expect(created.type).toBe("approval_updated");
    const approvalId = created.type === "approval_updated" ? created.approval.id : "";
    expect(created.type === "approval_updated" ? created.approval.status : null).toBe("pending");
    expect((await push.next()).type).toBe("message");

    agent.close();
    await agent.closed();

    let expired = false;
    while (!expired) {
      const event = await push.next();
      expired =
        event.type === "approval_updated" && event.approval.id === approvalId && event.approval.status === "expired";
    }
    await waitFor(() => ended(runId), "宽限到期后 run 收尾");

    const page = MessageListResponse.parse(
      await (await owner.client.get(`/api/groups/${owner.groupId}/messages`)).json(),
    );
    expect(page.approvals).toMatchObject([{ id: approvalId, status: "expired" }]);
  } finally {
    agent.close();
    push.close();
  }
});

it("电脑断线后，这次运行里还在跑的工具行变成 failed 并推送", async () => {
  const owner = await ownerWithBot();
  const agent = await connect(owner.computer);
  const push = await connectPush(server.port, owner.client.cookie ?? "");
  try {
    const runId = await startRun(owner.client, owner.groupId, agent);
    expect((await push.next()).type).toBe("message");
    agent.send({
      type: "bot_tool_call",
      runId,
      botId: owner.botId,
      groupId: owner.groupId,
      callId: "disconnect-tool",
      tool: "send_email",
      view: {
        kind: "mcp",
        server: "邮件服务",
        tool: "send_email",
        params: [{ key: "to", value: "customer@example.com" }],
      },
      status: "running",
      durationMs: null,
    });
    const running = await push.next();
    expect(running.type === "message" ? running.message.body : null).toMatchObject({
      kind: "tool_call",
      status: "running",
    });

    agent.close();
    await agent.closed();

    let failedMessageId: string | null = null;
    for (let at = 0; at < 3 && failedMessageId === null; at += 1) {
      const event = await push.next(1500);
      if (event.type === "message" && event.message.body.kind === "tool_call") {
        expect(event.message.body).toMatchObject({ runId, status: "failed" });
        failedMessageId = event.message.id;
      }
    }
    expect(failedMessageId, "断线收尾应推送变成 failed 的同一条工具消息").not.toBeNull();
    await waitFor(() => ended(runId), "宽限到期后 run 收尾");

    const page = MessageListResponse.parse(
      await (await owner.client.get(`/api/groups/${owner.groupId}/messages`)).json(),
    );
    const tool = page.messages.find((message) => message.id === failedMessageId);
    expect(tool?.body).toMatchObject({ kind: "tool_call", runId, status: "failed" });
  } finally {
    agent.close();
    push.close();
  }
});

it("计时器收尾进行时 hello 对账仍保留 activeRuns", async () => {
  const owner = await ownerWithBot();
  const first = await connect(owner.computer);
  const push = await connectPush(server.port, owner.client.cookie ?? "");
  const originalOpenRunsForComputer = runsRepo.openRunsForComputer;
  let releaseTimerRead!: () => void;
  const timerReadBlocked = new Promise<void>((resolve) => {
    releaseTimerRead = resolve;
  });
  let timerReadStarted!: () => void;
  const timerReadEntered = new Promise<void>((resolve) => {
    timerReadStarted = resolve;
  });
  let openRunsCalls = 0;
  const openRunsSpy = vi.spyOn(runsRepo, "openRunsForComputer").mockImplementation(async (db, computerId) => {
    openRunsCalls += 1;
    if (openRunsCalls === 1) {
      timerReadStarted();
      await timerReadBlocked;
    }
    return originalOpenRunsForComputer(db, computerId);
  });

  try {
    const active = await startRun(owner.client, owner.groupId, first);
    const missing = await startRun(owner.client, owner.groupId, first);
    first.close();
    await first.closed();
    await timerReadEntered;
    // 新连接的 hello 排在计时器收尾后面；收尾读完 run 之后要看到这条排着的 hello，不动它报活着的 run。
    const second = await queueHello(server.port, owner.computer.computerId, owner.computer.token, [active]);
    releaseTimerRead();
    await second.expect("welcome");
    await second.expect("config");

    try {
      await waitFor(() => ended(missing), "hello 对账收尾不在列表里的 run");
      expect(await ended(active), "hello 报活着的 run 不能被计时器收尾").toBe(false);
      expect(await notices(owner.client, owner.groupId)).toBe(1);
      const received: string[] = [];
      while (received.length < 1) {
        const event = await push.next();
        if (event.type === "message" && event.message.body.kind === "system") received.push(event.message.body.text);
      }
      expect(received).toEqual([notice]);
    } finally {
      second.close();
    }
  } finally {
    openRunsSpy.mockRestore();
    first.close();
    push.close();
  }
});

it("宽限到期前重连并报告活着的 run，不收尾", async () => {
  const owner = await ownerWithBot();
  const first = await connect(owner.computer);
  const runId = await startRun(owner.client, owner.groupId, first);
  first.close();
  await first.closed();
  const second = await connect(owner.computer, [runId]);
  try {
    await new Promise((resolve) => setTimeout(resolve, graceMs + 80));
    expect(await ended(runId)).toBe(false);
    expect(await notices(owner.client, owner.groupId)).toBe(0);
    expect(
      ComputerListResponse.parse(await (await owner.client.get("/api/computers")).json()).computers[0]?.status,
    ).toBe("online");
  } finally {
    second.close();
  }
});

it("被顶掉的旧连接关闭不启动收尾", async () => {
  const owner = await ownerWithBot();
  const first = await connect(owner.computer);
  const runId = await startRun(owner.client, owner.groupId, first);
  const second = await connect(owner.computer, [runId]);
  try {
    expect(await first.closed()).toBe(4000);
    await new Promise((resolve) => setTimeout(resolve, graceMs + 80));
    expect(await ended(runId)).toBe(false);
    expect(await notices(owner.client, owner.groupId)).toBe(0);
  } finally {
    second.close();
  }
});

it("宽限收尾后重复 hello 只留一条失败消息", async () => {
  const owner = await ownerWithBot();
  const first = await connect(owner.computer);
  const runId = await startRun(owner.client, owner.groupId, first);
  first.close();
  await first.closed();
  await waitFor(() => ended(runId), "首次收尾");
  const second = await connect(owner.computer);
  try {
    expect(await notices(owner.client, owner.groupId)).toBe(1);
  } finally {
    second.close();
  }
});

it("断线时排队的交接不留到下一回合", async () => {
  const owner = await ownerWithTeam();
  const first = await connect(owner.computer);
  const push = await connectPush(server.port, owner.client.cookie ?? "");
  try {
    expect((await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "@小销 开个头" })).status).toBe(
      201,
    );
    const source = await first.expect("prompt");
    first.send({
      type: "handoff",
      runId: source.runId,
      botId: owner.sales.id,
      groupId: owner.groupId,
      toBotId: owner.service.id,
      done: "退款政策已经写完",
      notDone: "库存还没核对",
      next: "找仓库确认备货量",
      checklistIndex: null,
    });
    for (;;) {
      const event = await push.next();
      if (event.type === "handoff_updated") break;
    }

    first.close();
    await first.closed();
    await waitFor(() => ended(source.runId), "断线的交接来源 run 收尾");
    const second = await connect(owner.computer);
    try {
      expect(
        (await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "@小销 断线后的新一轮" })).status,
      ).toBe(201);
      const fresh = await second.expect("prompt");
      expect(fresh.botId).toBe(owner.sales.id);
      second.send({
        type: "run_done",
        runId: fresh.runId,
        botId: owner.sales.id,
        groupId: owner.groupId,
        steps: 0,
        inputTokens: 0,
        outputTokens: 0,
      });
      // 收尾之后这个 run 名下的帧不再落库，屏障用不带 runId 的报错：它排在 run_done 后面，推出来就说明 run_done 做完了。
      second.send({ type: "agent_error", code: "runner_failed", detail: "屏障", groupId: owner.groupId });
      for (;;) {
        const event = await push.next();
        if (
          event.type === "message" &&
          event.message.body.kind === "system" &&
          event.message.body.text.endsWith("原话是：屏障")
        )
          break;
      }

      expect((await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "@小销 哨兵" })).status).toBe(
        201,
      );
      const sentinel = await second.expect("prompt");
      expect(sentinel.botId, "断线前未派出的交接不能抢在新消息前冒出来").toBe(owner.sales.id);
      expect(sentinel.reason).toBe("mentioned");

      const page = MessageListResponse.parse(
        await (await owner.client.get(`/api/groups/${owner.groupId}/messages`)).json(),
      );
      expect(page.handoffs, "没确认的交接卡仍保持 pending，当前经手不因断线改变").toMatchObject([
        { fromBotId: owner.sales.id, toBotId: owner.service.id, status: "pending" },
      ]);
    } finally {
      second.close();
    }
  } finally {
    first.close();
    push.close();
  }
});
