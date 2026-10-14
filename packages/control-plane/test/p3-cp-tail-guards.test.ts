import {
  CreateBotResponse,
  EMPTY_WORK_HEAD,
  HubLaneSnapshot,
  MessageListResponse,
  type Approval,
  type BotId,
  type ControlToAgent,
  type GroupId,
  type UserId,
} from "@baize/shared";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startServer, type RunningServer } from "../src/server.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, TEST_CREDENTIALS_KEY } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./helpers/fixtures.js";
import { gatedDb, type QueryGate } from "./helpers/gated-db.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

const DAY_MS = 86_400_000;
let database: TestDb;
let gates: ReturnType<typeof gatedDb>;
let server: RunningServer;
const clients: { agent: AgentClient; push: PushClient }[] = [];

beforeAll(async () => {
  database = await createTestDb();
  gates = gatedDb(database.sql);
  server = await startServer({
    db: gates.db,
    port: 0,
    credentialsKey: TEST_CREDENTIALS_KEY,
    toolSecretKey: "a".repeat(64),
    disconnectGraceMs: DAY_MS,
    silenceTimeoutMs: DAY_MS,
    leaseRenewalIntervalMs: DAY_MS,
    scheduler: { intervalMs: DAY_MS },
    publisher: { intervalMs: DAY_MS },
    poker: { intervalMs: DAY_MS },
    approvalTimeoutIntervalMs: DAY_MS,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { agent, push } of clients) {
    agent.close();
    push.close();
  }
  await Promise.all(clients.map(({ agent }) => agent.closed()));
  clients.length = 0;
});

afterAll(async () => {
  await server.close();
  await database.close();
});

type Prompt = Extract<ControlToAgent, { type: "prompt" }>;
type Rig = {
  readonly ownerId: UserId;
  readonly client: ApiClient;
  readonly computer: TestComputer;
  readonly botId: BotId;
  readonly groupId: GroupId;
  readonly agent: AgentClient;
  readonly push: PushClient;
  readonly gatewayKey: string;
};

async function rig(): Promise<Rig> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = new ApiClient(server.port);
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小守" })).json());
  const { agent, config } = await helloAgent(server.port, computer.computerId, computer.token);
  const push = await connectPush(server.port, client.cookie ?? "");
  clients.push({ agent, push });
  return {
    ownerId: user.id,
    client,
    computer,
    botId: created.bot.id,
    groupId: created.group.id,
    agent,
    push,
    gatewayKey: config.modelGateway.apiKey,
  };
}

async function start(who: Rig): Promise<Prompt> {
  expect((await who.client.post(`/api/groups/${who.groupId}/messages`, { text: "先处理退款" })).status).toBe(201);
  const prompt = await who.agent.expect("prompt");
  const pushed = await who.push.next();
  expect(pushed.type === "message" ? pushed.message.body : null).toEqual({ kind: "user", text: "先处理退款" });
  return prompt;
}

async function raise(who: Rig, prompt: Prompt): Promise<Approval> {
  who.agent.send({
    type: "approval_request",
    runId: prompt.runId,
    botId: who.botId,
    groupId: who.groupId,
    callId: "call-unplaced-void",
    tool: "shop.refund",
    action: "spend",
    target: null,
    view: { kind: "mcp", server: "", tool: "shop.refund", params: [], raw: "给这单退款" },
  });
  const updated = await who.push.next();
  if (updated.type !== "approval_updated") throw new Error("审批请求没有推送审批状态");
  expect(updated.approval.status).toBe("pending");
  const card = await who.push.next();
  expect(card.type === "message" ? card.message.body : null).toEqual({
    kind: "approval",
    approvalId: updated.approval.id,
  });
  const notice = await who.push.next();
  expect(notice.type === "notify" ? notice.notice.kind : null).toBe("confirm");
  return updated.approval;
}

describe("控制面收尾守卫", () => {
  it("选机后租约过期使 placeRun 非 queued，待批审批仍恰好一次变为 voided", async () => {
    const who = await rig();
    const prompt = await start(who);
    const approval = await raise(who, prompt);
    let gate: QueryGate | undefined;
    try {
      // 初选已经成功，事务尚未锁电脑；保留连接避免断线收尾先把审批改成 expired。
      gate = gates.arm(/^select "id" from "computers" .*for no key update$/i, "before", who.ownerId);
      const sending = who.client.post(`/api/groups/${who.groupId}/messages`, { text: "换一件事" });
      await gate.reached;
      await database.sql`
        UPDATE computers SET lease_until = clock_timestamp() - interval '1 second'
        WHERE id = ${who.computer.computerId}
      `;
      gate.release();
      expect((await sending).status).toBe(201);

      const statuses: Approval["status"][] = [];
      const failureNotice = "电脑不在线，这条没派出去，电脑回来后再说一次";
      // 派发失败提示在作废推送之后，收到它就证明本次派活的全部审批推送已经到齐。
      for (;;) {
        const pushed = await who.push.next();
        if (pushed.type === "approval_updated" && pushed.approval.id === approval.id)
          statuses.push(pushed.approval.status);
        if (pushed.type === "message" && pushed.message.body.kind === "system") {
          expect(pushed.message.body).toEqual({ kind: "system", tone: "error", text: failureNotice });
          break;
        }
      }
      expect(statuses).toEqual(["voided"]);
      expect(await who.agent.expect("approval_result")).toMatchObject({
        runId: prompt.runId,
        callId: "call-unplaced-void",
        outcome: "voided",
      });
      expect(who.agent.received()).toEqual([]);
      const page = MessageListResponse.parse(
        await (await who.client.get(`/api/groups/${who.groupId}/messages`)).json(),
      );
      expect(page.approvals.map(({ id, status }) => ({ id, status }))).toEqual([{ id: approval.id, status: "voided" }]);
      expect(page.approvals[0]?.decidedAt).not.toBeNull();
      expect((await who.client.post(`/api/approvals/${approval.id}`, { decision: "approved" })).status).toBe(409);
    } finally {
      gate?.release();
    }
  });

  it("Hub lanes GET 的实际数据库事务是 repeatable read 且 read only", async () => {
    const who = await rig();
    const prompt = await start(who);
    const transaction = gates.db.transaction.bind(gates.db);
    const observed: {
      readonly options: Parameters<typeof transaction>[1];
      readonly actual: { isolation: string; read_only: string } | null;
    }[] = [];
    vi.spyOn(gates.db, "transaction").mockImplementation(async (body, options) =>
      transaction(async (tx) => {
        const [settings] = await tx.execute<{ isolation: string; read_only: string }>(sql`
            SELECT current_setting('transaction_isolation') AS isolation,
              current_setting('transaction_read_only') AS read_only
          `);
        observed.push({ options, actual: settings ?? null });
        return body(tx);
      }, options),
    );

    const response = await fetch(`http://localhost:${server.port}/hub/v1/lanes/${who.botId}/${who.groupId}/chat`, {
      headers: {
        authorization: `Bearer ${who.gatewayKey}`,
        "x-baize-lane": `${who.botId}/${who.groupId}/${prompt.lane.epoch}`,
      },
    });
    expect(response.status).toBe(200);
    expect(HubLaneSnapshot.parse(await response.json())).toEqual({
      entries: [],
      nextSeq: 0,
      head: EMPTY_WORK_HEAD,
      piSessionVersion: null,
    });
    // prompt 的自动 ACK 也会开默认事务；只读快照必须恰好有一条显式配置的事务。
    expect(observed.filter(({ options }) => options !== undefined)).toEqual([
      {
        options: { isolationLevel: "repeatable read", accessMode: "read only" },
        actual: { isolation: "repeatable read", read_only: "on" },
      },
    ]);
  });
});
