import { randomUUID } from "node:crypto";
import {
  BotListResponse,
  CreateBotResponse,
  DownlinkFrame,
  MessageId,
  MessageListResponse,
  toolViewText,
  type Approval,
  type BotId,
  type GroupId,
  type RunId,
  type ToolView,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentHub } from "../src/agent/hub.js";
import { STALE_APPROVAL_MS, remindStaleApprovals } from "../src/repo/approvals.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, waitFor, type TestComputer } from "./helpers/fixtures.js";
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

type Running = {
  readonly client: ApiClient;
  readonly agent: AgentClient;
  readonly push: PushClient;
  readonly groupId: GroupId;
  readonly botId: BotId;
  readonly runId: RunId;
  readonly computer: TestComputer;
  close(): void;
};

/** 一个已经派出去、正在跑的活。审批全都挂在它上面。 */
async function runningJob(): Promise<Running> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小服" })).json());

  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  const push = await connectPush(server.server.port, client.cookie ?? "");

  await client.post(`/api/groups/${created.group.id}/messages`, { text: "干活" });
  const prompt = await agent.expect("prompt");
  await push.next();

  return {
    client,
    agent,
    push,
    groupId: created.group.id,
    botId: created.bot.id,
    runId: prompt.runId,
    computer,
    close: () => {
      agent.close();
      push.close();
    },
  };
}

const TOOL = "shop.refund";
const SUMMARY = "给这单退 120 块";
const VIEW: ToolView = { kind: "mcp", server: "", tool: TOOL, params: [], raw: SUMMARY };

function sendApprovalRequest(job: Running, callId: string): void {
  job.agent.send({
    type: "approval_request",
    runId: job.runId,
    botId: job.botId,
    groupId: job.groupId,
    callId,
    tool: TOOL,
    action: "spend",
    target: null,
    view: VIEW,
  });
}

function sendApprovalAbandoned(job: Running, callId: string): void {
  job.agent.send({
    type: "approval_abandoned",
    runId: job.runId,
    callId,
    reason: "stopped",
  });
}

/** 发一条 approval_request 并收下状态、卡片和通知。推送顺序本身由第一条用例把关。 */
async function raiseApproval(job: Running, callId = "call-1"): Promise<Approval> {
  sendApprovalRequest(job, callId);
  const updated = await job.push.next();
  if (updated.type !== "approval_updated") throw new Error(`本应先推 approval_updated，实际是 ${updated.type}`);
  const card = await job.push.next();
  if (card.type !== "message") throw new Error(`审批之后本应推那条卡，实际是 ${card.type}`);
  const notice = await job.push.next();
  if (notice.type !== "notify" || notice.notice.kind !== "confirm")
    throw new Error(`审批卡之后本应推 confirm 通知，实际是 ${notice.type}`);
  return updated.approval;
}

async function page(job: Running): Promise<ReturnType<typeof MessageListResponse.parse>> {
  return MessageListResponse.parse(await (await job.client.get(`/api/groups/${job.groupId}/messages`)).json());
}

/**
 * 让电脑收到一条能落地的下行报文，再断言它先到。
 * 前面那步如果偷偷回过 approval_result，它会排在这条前面，所以不用靠超时。
 */
async function expectNextDownlinkIsPrompt(job: Running, text: string): Promise<void> {
  await job.client.post(`/api/groups/${job.groupId}/messages`, { text });
  const next = await job.agent.next();
  expect(next.type, `电脑这时本该只收到派活，不该收到 ${next.type}`).toBe("prompt");
  expect(next.type === "prompt" ? next.text : null).toBe(text);
}

describe("approval_request 到达", () => {
  it("群里多一张审批卡，先推审批再推卡，电脑一直挂着等", async () => {
    const job = await runningJob();

    try {
      sendApprovalRequest(job, "call-1");

      const first = await job.push.next();
      expect(first.type, "客户端画卡的时候状态得已经在手上，所以审批先推").toBe("approval_updated");
      const approval = first.type === "approval_updated" ? first.approval : null;
      expect(approval?.status).toBe("pending");
      expect(approval?.action).toBe("spend");
      expect(approval?.view).toEqual(VIEW);
      expect(approval?.runId).toBe(job.runId);
      expect(approval?.botId).toBe(job.botId);
      expect(approval?.decidedAt, "还没人点头").toBeNull();

      const second = await job.push.next();
      expect(second.type === "message" ? second.message.body : null).toEqual({
        kind: "approval",
        approvalId: approval?.id,
      });
      const third = await job.push.next();
      expect(third.type === "notify" ? third.notice.kind : null).toBe("confirm");

      const stored = await page(job);
      expect(
        stored.messages.filter((m) => m.body.kind === "approval"),
        "群里就该有这一张卡",
      ).toHaveLength(1);
      expect(
        stored.approvals.map((a) => a.id),
        "这一页引用到的审批跟着一起回",
      ).toEqual([approval?.id]);

      await job.client.post(`/api/groups/${job.groupId}/messages`, { text: "再看一眼" });
      expect(await job.agent.expect("approval_result")).toMatchObject({ callId: "call-1", outcome: "voided" });
      expect((await job.agent.expect("prompt")).text).toBe("再看一眼");
    } finally {
      job.close();
    }
  });

  it("重发同一条不多出第二张卡", async () => {
    const job = await runningJob();

    try {
      const approval = await raiseApproval(job, "call-1");
      sendApprovalRequest(job, "call-1");

      // 再发一条能落地的报文，它先推出来就说明重发那条什么也没做，不靠超时。
      job.agent.send({
        type: "bot_text",
        runId: job.runId,
        botId: job.botId,
        groupId: job.groupId,
        messageId: MessageId.parse(randomUUID()),
        delta: "接着干",
        done: true,
      });
      const next = await job.push.next();
      expect(next.type === "message" ? next.message.body.kind : null).toBe("bot");

      const stored = await page(job);
      expect(
        stored.messages.filter((m) => m.body.kind === "approval"),
        "电脑重发也只该有一张卡",
      ).toHaveLength(1);
      expect(stored.approvals.map((a) => a.id)).toEqual([approval.id]);
    } finally {
      job.close();
    }
  });
});

describe("放弃审批", () => {
  it("运行器上报放弃后，点批准返回冲突，卡片状态是已失效", async () => {
    const job = await runningJob();

    try {
      const approval = await raiseApproval(job, "call-expired");
      sendApprovalAbandoned(job, "call-expired");

      const pushed = await job.push.next();
      expect(pushed.type).toBe("approval_updated");
      expect(pushed.type === "approval_updated" ? pushed.approval : null).toMatchObject({
        id: approval.id,
        status: "expired",
      });

      const stored = await page(job);
      expect(stored.approvals).toMatchObject([{ id: approval.id, status: "expired" }]);

      const response = await job.client.post(`/api/approvals/${approval.id}`, { decision: "approved" });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: "这条审批已经有结论了",
        approval: { id: approval.id, status: "expired" },
      });
    } finally {
      job.close();
    }
  });

  it("别的电脑上报的放弃被丢弃", async () => {
    const mine = await runningJob();
    const other = await runningJob();

    try {
      const approval = await raiseApproval(mine, "call-owned");
      other.agent.send({
        type: "approval_abandoned",
        runId: mine.runId,
        callId: "call-owned",
        reason: "stopped",
      });
      other.agent.send({
        type: "bot_tool_call",
        runId: other.runId,
        botId: other.botId,
        groupId: other.groupId,
        callId: "abandoned-sentinel",
        tool: "test.sentinel",
        view: { kind: "mcp", server: "", tool: "test.sentinel", params: [] },
        status: "ok",
        durationMs: 0,
      });

      const next = await other.push.next();
      expect(next.type === "message" ? next.message.body : null).toMatchObject({
        kind: "tool_call",
        tool: "test.sentinel",
      });
      expect((await page(mine)).approvals).toMatchObject([{ id: approval.id, status: "pending" }]);
    } finally {
      mine.close();
      other.close();
    }
  });
});

describe("点按钮", () => {
  it("批准之后电脑收到 approved outcome，runId 和 callId 对得上", async () => {
    const job = await runningJob();

    try {
      const approval = await raiseApproval(job, "call-7");
      const response = await job.client.post(`/api/approvals/${approval.id}`, { decision: "approved" });
      expect(response.status).toBe(200);

      const result = await job.agent.expect("approval_result");
      expect(result.outcome).toBe("approved");
      expect(result.runId, "运行器按 runId 加 callId 认是哪个工具在等").toBe(job.runId);
      expect(result.callId).toBe("call-7");

      const pushed = await job.push.next();
      expect(pushed.type === "approval_updated" ? pushed.approval.status : null).toBe("approved");
      expect(pushed.type === "approval_updated" ? pushed.approval.decidedAt : null, "卡上要显示时间").not.toBeNull();
    } finally {
      job.close();
    }
  });

  it("拒绝之后电脑收到 rejected outcome", async () => {
    const job = await runningJob();

    try {
      const approval = await raiseApproval(job, "call-8");
      expect((await job.client.post(`/api/approvals/${approval.id}`, { decision: "rejected" })).status).toBe(200);

      const result = await job.agent.expect("approval_result");
      expect(result.outcome, "拒绝要让运行器把这个工具调用打成 blocked").toBe("rejected");
      expect(result.callId).toBe("call-8");
    } finally {
      job.close();
    }
  });

  it("别人的审批是 404，不告诉他有没有这条", async () => {
    const mine = await runningJob();
    const other = await runningJob();

    try {
      const approval = await raiseApproval(mine, "call-1");
      const response = await other.client.post(`/api/approvals/${approval.id}`, { decision: "approved" });

      expect(response.status).toBe(404);
      expect(await response.json(), "和不存在的 id 回一样的话").toEqual({ error: "没有这个对象" });
      const stored = await page(mine);
      expect(stored.approvals[0]?.status, "别人点了也不该改变这条的状态").toBe("pending");
      await mine.client.post(`/api/groups/${mine.groupId}/messages`, { text: "它还等着" });
      expect(await mine.agent.expect("approval_result")).toMatchObject({ callId: "call-1", outcome: "voided" });
      expect((await mine.agent.next()).type).toBe("prompt");
    } finally {
      mine.close();
      other.close();
    }
  });

  it("重复决定是 409，不会第二次告诉电脑", async () => {
    const job = await runningJob();

    try {
      const approval = await raiseApproval(job, "call-9");
      expect((await job.client.post(`/api/approvals/${approval.id}`, { decision: "approved" })).status).toBe(200);
      const result = await job.agent.expect("approval_result");
      expect(result.outcome).toBe("approved");

      const again = await job.client.post(`/api/approvals/${approval.id}`, { decision: "rejected" });
      expect(again.status).toBe(409);
      expect(await again.json(), "409 的正文要是人话并带回当前结论").toMatchObject({
        error: "这条审批已经有结论了",
        approval: { id: approval.id, status: "approved" },
      });

      await expectNextDownlinkIsPrompt(job, "接着干");
    } finally {
      job.close();
    }
  });
});

describe("群里回文字", () => {
  it("回「批准」等于按按钮，而且不会再派一次活", async () => {
    const job = await runningJob();

    try {
      await raiseApproval(job, "call-2");
      expect((await job.client.post(`/api/groups/${job.groupId}/messages`, { text: " 批准 " })).status).toBe(201);

      const result = await job.agent.expect("approval_result");
      expect(result.outcome).toBe("approved");
      expect(result.callId).toBe("call-2");

      // 运行器正挂着等结论，这条「批准」再派一次活就会并发起第二个 run。
      await expectNextDownlinkIsPrompt(job, "继续");
    } finally {
      job.close();
    }
  });

  it("回「不行」等于拒绝", async () => {
    const job = await runningJob();

    try {
      await raiseApproval(job, "call-3");
      expect((await job.client.post(`/api/groups/${job.groupId}/messages`, { text: "不行" })).status).toBe(201);

      const result = await job.agent.expect("approval_result");
      expect(result.outcome).toBe("rejected");
    } finally {
      job.close();
    }
  });

  it("群里没有待批审批时「批准」就是一句普通话，照常派活", async () => {
    const job = await runningJob();

    try {
      await expectNextDownlinkIsPrompt(job, "批准");
    } finally {
      job.close();
    }
  });
});

describe("侧栏角标", () => {
  it("pendingApprovals 建审批前 0，建后 1，定完结论回 0", async () => {
    const job = await runningJob();
    const pendingCount = async (): Promise<number> => {
      const list = BotListResponse.parse(await (await job.client.get("/api/bots")).json());
      return list.items.find((item) => item.bot.id === job.botId)?.pendingApprovals ?? -1;
    };

    try {
      expect(await pendingCount()).toBe(0);
      const approval = await raiseApproval(job, "call-4");
      expect(await pendingCount()).toBe(1);

      expect((await job.client.post(`/api/approvals/${approval.id}`, { decision: "rejected" })).status).toBe(200);
      expect(await pendingCount(), "有了结论就不再等人点头").toBe(0);
    } finally {
      job.close();
    }
  });
});

describe("24 小时提醒", () => {
  it("过了一天补一条 system 提醒，再扫一遍不重复，没到点的不碰", async () => {
    const job = await runningJob();

    try {
      await raiseApproval(job, "call-5");
      const fresh = await remindStaleApprovals(database.db, server.server.hub, new Date());
      expect(fresh, "刚建出来的审批还没到点").toBe(0);

      const later = new Date(Date.now() + STALE_APPROVAL_MS + 60_000);
      await remindStaleApprovals(database.db, server.server.hub, later);
      const reminder = await job.push.next();
      const text =
        reminder.type === "message" && reminder.message.body.kind === "system" ? reminder.message.body.text : "";
      expect(text, "提醒要说清楚等的是哪件事").toContain(toolViewText(VIEW));
      expect(reminder.type === "message" ? reminder.message.body : null).toMatchObject({ tone: "info" });

      const again = await remindStaleApprovals(database.db, server.server.hub, later);
      expect(again, "reminded_at 已经占住了，第二遍一行都不该命中").toBe(0);
      // 再发一条能落地的报文，它先推出来就说明第二次扫描什么也没补，不靠超时。
      job.agent.send({
        type: "bot_text",
        runId: job.runId,
        botId: job.botId,
        groupId: job.groupId,
        messageId: MessageId.parse(randomUUID()),
        delta: "还等着",
        done: true,
      });
      const next = await job.push.next();
      expect(next.type === "message" ? next.message.body.kind : null).toBe("bot");

      const stored = await page(job);
      expect(
        stored.messages.filter((m) => m.body.kind === "system"),
        "提醒只该有一条",
      ).toHaveLength(1);
      const pending = stored.approvals.filter((a) => a.status === "pending");
      expect(pending, "只提醒，不升级也不自动拒绝").toHaveLength(1);
    } finally {
      job.close();
    }
  });
});

describe("提醒的写入不会半程丢掉", () => {
  it("推送每次都炸，三个群的提醒照样各自落了库", async () => {
    const jobs = [await runningJob(), await runningJob(), await runningJob()];

    try {
      for (const [index, job] of jobs.entries()) await raiseApproval(job, `call-boom-${index}`);

      const later = new Date(Date.now() + STALE_APPROVAL_MS + 60_000);
      const hub = server.server.hub;
      const boom = vi.spyOn(hub, "push").mockImplementation(() => {
        throw new Error("推送炸了");
      });
      await expect(remindStaleApprovals(database.db, hub, later)).rejects.toThrow("推送炸了");
      boom.mockRestore();

      for (const job of jobs) {
        expect(
          (await page(job)).messages.filter((m) => m.body.kind === "system"),
          "提醒落库和占住 reminded_at 要一起成，不然这几行永远不会再被提醒",
        ).toHaveLength(1);
      }

      const again = await remindStaleApprovals(database.db, hub, later);
      expect(again, "reminded_at 已经占住了，再扫一遍一行都不该命中").toBe(0);
    } finally {
      for (const job of jobs) job.close();
    }
  });
});

describe("审批结论可靠投递", () => {
  it.each(["approved", "rejected"] as const)("人工决定 %s 先入发件箱，恢复发送后按原序号投递", async (decision) => {
    const job = await runningJob();
    let restoreFlush: (() => void) | undefined;
    try {
      const approval = await raiseApproval(job, "call-reliable-decision");
      const blocked = vi.spyOn(AgentHub.prototype, "flushOutbox").mockImplementation(async () => undefined);
      restoreFlush = () => blocked.mockRestore();
      const response = await job.client.post(`/api/approvals/${approval.id}`, { decision });
      expect(response.status).toBe(200);
      expect((await page(job)).approvals).toMatchObject([{ id: approval.id, status: decision }]);
      const queued = await database.sql<{ seq: number; body: unknown; run_id: string }[]>`
        SELECT seq, body, run_id FROM agent_outbox
        WHERE computer_id = ${job.computer.computerId} AND body->>'type' = 'approval_result'
      `;
      expect(queued, "发送暂不可用时，已提交的人工结论留在可靠发件箱").toEqual([
        {
          seq: expect.any(Number),
          run_id: job.runId,
          body: { type: "approval_result", runId: job.runId, callId: "call-reliable-decision", outcome: decision },
        },
      ]);
      expect((await job.client.post(`/api/bots/${job.botId}/pause`)).status).toBe(200);
      expect(await job.agent.next(), "没有绕过发件箱直接发送审批结论").toMatchObject({
        type: "pause",
        botId: job.botId,
      });

      const frames: ReturnType<typeof DownlinkFrame.parse>[] = [];
      job.agent.socket.on("message", (raw) => {
        const frame = DownlinkFrame.safeParse(JSON.parse(raw.toString()));
        if (frame.success) frames.push(frame.data);
      });
      blocked.mockRestore();
      expect((await job.client.post(`/api/groups/${job.groupId}/messages`, { text: "继续查库存" })).status).toBe(201);
      expect(await job.agent.next()).toMatchObject({
        type: "approval_result",
        callId: "call-reliable-decision",
        outcome: decision,
      });
      expect(await job.agent.next()).toMatchObject({ type: "prompt", text: "继续查库存" });
      expect(frames[0], "补送的是原先入箱的序号和 run，电脑能按可靠信封确认").toMatchObject({
        seq: queued[0]?.seq,
        body: { type: "approval_result", runId: job.runId, outcome: decision },
      });
    } finally {
      restoreFlush?.();
      job.close();
    }
  });
});

describe("电脑断线", () => {
  it("重连报告 run 还活着时只收到 welcome 和 config，pending 的审批不重发，决定照样发下去", async () => {
    const job = await runningJob();

    try {
      const approval = await raiseApproval(job, "call-6");
      job.agent.close();
      await waitFor(async () => {
        const rows = await database.sql<{ status: string }[]>`
          SELECT status FROM computers WHERE id = ${job.computer.computerId}
        `;
        return rows[0]?.status === "sleeping";
      }, "电脑变成休眠");

      // helloAgent 逐条 expect 握手的两条，中间多出任何一条报文它就会失败。
      const { agent } = await helloAgent(server.server.port, job.computer.computerId, job.computer.token, [job.runId]);
      try {
        expect((await job.client.post(`/api/approvals/${approval.id}`, { decision: "approved" })).status).toBe(200);
        const result = await agent.expect("approval_result");
        expect(result.outcome, "结论要落到重连后的那条连接上").toBe("approved");
        expect(result.callId).toBe("call-6");
      } finally {
        agent.close();
      }
    } finally {
      job.close();
    }
  });

  it("断线期间点的结论就地落库，重连后不补发", async () => {
    const job = await runningJob();

    try {
      const approval = await raiseApproval(job, "call-7");
      job.agent.close();
      await waitFor(async () => {
        const rows = await database.sql<{ status: string }[]>`
          SELECT status FROM computers WHERE id = ${job.computer.computerId}
        `;
        return rows[0]?.status === "sleeping";
      }, "电脑变成休眠");

      // 电脑不在线，agents.send 发不出去，这一版仍然认这个结论。
      expect((await job.client.post(`/api/approvals/${approval.id}`, { decision: "rejected" })).status).toBe(200);
      expect((await page(job)).approvals[0]?.status, "决定不因为电脑不在而丢").toBe("rejected");

      // helloAgent 逐条 expect 握手的两条，重连时补发那条已决结论就会挤在中间让它失败。
      const { agent } = await helloAgent(server.server.port, job.computer.computerId, job.computer.token);
      try {
        await job.client.post(`/api/groups/${job.groupId}/messages`, { text: "接着干" });
        const next = await agent.next();
        expect(next.type, "重连后只该照常派活").toBe("prompt");
      } finally {
        agent.close();
      }
    } finally {
      job.close();
    }
  });
});
