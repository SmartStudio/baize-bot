import {
  CreateBotResponse,
  CreateGroupResponse,
  MessageListResponse,
  RoutineResponse,
  MessageId,
  type Approval,
  type Bot,
  type BotId,
  type GroupId,
  type RunId,
  type ToolView,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_RUNTIME_CONFIG, startServer, type RunningServer } from "../src/server.js";
import { ApiClient, TEST_CREDENTIALS_KEY } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./helpers/fixtures.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

let database: TestDb;
let server: RunningServer;
let scheduleTime = new Date("2030-01-01T09:00:00");

beforeAll(async () => {
  database = await createTestDb();
  server = await startServer({
    db: database.db,
    port: 0,
    toolSecretKey: "a".repeat(64),
    credentialsKey: TEST_CREDENTIALS_KEY,
    config: {
      ...DEFAULT_RUNTIME_CONFIG,
      githubApiBaseUrl: "http://127.0.0.1:9/github",
      xApiBaseUrl: "http://127.0.0.1:9/x",
    },
    scheduler: { now: () => scheduleTime, intervalMs: 60 * 60 * 1000 },
    publisher: { intervalMs: 24 * 60 * 60 * 1000 },
    approvalTimeoutIntervalMs: 24 * 60 * 60 * 1000,
  });
});

afterAll(async () => {
  await server.close();
  await database.close();
});

type Job = { readonly botId: BotId; readonly groupId: GroupId; readonly runId: RunId };
type Owner = {
  readonly client: ApiClient;
  readonly agent: AgentClient;
  readonly push: PushClient;
  readonly computer: TestComputer;
  readonly bots: readonly Bot[];
  readonly groupId: GroupId;
  close(): void;
};

async function owner(names: readonly string[]): Promise<Owner> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = new ApiClient(server.port);
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const bots: Bot[] = [];
  let soloGroupId: GroupId | null = null;
  for (const name of names) {
    const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name })).json());
    bots.push(created.bot);
    soloGroupId = created.group.id;
  }
  let groupId = soloGroupId;
  if (bots.length > 1) {
    const created = await client.post("/api/groups", { title: "审批验收", botIds: bots.map((bot) => bot.id) });
    expect(created.status).toBe(201);
    groupId = CreateGroupResponse.parse(await created.json()).group.id;
  }
  if (groupId === null) throw new Error("测试 owner 至少需要一个 Bot");
  const { agent } = await helloAgent(server.port, computer.computerId, computer.token);
  const push = await connectPush(server.port, client.cookie ?? "");
  return {
    client,
    agent,
    push,
    computer,
    bots,
    groupId,
    close: () => {
      agent.close();
      push.close();
    },
  };
}

async function promptFor(who: Owner, text: string): Promise<Job> {
  expect((await who.client.post(`/api/groups/${who.groupId}/messages`, { text })).status).toBe(201);
  const prompt = await who.agent.expect("prompt");
  await who.push.next();
  return { botId: prompt.botId, groupId: prompt.groupId, runId: prompt.runId };
}

const TOOL_VIEW: ToolView = { kind: "mcp", server: "", tool: "shop.refund", params: [], raw: "给这单退 120 块" };

async function raise(who: Owner, job: Job, callId: string): Promise<Approval> {
  who.agent.send({
    type: "approval_request",
    runId: job.runId,
    botId: job.botId,
    groupId: job.groupId,
    callId,
    tool: "shop.refund",
    action: "spend",
    target: null,
    view: TOOL_VIEW,
  });
  for (;;) {
    const update = await who.push.next();
    if (update.type !== "approval_updated" || update.approval.runId !== job.runId) continue;
    const card = await who.push.next();
    expect(card.type === "message" ? card.message.body : null).toEqual({
      kind: "approval",
      approvalId: update.approval.id,
    });
    for (;;) {
      const notice = await who.push.next();
      if (notice.type === "notify" && notice.notice.kind === "confirm") return update.approval;
    }
  }
}

async function page(who: Owner): Promise<ReturnType<typeof MessageListResponse.parse>> {
  return MessageListResponse.parse(await (await who.client.get(`/api/groups/${who.groupId}/messages`)).json());
}

async function makeRoutine(who: Owner): Promise<void> {
  const response = await who.client.post(`/api/bots/${who.bots[0]?.id}/routines`, {
    name: "审批期限验收",
    instruction: "检查这份日报",
    triggers: [{ kind: "cron", expr: "* * * * *" }],
    onFailure: "stop_and_tell",
  });
  expect(response.status).toBe(201);
  RoutineResponse.parse(await response.json());
  await server.routines.tick();
  scheduleTime = new Date(scheduleTime.getTime() + 61_000);
  await server.routines.tick();
}

async function handoffPrompt(who: Owner): Promise<Job> {
  const sender = who.bots[0];
  const receiver = who.bots[1];
  if (sender === undefined || receiver === undefined) throw new Error("交接测试需要两个 Bot");
  const first = await promptFor(who, `@${sender.name} 请交给同伴处理`);
  who.agent.send({
    type: "handoff",
    runId: first.runId,
    botId: sender.id,
    groupId: who.groupId,
    toBotId: receiver.id,
    done: "完成了初步检查",
    notDone: "还没核对附件",
    next: "继续检查附件",
    checklistIndex: null,
  });
  for (;;) {
    const pushed = await who.push.next();
    if (pushed.type === "handoff_updated") break;
  }
  who.agent.send({
    type: "run_done",
    runId: first.runId,
    botId: sender.id,
    groupId: who.groupId,
    steps: 1,
    inputTokens: 0,
    outputTokens: 0,
  });
  const prompt = await who.agent.expect("prompt");
  expect(prompt.botId).toBe(receiver.id);
  return { botId: prompt.botId, groupId: prompt.groupId, runId: prompt.runId };
}

describe("P3-5 审批期限与作废规则", () => {
  it("用户当面发起的审批 deadlineAt 为空，扫描不改变状态", async () => {
    const who = await owner(["小服"]);
    try {
      const job = await promptFor(who, "帮我查一下退款");
      const approval = await raise(who, job, "call-user");
      expect(approval.deadlineAt).toBeNull();
      expect(await server.scanApprovalTimeouts(new Date("2035-01-01T00:00:00Z"))).toBe(0);
      expect((await page(who)).approvals).toMatchObject([{ id: approval.id, status: "pending", decidedAt: null }]);
    } finally {
      who.close();
    }
  });

  it("例行审批期限等于卡片 createdAt 加十分钟，到点后电脑和页面同步 timed_out", async () => {
    const who = await owner(["小服"]);
    try {
      await makeRoutine(who);
      const prompt = await who.agent.expect("prompt");
      const job = { botId: prompt.botId, groupId: prompt.groupId, runId: prompt.runId };
      const approval = await raise(who, job, "call-routine");
      const stored = await page(who);
      const card = stored.messages.find(
        (message) => message.body.kind === "approval" && message.body.approvalId === approval.id,
      );
      if (card?.body.kind !== "approval") throw new Error("审批卡不存在");
      if (approval.deadlineAt === null) throw new Error("例行审批必须有截止时间");
      const deadline = new Date(approval.deadlineAt);
      expect(Math.abs(deadline.getTime() - new Date(card.createdAt).getTime() - 10 * 60_000)).toBeLessThan(1000);
      expect(await server.scanApprovalTimeouts(new Date(deadline.getTime() - 1))).toBe(0);
      expect(await server.scanApprovalTimeouts(deadline)).toBe(1);
      expect(await who.agent.expect("approval_result")).toMatchObject({ callId: "call-routine", outcome: "timed_out" });
      const pushed = await who.push.next();
      expect(pushed.type === "approval_updated" ? pushed.approval : null).toMatchObject({
        id: approval.id,
        status: "timed_out",
        decidedAt: deadline.toISOString(),
      });
      expect((await page(who)).approvals).toMatchObject([{ id: approval.id, status: "timed_out" }]);
      expect(await server.scanApprovalTimeouts(deadline)).toBe(0);
    } finally {
      who.close();
    }
  });

  it.each(["按钮", "群里答复"])(
    "截止已过但扫描器还没跑时，%s不能批准，就地结算 timed_out 且只推一次",
    async (source) => {
      const who = await owner(["小服"]);
      try {
        await makeRoutine(who);
        const prompt = await who.agent.expect("prompt");
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date(Date.now() - 11 * 60_000));
        const approval = await raise(who, prompt, "call-overdue");
        vi.useRealTimers();
        if (approval.deadlineAt === null) throw new Error("例行审批必须有截止时间");
        expect(new Date(approval.deadlineAt).getTime()).toBeLessThan(Date.now());
        expect((await page(who)).approvals).toMatchObject([{ id: approval.id, status: "pending" }]);

        if (source === "按钮") {
          expect((await who.client.post(`/api/approvals/${approval.id}`, { decision: "approved" })).status).toBe(409);
        } else {
          expect((await who.client.post(`/api/groups/${who.groupId}/messages`, { text: "批准" })).status).toBe(201);
          const reply = await who.push.next();
          expect(reply.type === "message" ? reply.message.body : null).toMatchObject({ kind: "user", text: "批准" });
        }
        expect(await who.agent.expect("approval_result")).toMatchObject({
          runId: prompt.runId,
          callId: "call-overdue",
          outcome: "timed_out",
        });
        const pushed = await who.push.next();
        expect(pushed.type === "approval_updated" ? pushed.approval : null).toMatchObject({
          id: approval.id,
          status: "timed_out",
          grantId: null,
        });
        expect(pushed.type === "approval_updated" ? pushed.approval.decidedAt : null).not.toBeNull();
        expect((await page(who)).approvals).toMatchObject([{ id: approval.id, status: "timed_out", grantId: null }]);
        expect((await who.client.post(`/api/approvals/${approval.id}`, { decision: "approved" })).status).toBe(409);
        expect(await server.scanApprovalTimeouts(new Date())).toBe(0);
        who.agent.send({
          type: "bot_text",
          runId: prompt.runId,
          botId: prompt.botId,
          groupId: prompt.groupId,
          messageId: MessageId.parse(`overdue-${source}`),
          delta: "超时后继续",
          done: true,
        });
        const next = await who.push.next();
        expect(next.type === "message" ? next.message.body.kind : null).toBe("bot");
        expect(who.agent.received()).toEqual([]);
      } finally {
        vi.useRealTimers();
        who.close();
      }
    },
  );

  it("交接触发的审批期限也等于交接卡 createdAt 加十分钟", async () => {
    const who = await owner(["小销", "小服"]);
    try {
      const job = await handoffPrompt(who);
      const approval = await raise(who, job, "call-handoff");
      const stored = await page(who);
      const card = stored.messages.find(
        (message) => message.body.kind === "approval" && message.body.approvalId === approval.id,
      );
      if (card?.body.kind !== "approval") throw new Error("审批卡不存在");
      if (approval.deadlineAt === null) throw new Error("交接审批必须有截止时间");
      expect(
        Math.abs(new Date(approval.deadlineAt).getTime() - new Date(card.createdAt).getTime() - 10 * 60_000),
      ).toBeLessThan(1000);
    } finally {
      who.close();
    }
  });

  it("同 Bot 同群新用户消息先作废 pending 审批，再派新活；卡片决议时间落库且旧按钮冲突", async () => {
    const who = await owner(["小服"]);
    try {
      const job = await promptFor(who, "先处理退款");
      const approval = await raise(who, job, "call-void");
      expect((await who.client.post(`/api/groups/${who.groupId}/messages`, { text: "换一件事" })).status).toBe(201);
      expect(await who.agent.expect("approval_result")).toMatchObject({ callId: "call-void", outcome: "voided" });
      expect((await who.agent.expect("prompt")).text).toBe("换一件事");
      const pageAfter = await page(who);
      expect(pageAfter.approvals).toMatchObject([{ id: approval.id, status: "voided" }]);
      expect(pageAfter.approvals.find((item) => item.id === approval.id)?.decidedAt).not.toBeNull();
      expect((await who.client.post(`/api/approvals/${approval.id}`, { decision: "approved" })).status).toBe(409);
    } finally {
      who.close();
    }
  });

  it("四个群内决定词消费审批，后续新消息不会再发 voided", async () => {
    const who = await owner(["小服"]);
    try {
      const job = await promptFor(who, "等我确认");
      for (const [index, word] of ["批准", "同意", "拒绝", "不行"].entries()) {
        const callId = `call-word-${index}`;
        const approval = await raise(who, job, callId);
        expect((await who.client.post(`/api/groups/${who.groupId}/messages`, { text: word })).status).toBe(201);
        const outcome = index < 2 ? "approved" : "rejected";
        expect(await who.agent.expect("approval_result")).toMatchObject({ callId, outcome });
        const reply = await who.push.next();
        expect(reply.type === "message" ? reply.message.body : null).toEqual({ kind: "user", text: word });
        const updated = await who.push.next();
        expect(updated.type === "approval_updated" ? updated.approval : null).toMatchObject({
          id: approval.id,
          status: outcome,
        });
        expect((await page(who)).approvals.find((item) => item.id === approval.id)?.status).toBe(outcome);
      }
      await who.client.post(`/api/groups/${who.groupId}/messages`, { text: "继续工作" });
      expect((await who.agent.expect("prompt")).text).toBe("继续工作");
    } finally {
      who.close();
    }
  });

  it("多 Bot 群的新消息只作废被派 Bot 的审批", async () => {
    const who = await owner(["小销", "小服"]);
    try {
      const first = who.bots[0];
      const second = who.bots[1];
      if (first === undefined || second === undefined) throw new Error("需要两个 Bot");
      const firstJob = await promptFor(who, `@${first.name} 先看退款`);
      const firstApproval = await raise(who, firstJob, "call-targeted");
      const secondJob = await promptFor(who, `@${second.name} 再看库存`);
      expect((await page(who)).approvals.find((item) => item.id === firstApproval.id)?.status).toBe("pending");
      const secondApproval = await raise(who, secondJob, "call-other");
      await who.client.post(`/api/groups/${who.groupId}/messages`, { text: `@${first.name} 换个问题` });
      expect(await who.agent.expect("approval_result")).toMatchObject({ callId: "call-targeted", outcome: "voided" });
      expect((await who.agent.expect("prompt")).text).toBe(`@${first.name} 换个问题`);
      const approvals = (await page(who)).approvals;
      expect(approvals.find((item) => item.id === firstApproval.id)?.status).toBe("voided");
      expect(approvals.find((item) => item.id === secondApproval.id)?.status).toBe("pending");
    } finally {
      who.close();
    }
  });

  it("同一个 Bot 在另一个群里的审批继续等待，同群挂着的每张审批都作废", async () => {
    const who = await owner(["小销", "小服"]);
    try {
      const created = CreateGroupResponse.parse(
        await (
          await who.client.post("/api/groups", {
            title: "另一个审批群",
            botIds: who.bots.map((bot) => bot.id),
          })
        ).json(),
      );
      const other = { ...who, groupId: created.group.id };
      const otherJob = await promptFor(other, "@小销 先看另一个群");
      const otherApproval = await raise(other, otherJob, "call-other-group");
      const job = await promptFor(who, "@小销 在这里等批");
      const first = await raise(who, job, "call-first");
      const second = await raise(who, job, "call-second");
      await who.client.post(`/api/groups/${who.groupId}/messages`, { text: "@小销 换个任务" });
      const outcomes = [await who.agent.expect("approval_result"), await who.agent.expect("approval_result")];
      expect(outcomes.map((result) => result.callId).toSorted()).toEqual(["call-first", "call-second"]);
      expect(outcomes.every((result) => result.outcome === "voided")).toBe(true);
      expect((await who.agent.expect("prompt")).text).toBe("@小销 换个任务");
      const approvals = (await page(who)).approvals;
      expect(approvals.find((item) => item.id === first.id)?.status).toBe("voided");
      expect(approvals.find((item) => item.id === second.id)?.status).toBe("voided");
      expect((await page(other)).approvals.find((item) => item.id === otherApproval.id)?.status).toBe("pending");
    } finally {
      who.close();
    }
  });

  it("例行新 prompt 不作废已有审批，Bot @ 派活审批期限为空", async () => {
    const who = await owner(["小服"]);
    try {
      const userJob = await promptFor(who, "手动活先等批复");
      const waiting = await raise(who, userJob, "call-stays");
      await makeRoutine(who);
      const routinePrompt = await who.agent.expect("prompt");
      expect(routinePrompt.origin).toEqual({ kind: "routine" });
      expect((await page(who)).approvals.find((item) => item.id === waiting.id)?.status).toBe("pending");

      const team = await owner(["小销", "小服"]);
      try {
        const source = await promptFor(team, "@小销 看一下这笔退款");
        team.agent.send({
          type: "bot_text",
          runId: source.runId,
          botId: source.botId,
          groupId: source.groupId,
          messageId: MessageId.parse("bot-mention-message"),
          delta: "@小服 请继续核对",
          done: true,
        });
        team.agent.send({
          type: "run_done",
          runId: source.runId,
          botId: source.botId,
          groupId: source.groupId,
          steps: 1,
          inputTokens: 0,
          outputTokens: 0,
        });
        const mentionPrompt = await team.agent.expect("prompt");
        expect(mentionPrompt.origin.kind).toBe("bot");
        const mentionApproval = await raise(team, mentionPrompt, "call-mention");
        expect(mentionApproval.deadlineAt).toBeNull();
      } finally {
        team.close();
      }
    } finally {
      who.close();
    }
  });
});
