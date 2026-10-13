import {
  BotListResponse,
  BotResponse,
  CreateBotResponse,
  DecideApprovalResponse,
  GrantListResponse,
  type ActionKind,
  type Approval,
  type BotId,
  type Grant,
  type ControlToAgent,
  type GrantTarget,
  type GroupId,
  type RunId,
  type ToolView,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { helloAgent, openAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./helpers/fixtures.js";
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

type Job = { readonly groupId: GroupId; readonly botId: BotId; readonly runId: RunId };

type Owner = {
  readonly client: ApiClient;
  readonly agent: AgentClient;
  readonly push: PushClient;
  readonly computer: TestComputer;
  /** 注册时自带的主助理，重连补发时它也有一条。 */
  readonly assistantId: BotId;
  /** 每个 Bot 一个单 Bot 群，各自派出去一个正在跑的活。 */
  readonly jobs: readonly Job[];
  close(): void;
};

/** 一个用户、一台在线电脑、几个各自在跑活的 Bot。审批都挂在这些活上。 */
async function owner(botCount = 1): Promise<Owner> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created: ReturnType<typeof CreateBotResponse.parse>[] = [];
  for (let index = 0; index < botCount; index += 1) {
    created.push(CreateBotResponse.parse(await (await client.post("/api/bots", { name: `小服${index}` })).json()));
  }

  const listed = BotListResponse.parse(await (await client.get("/api/bots")).json());
  const assistant = listed.items.find((item) => item.bot.role === "assistant");
  if (assistant === undefined) throw new Error("注册后应当已有主助理");

  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  const push = await connectPush(server.server.port, client.cookie ?? "");

  const jobs: Job[] = [];
  for (const { bot, group } of created) {
    await client.post(`/api/groups/${group.id}/messages`, { text: "干活" });
    const prompt = await agent.expect("prompt");
    expect((await push.next()).type).toBe("message");
    jobs.push({ groupId: group.id, botId: bot.id, runId: prompt.runId });
  }

  return {
    client,
    agent,
    push,
    computer,
    assistantId: assistant.bot.id,
    jobs,
    close: () => {
      agent.close();
      push.close();
    },
  };
}

function jobAt(who: Owner, index: number): Job {
  const job = who.jobs[index];
  if (job === undefined) throw new Error(`没有第 ${index} 个活`);
  return job;
}

const VIEW: ToolView = { kind: "bash", command: "ls ~/Downloads" };

function pathTarget(who: Owner, prefix: string): GrantTarget {
  return { kind: "path", computerId: who.computer.computerId, prefix };
}

/** 发一条 approval_request，收下审批、卡和通知三条推送，返回那条审批。 */
async function raise(
  who: Owner,
  job: Job,
  callId: string,
  action: ActionKind,
  target: GrantTarget | null,
): Promise<Approval> {
  who.agent.send({
    type: "approval_request",
    runId: job.runId,
    botId: job.botId,
    groupId: job.groupId,
    callId,
    tool: "bash",
    action,
    target,
    view: VIEW,
  });
  const updated = await who.push.next();
  if (updated.type !== "approval_updated") throw new Error(`本应先推 approval_updated，实际是 ${updated.type}`);
  expect((await who.push.next()).type).toBe("message");
  expect((await who.push.next()).type).toBe("notify");
  return updated.approval;
}

async function grantsOf(who: Owner): Promise<Grant[]> {
  const response = await who.client.get("/api/grants");
  expect(response.status).toBe(200);
  return GrantListResponse.parse(await response.json()).grants;
}

/**
 * 让电脑收到一条确定会落地的派活，断言它先到。
 * 前面那步如果偷偷发过 config、approval_result 或 pause，它们会排在这条前面，所以不用靠超时。
 */
async function expectNextDownlinkIsPrompt(who: Owner, job: Job, text: string): Promise<void> {
  await who.client.post(`/api/groups/${job.groupId}/messages`, { text });
  const next: ControlToAgent = await who.agent.next();
  expect(next.type, `电脑这时本该只收到派活，不该收到 ${next.type}`).toBe("prompt");
}

/** 待批卡不能用新用户消息探测下行：新消息会主动作废它。resume 帧同样能证明前面没有多发结论。 */
async function expectNextDownlinkIsResume(who: Owner, job: Job): Promise<void> {
  expect((await who.client.post(`/api/bots/${job.botId}/resume`)).status).toBe(200);
  expect(await who.agent.next()).toEqual({ type: "resume", botId: job.botId });
}

describe("批准时选的范围落成授权", () => {
  it("选这个项目里后同群同类动作的 config 带上授权，别的群不带", async () => {
    const who = await owner(2);
    const here = jobAt(who, 0);
    const there = jobAt(who, 1);

    try {
      const target = pathTarget(who, "/Users/chen/Downloads");
      const approval = await raise(who, here, "call-read", "read", target);
      const response = await who.client.post(`/api/approvals/${approval.id}`, {
        decision: "approved",
        scope: "project",
      });
      expect(response.status).toBe(200);
      const decided = DecideApprovalResponse.parse(await response.json());
      expect(decided.grant).toMatchObject({ scope: "project", groupId: here.groupId, action: "read", target });
      expect(decided.approval.grantId, "审批行记下它落成的那条授权").toBe(decided.grant?.id);

      const config = await who.agent.expect("config");
      expect(config.grants, "授权绑在这个群上，不是全局的").toEqual([decided.grant]);
      expect(config.grants.some((grant) => grant.scope === "project" && grant.groupId === there.groupId)).toBe(false);
      const result = await who.agent.expect("approval_result");
      expect(result, "先让后续调用不再问，再放行当前这一次").toMatchObject({
        runId: here.runId,
        callId: "call-read",
        outcome: "approved",
      });

      const pushed = await who.push.next();
      expect(pushed.type === "approval_updated" ? pushed.approval.grantId : null).toBe(decided.grant?.id);

      const elsewhere = await raise(who, there, "call-read-2", "read", target);
      expect(
        (await who.client.post(`/api/approvals/${elsewhere.id}`, { decision: "approved", scope: "once" })).status,
      ).toBe(200);
      expect((await who.agent.next()).type, "别的群批「这一次」不落授权，也就不重发 config，直接放行").toBe(
        "approval_result",
      );
      expect(await grantsOf(who)).toEqual([decided.grant]);
    } finally {
      who.close();
    }
  });

  it("选一直的授权不绑群，config 里对这个用户全局生效", async () => {
    const who = await owner();
    const job = jobAt(who, 0);

    try {
      const target: GrantTarget = { kind: "domain", domain: "example.com" };
      const approval = await raise(who, job, "call-curl", "shell", target);
      const response = await who.client.post(`/api/approvals/${approval.id}`, {
        decision: "approved",
        scope: "forever",
      });
      expect(response.status).toBe(200);
      const { grant } = DecideApprovalResponse.parse(await response.json());
      expect(grant).toMatchObject({ scope: "forever", action: "shell", target });
      expect(grant !== null && "groupId" in grant, "一直的授权没有群").toBe(false);

      expect((await who.agent.expect("config")).grants).toEqual([grant]);
      expect((await who.agent.expect("approval_result")).outcome).toBe("approved");
    } finally {
      who.close();
    }
  });

  it("同一个群里同一个目标批两次，只落一条授权，两条审批指向它", async () => {
    const who = await owner();
    const job = jobAt(who, 0);

    try {
      const target = pathTarget(who, "/Users/chen/Downloads");
      const first = await raise(who, job, "call-a", "read", target);
      const second = await raise(who, job, "call-b", "read", target);

      const one = DecideApprovalResponse.parse(
        await (await who.client.post(`/api/approvals/${first.id}`, { decision: "approved", scope: "project" })).json(),
      );
      const two = DecideApprovalResponse.parse(
        await (await who.client.post(`/api/approvals/${second.id}`, { decision: "approved", scope: "project" })).json(),
      );

      expect(two.grant?.id, "唯一索引把第二次收成同一条").toBe(one.grant?.id);
      expect(two.approval.grantId).toBe(one.grant?.id);
      expect(await grantsOf(who)).toHaveLength(1);
    } finally {
      who.close();
    }
  });

  it("一直的授权批两次也只落一条，没有群的那一列不让唯一约束失效", async () => {
    const who = await owner(2);

    try {
      const target: GrantTarget = { kind: "domain", domain: "example.com" };
      const first = await raise(who, jobAt(who, 0), "call-a", "shell", target);
      const second = await raise(who, jobAt(who, 1), "call-b", "shell", target);

      const one = DecideApprovalResponse.parse(
        await (await who.client.post(`/api/approvals/${first.id}`, { decision: "approved", scope: "forever" })).json(),
      );
      const two = DecideApprovalResponse.parse(
        await (await who.client.post(`/api/approvals/${second.id}`, { decision: "approved", scope: "forever" })).json(),
      );

      expect(two.grant?.id).toBe(one.grant?.id);
      expect(await grantsOf(who)).toHaveLength(1);
    } finally {
      who.close();
    }
  });

  it("拒绝不落授权，也不重发 config", async () => {
    const who = await owner();
    const job = jobAt(who, 0);

    try {
      const approval = await raise(who, job, "call-no", "read", pathTarget(who, "/Users/chen/Downloads"));
      const response = await who.client.post(`/api/approvals/${approval.id}`, { decision: "rejected" });
      expect(DecideApprovalResponse.parse(await response.json()).grant).toBeNull();
      expect((await who.agent.next()).type).toBe("approval_result");
      expect(await grantsOf(who)).toEqual([]);
    } finally {
      who.close();
    }
  });
});

describe("越级的范围在边界挡下", () => {
  it("硬清单动作带 forever 回 400，不落授权", async () => {
    const who = await owner();
    const job = jobAt(who, 0);

    try {
      const approval = await raise(who, job, "call-spend", "spend", { kind: "domain", domain: "shop.example.com" });
      const response = await who.client.post(`/api/approvals/${approval.id}`, {
        decision: "approved",
        scope: "forever",
      });
      expect(response.status).toBe(400);
      expect(await response.json(), "400 的正文要是人话").toEqual({ error: "这类动作只能批这一次" });

      expect(await grantsOf(who)).toEqual([]);
      await expectNextDownlinkIsResume(who, job);
      const again = await who.client.post(`/api/approvals/${approval.id}`, { decision: "approved", scope: "once" });
      expect(again.status, "被挡下的那次没有定结论，审批还在等").toBe(200);
    } finally {
      who.close();
    }
  });

  it("工作目录外写最多批到这个项目里，带 forever 回 400", async () => {
    const who = await owner();
    const job = jobAt(who, 0);

    try {
      const approval = await raise(who, job, "call-write", "write_outside", pathTarget(who, "/Users/chen/Documents"));
      const response = await who.client.post(`/api/approvals/${approval.id}`, {
        decision: "approved",
        scope: "forever",
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "这类动作最多批到这个项目里" });
      expect(await grantsOf(who)).toEqual([]);
      await expectNextDownlinkIsResume(who, job);
    } finally {
      who.close();
    }
  });

  it("目标为空的审批只能批这一次，带长期范围回 400", async () => {
    const who = await owner();
    const job = jobAt(who, 0);

    try {
      const approval = await raise(who, job, "call-shell", "shell", null);
      const response = await who.client.post(`/api/approvals/${approval.id}`, {
        decision: "approved",
        scope: "project",
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "这条审批没有具体目标，只能批这一次" });
      expect(await grantsOf(who)).toEqual([]);
      await expectNextDownlinkIsResume(who, job);
    } finally {
      who.close();
    }
  });
});

describe("授权列表", () => {
  it("撤销授权后推 grant_deleted 并重发 config", async () => {
    const who = await owner();
    const job = jobAt(who, 0);

    try {
      const approval = await raise(who, job, "call-read", "read", pathTarget(who, "/Users/chen/Downloads"));
      const { grant } = DecideApprovalResponse.parse(
        await (
          await who.client.post(`/api/approvals/${approval.id}`, { decision: "approved", scope: "project" })
        ).json(),
      );
      if (grant === null) throw new Error("选了这个项目里却没落授权");
      await who.agent.expect("config");
      await who.agent.expect("approval_result");
      await who.push.next();
      expect(await grantsOf(who)).toEqual([grant]);

      const deleted = await who.client.delete(`/api/grants/${grant.id}`);
      expect(deleted.status).toBe(204);
      const pushed = await who.push.next();
      expect(pushed).toEqual({ type: "grant_deleted", grantId: grant.id });
      expect((await who.agent.expect("config")).grants, "撤掉之后电脑那头下一次调用又要问").toEqual([]);
      expect(await grantsOf(who)).toEqual([]);

      const again = await who.client.delete(`/api/grants/${grant.id}`);
      expect(again.status, "撤两次第二次是 404").toBe(404);
    } finally {
      who.close();
    }
  });

  it("只能撤自己的，别人的授权 404 且原样留着", async () => {
    const mine = await owner();
    const other = await owner();

    try {
      const approval = await raise(
        mine,
        jobAt(mine, 0),
        "call-read",
        "read",
        pathTarget(mine, "/Users/chen/Downloads"),
      );
      const { grant } = DecideApprovalResponse.parse(
        await (
          await mine.client.post(`/api/approvals/${approval.id}`, { decision: "approved", scope: "forever" })
        ).json(),
      );
      if (grant === null) throw new Error("选了一直却没落授权");

      expect(await grantsOf(other), "别人的授权不出现在我的列表里").toEqual([]);
      const response = await other.client.delete(`/api/grants/${grant.id}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "没有这个对象" });
      expect(await grantsOf(mine)).toEqual([grant]);
    } finally {
      mine.close();
      other.close();
    }
  });
});

/**
 * 在推送通道上等这台电脑被标成休眠。hub 先把连接从表里摘掉再写库、再推这条，
 * 收到它时，发给这台电脑的下行一定落空。
 */
async function untilSleeping(who: Owner): Promise<void> {
  for (;;) {
    const pushed = await who.push.next();
    if (pushed.type === "computer_updated" && pushed.computer.status === "sleeping") return;
  }
}

/** 同一台电脑重新 hello，收下 welcome 和 config，后面的下行留给用例自己读。 */
async function reconnect(who: Owner, activeRuns: readonly RunId[]): Promise<AgentClient> {
  const agent = await openAgent(server.server.port);
  agent.send({
    type: "hello",
    computerId: who.computer.computerId,
    token: who.computer.token,
    version: "test",
    activeRuns: [...activeRuns],
  });
  await agent.expect("welcome");
  await agent.expect("config");
  return agent;
}

/** 给 job 派一条确定会落地的活，收下它之前到的所有下行。 */
async function downlinksBeforePrompt(
  who: Owner,
  agent: AgentClient,
  job: Job,
  text: string,
): Promise<ControlToAgent[]> {
  await who.client.post(`/api/groups/${job.groupId}/messages`, { text });
  const before: ControlToAgent[] = [];
  for (let next = await agent.next(); next.type !== "prompt"; next = await agent.next()) before.push(next);
  return before;
}

const botIdOf = (downlink: ControlToAgent): string => ("botId" in downlink ? (downlink.botId ?? "") : "");

/** 补发按 Bot 各一条，彼此之间没有约定顺序。 */
function byBotId(downlinks: readonly ControlToAgent[]): ControlToAgent[] {
  return downlinks.toSorted((left, right) => botIdOf(left).localeCompare(botIdOf(right)));
}

describe("暂停和继续", () => {
  it("暂停写进 Bot、下发 pause 并推 bot_updated，继续则反过来", async () => {
    const who = await owner();
    const job = jobAt(who, 0);

    try {
      const paused = await who.client.post(`/api/bots/${job.botId}/pause`);
      expect(paused.status).toBe(200);
      expect(BotResponse.parse(await paused.json()).bot.runState).toBe("paused");
      expect(await who.agent.next()).toEqual({ type: "pause", botId: job.botId });
      const pushed = await who.push.next();
      expect(pushed.type === "bot_updated" ? pushed.bot.runState : null).toBe("paused");

      const resumed = await who.client.post(`/api/bots/${job.botId}/resume`);
      expect(BotResponse.parse(await resumed.json()).bot.runState).toBe("running");
      expect(await who.agent.next()).toEqual({ type: "resume", botId: job.botId });
    } finally {
      who.close();
    }
  });

  it("暂停后电脑断线重连，停着的收到 pause，没停的收到 resume", async () => {
    const who = await owner(2);
    const pausedJob = jobAt(who, 0);
    const runningJob = jobAt(who, 1);

    try {
      expect((await who.client.post(`/api/bots/${pausedJob.botId}/pause`)).status).toBe(200);
      await who.agent.expect("pause");
      who.agent.close();
      await untilSleeping(who);

      const agent = await reconnect(who, [pausedJob.runId, runningJob.runId]);
      try {
        const synced = await downlinksBeforePrompt(who, agent, pausedJob, "还在吗");
        expect(
          byBotId(synced),
          "config 之后、派活之前，每个 Bot 按库里的状态各补一条，主助理没停过，补 resume",
        ).toEqual(
          byBotId([
            { type: "pause", botId: pausedJob.botId },
            { type: "resume", botId: runningJob.botId },
            { type: "resume", botId: who.assistantId },
          ]),
        );
      } finally {
        agent.close();
      }
    } finally {
      who.close();
    }
  });

  it("断线期间点继续，重连后 config 之后先下发 resume", async () => {
    const who = await owner();
    const job = jobAt(who, 0);

    try {
      expect((await who.client.post(`/api/bots/${job.botId}/pause`)).status).toBe(200);
      await who.agent.expect("pause");
      who.agent.close();
      await untilSleeping(who);

      const resumed = await who.client.post(`/api/bots/${job.botId}/resume`);
      expect(BotResponse.parse(await resumed.json()).bot.runState, "断线期间点继续，库里照样改").toBe("running");

      const agent = await reconnect(who, [job.runId]);
      try {
        expect(
          byBotId(await downlinksBeforePrompt(who, agent, job, "接着干")),
          "那条 resume 发的时候没有连接，重连时要补上，否则同一个代理进程里的 Bot 一直停着",
        ).toEqual(
          byBotId([
            { type: "resume", botId: job.botId },
            { type: "resume", botId: who.assistantId },
          ]),
        );
      } finally {
        agent.close();
      }
    } finally {
      who.close();
    }
  });

  it("继续之后重连，补发的是 resume 不是 pause", async () => {
    const who = await owner();
    const job = jobAt(who, 0);

    try {
      await who.client.post(`/api/bots/${job.botId}/pause`);
      await who.agent.expect("pause");
      await who.client.post(`/api/bots/${job.botId}/resume`);
      await who.agent.expect("resume");
      who.agent.close();
      await untilSleeping(who);

      const agent = await reconnect(who, [job.runId]);
      try {
        expect(byBotId(await downlinksBeforePrompt(who, agent, job, "接着干"))).toEqual(
          byBotId([
            { type: "resume", botId: job.botId },
            { type: "resume", botId: who.assistantId },
          ]),
        );
      } finally {
        agent.close();
      }
    } finally {
      who.close();
    }
  });

  it("别人的 Bot 暂停是 404，电脑收不到 pause", async () => {
    const mine = await owner();
    const other = await owner();

    try {
      const response = await other.client.post(`/api/bots/${jobAt(mine, 0).botId}/pause`);
      expect(response.status).toBe(404);
      await expectNextDownlinkIsPrompt(mine, jobAt(mine, 0), "还在干");
    } finally {
      mine.close();
      other.close();
    }
  });
});

describe("删 Bot", () => {
  it("删掉有挂起审批的 Bot 后，审批卡推成终态", async () => {
    const who = await owner();
    const job = jobAt(who, 0);

    try {
      const approval = await raise(who, job, "call-left", "read", pathTarget(who, "/Users/chen/Downloads"));
      expect((await who.client.delete(`/api/bots/${job.botId}`)).status).toBe(204);

      const first = await who.push.next();
      expect(first.type, "卡先推成终态，再推 Bot 没了").toBe("approval_updated");
      expect(first.type === "approval_updated" ? first.approval : null).toMatchObject({
        id: approval.id,
        status: "expired",
      });
      expect((await who.push.next()).type).toBe("bot_deleted");
      expect((await who.agent.next()).type, "删 Bot 只重发 config，不再给那个挂着的调用发 approval_result").toBe(
        "config",
      );
    } finally {
      who.close();
    }
  });

  it("删别人的 Bot 时不改他的审批行", async () => {
    const mine = await owner();
    const other = await owner();
    const job = jobAt(mine, 0);

    try {
      const approval = await raise(mine, job, "call-kept", "read", pathTarget(mine, "/Users/chen/Downloads"));
      expect((await other.client.delete(`/api/bots/${job.botId}`)).status).toBe(404);

      const response = await mine.client.post(`/api/approvals/${approval.id}`, { decision: "approved", scope: "once" });
      expect(response.status, "别人删不掉我的 Bot，我的审批也还在等我批").toBe(200);
      expect(DecideApprovalResponse.parse(await response.json()).approval.status).toBe("approved");
      expect(await mine.agent.next()).toMatchObject({
        type: "approval_result",
        callId: "call-kept",
        outcome: "approved",
      });
      const pushed = await mine.push.next();
      expect(pushed.type === "approval_updated" ? pushed.approval.status : pushed.type, "我这边不该先收到失效").toBe(
        "approved",
      );
    } finally {
      mine.close();
      other.close();
    }
  });
});
