import { randomUUID } from "node:crypto";
import {
  CreateBotResponse,
  MessageId,
  MessageListResponse,
  type BotId,
  type GroupId,
  type Message,
  type RunId,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser } from "./helpers/fixtures.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

// 一百万输入 token 三块、一百万输出 token 十五块，好让 run_done 的折算有个能算的数。
const PRICE_INPUT_PER_M = 3;
const PRICE_OUTPUT_PER_M = 15;

let database: TestDb;
let server: TestServer;

beforeAll(async () => {
  database = await createTestDb();
  server = await startTestServer(database.db, {
    priceInputPerM: PRICE_INPUT_PER_M,
    priceOutputPerM: PRICE_OUTPUT_PER_M,
  });
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
  close(): void;
};

/** 一个已经派出去、正在跑的活。事件回流全都挂在它上面。 */
async function runningJob(text = "干活"): Promise<Running> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小服" })).json());

  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  const push = await connectPush(server.server.port, client.cookie ?? "");

  await client.post(`/api/groups/${created.group.id}/messages`, { text });
  const prompt = await agent.expect("prompt");
  const userPush = await push.next();
  expect(userPush.type === "message" ? userPush.message.body : null).toEqual({ kind: "user", text });

  return {
    client,
    agent,
    push,
    groupId: created.group.id,
    botId: created.bot.id,
    runId: prompt.runId,
    close: () => {
      agent.close();
      push.close();
    },
  };
}

async function groupMessages(job: Running): Promise<Message[]> {
  const page = MessageListResponse.parse(await (await job.client.get(`/api/groups/${job.groupId}/messages`)).json());
  return page.messages;
}

describe("bot_text", () => {
  it("三段 delta 推出一条 message 和三条 message_delta，库里正文完整", async () => {
    const job = await runningJob();
    const messageId = MessageId.parse(randomUUID());

    try {
      for (const [index, delta] of ["先看一眼", "再点进去", "好了"].entries()) {
        job.agent.send({
          type: "bot_text",
          runId: job.runId,
          botId: job.botId,
          groupId: job.groupId,
          messageId,
          delta,
          done: index === 2,
        });
      }

      const first = await job.push.next();
      expect(first.type).toBe("message");
      expect(first.type === "message" ? first.message.id : null).toBe(messageId);
      expect(first.type === "message" ? first.message.body : null).toEqual({
        kind: "bot",
        botId: job.botId,
        text: "",
        streaming: true,
      });

      const deltas = [await job.push.next(), await job.push.next(), await job.push.next()];
      expect(deltas.map((p) => (p.type === "message_delta" ? [p.delta, p.done] : p.type))).toEqual([
        ["先看一眼", false],
        ["再点进去", false],
        ["好了", true],
      ]);
      for (const p of deltas) expect(p.type === "message_delta" ? p.messageId : null).toBe(messageId);

      const stored = (await groupMessages(job)).find((m) => m.id === messageId);
      expect(stored?.body).toEqual({ kind: "bot", botId: job.botId, text: "先看一眼再点进去好了", streaming: false });
    } finally {
      job.close();
    }
  });

  it("别人的群号报上来一条都不落", async () => {
    const mine = await runningJob();
    const other = await runningJob();

    try {
      mine.agent.send({
        type: "bot_text",
        runId: mine.runId,
        botId: mine.botId,
        groupId: other.groupId,
        messageId: MessageId.parse(randomUUID()),
        delta: "插到别人群里",
        done: true,
      });
      mine.agent.send({
        type: "bot_text",
        runId: mine.runId,
        botId: mine.botId,
        groupId: mine.groupId,
        messageId: MessageId.parse(randomUUID()),
        delta: "自己群里",
        done: true,
      });

      // 后发的那条先推出来，说明越权那条根本没写进去，不靠超时。
      const push = await mine.push.next();
      expect(push.type === "message" ? push.message.groupId : null).toBe(mine.groupId);
      expect(
        (await groupMessages(other)).map((m) => m.body.kind),
        "别人的群里不该多出东西",
      ).toEqual(["user"]);
    } finally {
      mine.close();
      other.close();
    }
  });
});

describe("bot_tool_call", () => {
  it("running 到 ok 同一条消息推两次", async () => {
    const job = await runningJob();

    try {
      job.agent.send({
        type: "bot_tool_call",
        runId: job.runId,
        botId: job.botId,
        groupId: job.groupId,
        callId: "call-1",
        tool: "browser.click",
        argsSummary: "点开订单列表",
        status: "running",
        durationMs: null,
      });
      const started = await job.push.next();
      const messageId = started.type === "message" ? started.message.id : null;
      expect(started.type === "message" ? started.message.body : null).toEqual({
        kind: "tool_call",
        botId: job.botId,
        tool: "browser.click",
        argsSummary: "点开订单列表",
        status: "running",
        durationMs: null,
      });

      job.agent.send({
        type: "bot_tool_call",
        runId: job.runId,
        botId: job.botId,
        groupId: job.groupId,
        callId: "call-1",
        tool: "browser.click",
        argsSummary: "点开订单列表",
        status: "ok",
        durationMs: 820,
      });
      const finished = await job.push.next();
      expect(finished.type === "message" ? finished.message.id : null, "同一个 id 推第二次，客户端按 id 覆盖").toBe(
        messageId,
      );
      expect(finished.type === "message" ? finished.message.body : null).toEqual({
        kind: "tool_call",
        botId: job.botId,
        tool: "browser.click",
        argsSummary: "点开订单列表",
        status: "ok",
        durationMs: 820,
      });

      const stored = (await groupMessages(job)).filter((m) => m.body.kind === "tool_call");
      expect(stored, "两次报文只该有一条工具调用消息").toHaveLength(1);
      expect(stored[0]?.id).toBe(messageId);
    } finally {
      job.close();
    }
  });
});

describe("run_done", () => {
  it("结束 run、按价目折算金额、群里多一张花费卡", async () => {
    const job = await runningJob();

    try {
      job.agent.send({
        type: "run_done",
        runId: job.runId,
        botId: job.botId,
        groupId: job.groupId,
        steps: 7,
        inputTokens: 1_000_000,
        outputTokens: 200_000,
      });

      const push = await job.push.next();
      expect(push.type === "message" ? push.message.body : null).toEqual({
        kind: "cost",
        runId: job.runId,
        steps: 7,
        amount: 6,
      });

      const rows = await database.sql<
        { ended_at: Date | null; steps: number; input_tokens: number; output_tokens: number; amount: string }[]
      >`SELECT ended_at, steps, input_tokens, output_tokens, amount FROM runs WHERE group_id = ${job.groupId}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.ended_at).not.toBeNull();
      expect(rows[0]?.steps).toBe(7);
      expect(rows[0]?.input_tokens).toBe(1_000_000);
      expect(rows[0]?.output_tokens).toBe(200_000);
      expect(Number(rows[0]?.amount), "一百万输入按 3 加二十万输出按 15").toBe(6);
    } finally {
      job.close();
    }
  });

  it("重发同一个 runId 不多一行也不多一张卡", async () => {
    const job = await runningJob();
    const done = {
      type: "run_done",
      runId: job.runId,
      botId: job.botId,
      groupId: job.groupId,
      steps: 2,
      inputTokens: 1000,
      outputTokens: 1000,
    } as const;

    try {
      job.agent.send(done);
      await job.push.next();
      job.agent.send(done);

      // 再发一条能落地的报文，它先推出来就说明重发那条什么也没做，不靠超时。
      job.agent.send({
        type: "bot_text",
        runId: job.runId,
        botId: job.botId,
        groupId: job.groupId,
        messageId: MessageId.parse(randomUUID()),
        delta: "收尾",
        done: true,
      });
      const next = await job.push.next();
      expect(next.type === "message" ? next.message.body.kind : null).toBe("bot");

      const rows = await database.sql<{ n: string }[]>`
        SELECT count(*) AS n FROM runs WHERE group_id = ${job.groupId}
      `;
      expect(rows[0]?.n).toBe("1");
      expect(
        (await groupMessages(job)).filter((m) => m.body.kind === "cost"),
        "花费卡只该有一张",
      ).toHaveLength(1);
    } finally {
      job.close();
    }
  });
});

describe("agent_error", () => {
  it("在还没结束的活所在的群里留一句人话", async () => {
    const job = await runningJob();

    try {
      job.agent.send({ type: "agent_error", code: "runner_failed", detail: "exit code 137" });
      const push = await job.push.next();
      const text = push.type === "message" && push.message.body.kind === "system" ? push.message.body.text : "";

      expect(text).toContain("跑活的进程出错了");
      expect(text, "原始报错留着，出问题时要能查").toContain("exit code 137");
    } finally {
      job.close();
    }
  });
});

describe("approval_request", () => {
  it("先回一个不批，再在群里说清楚", async () => {
    const job = await runningJob();

    try {
      job.agent.send({
        type: "approval_request",
        runId: job.runId,
        botId: job.botId,
        groupId: job.groupId,
        callId: "call-9",
        tool: "shop.refund",
        kind: "pay",
        summary: "给这单退 120 块",
      });

      const result = await job.agent.expect("approval_result");
      expect(result.runId).toBe(job.runId);
      expect(result.callId).toBe("call-9");
      expect(result.approved, "审批要到 M5，这一版一律不批").toBe(false);

      const push = await job.push.next();
      const text = push.type === "message" && push.message.body.kind === "system" ? push.message.body.text : "";
      expect(text).toContain("shop.refund");
      expect(text).toContain("M5");
    } finally {
      job.close();
    }
  });
});
