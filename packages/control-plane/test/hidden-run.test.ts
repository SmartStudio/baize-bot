import {
  ControlToAgent,
  CreateBotResponse,
  CreateGroupResponse,
  PokerHandId,
  PokerSessionId,
  RunId,
  type Bot,
  type ComputerId,
  type GroupId,
  type MessageId,
  type PokerTableRole,
  type ServerPush,
} from "@baize/shared";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendHiddenRun, type HiddenRunDeps, type HiddenRunInput } from "../src/agent/hidden-run.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser } from "./helpers/fixtures.js";
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

type Prompt = Extract<ControlToAgent, { type: "prompt" }>;

type Table = {
  readonly client: ApiClient;
  readonly agent: AgentClient;
  readonly push: PushClient;
  readonly computerId: ComputerId;
  readonly ownerId: string;
  readonly bots: readonly [Bot, Bot];
  readonly groupId: GroupId;
  /** sendHiddenRun 的依赖：真库，发出去的报文记在 sent 里（过一遍 ControlToAgent，和真 hub 同口径）。 */
  readonly deps: HiddenRunDeps;
  readonly sent: Prompt[];
  close(): void;
};

async function makeBot(client: ApiClient, name: string): Promise<Bot> {
  const response = await client.post("/api/bots", { name, tags: ["牌桌"] });
  expect(response.status).toBe(201);
  return CreateBotResponse.parse(await response.json()).bot;
}

/** 一个用户、一台连着的电脑、一个二人群。群里两个 Bot 各当牌友或老白用。 */
async function makeTable(options: { readonly online?: boolean } = {}): Promise<Table> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const first = await makeBot(client, "阿豹");
  const second = await makeBot(client, "老白");
  const created = await client.post("/api/groups", { title: "周末德州", botIds: [first.id, second.id] });
  expect(created.status).toBe(201);
  const group = CreateGroupResponse.parse(await created.json()).group;
  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  const push = await connectPush(server.server.port, client.cookie ?? "");
  const sent: Prompt[] = [];
  const online = options.online ?? true;
  let flushedThrough = 0;
  const deps: HiddenRunDeps = {
    db: database.db,
    agents: {
      isOnline: () => online,
      canDeliver: () => online,
      configRejected: () => false,
      flushOutbox: async (computerId) => {
        const rows = await database.sql<{ seq: number; body: unknown }[]>`
          SELECT seq, body FROM agent_outbox
          WHERE computer_id = ${computerId} AND seq > ${flushedThrough}
          ORDER BY seq`;
        for (const row of rows) {
          flushedThrough = row.seq;
          const parsed = ControlToAgent.parse(row.body);
          if (parsed.type === "prompt") sent.push(parsed);
        }
      },
    },
  };
  return {
    client,
    agent,
    push,
    computerId: computer.computerId,
    ownerId: user.id,
    bots: [first, second],
    groupId: group.id,
    deps,
    sent,
    close: () => {
      agent.close();
      push.close();
    },
  };
}

function tableInput(table: Table, botIndex: 0 | 1, role: PokerTableRole): HiddenRunInput {
  const bot = table.bots[botIndex];
  return {
    botId: bot.id,
    groupId: table.groupId,
    role,
    visibleTo: [{ kind: "bot", botId: bot.id }],
    table: {
      sessionId: PokerSessionId.parse("session-1"),
      handId: PokerHandId.parse("hand-1"),
      seq: 3,
      view: null,
      publicLog: ["阿豹加注到 60"],
      question: role === "advisor" ? "这手怎么打" : null,
      review: null,
    },
  };
}

async function startedRun(table: Table, botIndex: 0 | 1, role: PokerTableRole): Promise<RunId> {
  const outcome = await sendHiddenRun(table.deps, tableInput(table, botIndex, role));
  if (outcome.kind !== "sent") throw new Error(`本应派出去，实际是 ${outcome.kind}`);
  return outcome.runId;
}

/** 一条普通 run（table_role 为空）。上行报文的归属校验要求 runId 真属于这个 Bot 在这个群里。 */
async function plainRun(table: Table, botIndex: 0 | 1): Promise<RunId> {
  const runId = RunId.parse(randomUUID());
  await database.sql`
    INSERT INTO runs (id, bot_id, group_id, computer_id, started_at)
    VALUES (${runId}, ${table.bots[botIndex].id}, ${table.groupId}, ${table.computerId}, now())
  `;
  return runId;
}

function botText(table: Table, runId: RunId, botIndex: 0 | 1, messageId: MessageId, delta: string): void {
  table.agent.send({
    type: "bot_text",
    runId,
    botId: table.bots[botIndex].id,
    groupId: table.groupId,
    messageId,
    delta,
    done: true,
  });
}

/**
 * 普通 run 再说一句，作为「前面那几帧都处理完了」的哨兵：同一条连接上的帧按序处理，
 * 哨兵的推送先到，说明前面的要么落地、要么被丢了。不靠超时。
 */
async function settleAfter(table: Table): Promise<ServerPush[]> {
  const runId = await plainRun(table, 1);
  const sentinel = randomUUID() as MessageId;
  botText(table, runId, 1, sentinel, "哨兵这句是普通 run 说的");
  const pushes: ServerPush[] = [];
  for (;;) {
    const push = await table.push.next();
    pushes.push(push);
    if (push.type === "message_delta" && push.messageId === sentinel) return pushes;
  }
}

type StoredMessage = { id: string; kind: string; visible_to: unknown };

async function storedMessages(groupId: GroupId): Promise<StoredMessage[]> {
  return database.sql<StoredMessage[]>`
    SELECT id, body ->> 'kind' AS kind, visible_to FROM messages WHERE group_id = ${groupId} ORDER BY seq
  `;
}

describe("隐藏派活", () => {
  it("隐藏派活的触发消息只有该 Bot 看得到", async () => {
    const table = await makeTable();
    try {
      const outcome = await sendHiddenRun(table.deps, tableInput(table, 0, "player"));
      if (outcome.kind !== "sent") throw new Error(`本应派出去，实际是 ${outcome.kind}`);
      const [message] = await database.sql<{ body: unknown; visible_to: unknown }[]>`
        SELECT body, visible_to FROM messages WHERE id = ${outcome.messageId}
      `;
      expect(message?.visible_to).toEqual([{ kind: "bot", botId: table.bots[0].id }]);
      expect(message?.body).toEqual({ kind: "system", text: "牌桌回合" });
      const [run] = await database.sql<
        { visible_to: unknown; table_role: string | null; trigger_message_id: string }[]
      >`
        SELECT visible_to, table_role, trigger_message_id FROM runs WHERE id = ${outcome.runId}
      `;
      expect(run?.visible_to).toEqual([{ kind: "bot", botId: table.bots[0].id }]);
      expect(run?.table_role).toBe("player");
      expect(run?.trigger_message_id).toBe(outcome.messageId);
    } finally {
      table.close();
    }
  });

  it("表桌派活的 prompt 里 context 为空、task 为 null", async () => {
    const table = await makeTable();
    try {
      const player = await sendHiddenRun(table.deps, tableInput(table, 0, "player"));
      const advisor = await sendHiddenRun(table.deps, tableInput(table, 1, "advisor"));
      if (player.kind !== "sent" || advisor.kind !== "sent") throw new Error("两条都应派出去");
      const [first, second] = table.sent;
      if (first === undefined || second === undefined) throw new Error("应发出两条 prompt");

      expect(first).toMatchObject({
        runId: player.runId,
        botId: table.bots[0].id,
        groupId: table.groupId,
        messageId: player.messageId,
        origin: { kind: "table" },
        purpose: "fast",
        routine: null,
        task: null,
        context: [],
        members: [],
        table: { ...tableInput(table, 0, "player").table, role: "player" },
      });
      expect(second).toMatchObject({
        runId: advisor.runId,
        messageId: advisor.messageId,
        origin: { kind: "table" },
        purpose: "plan",
        task: null,
        context: [],
        members: [],
        table: { role: "advisor", question: "这手怎么打" },
      });
      // 群里本来就有的历史（建群时的消息）不进表桌 prompt，也不记成这次读到的上下文。
      const [recorded] = await database.sql<{ unsettled_context: unknown; settled_context: unknown }[]>`
        SELECT unsettled_context, settled_context FROM runs WHERE id = ${player.runId}
      `;
      expect(recorded?.unsettled_context ?? []).toEqual([]);
      expect(recorded?.settled_context ?? []).toEqual([]);
    } finally {
      table.close();
    }
  });

  it("同一个 Bot 在同一个群已有未收尾的表桌 run 时再派活被拒，什么都没留下", async () => {
    const table = await makeTable();
    try {
      await startedRun(table, 0, "player");
      const before = await storedMessages(table.groupId);
      const [runsBefore] = await database.sql<
        { count: string }[]
      >`SELECT count(*) FROM runs WHERE group_id = ${table.groupId}`;

      expect(await sendHiddenRun(table.deps, tableInput(table, 0, "player"))).toEqual({ kind: "busy" });
      expect(await sendHiddenRun(table.deps, tableInput(table, 0, "advisor"))).toEqual({ kind: "busy" });

      expect(await storedMessages(table.groupId), "被拒的派活不留触发消息").toEqual(before);
      const [runsAfter] = await database.sql<
        { count: string }[]
      >`SELECT count(*) FROM runs WHERE group_id = ${table.groupId}`;
      expect(runsAfter?.count).toBe(runsBefore?.count);
      expect(table.sent, "被拒的派活不发 prompt").toHaveLength(1);
    } finally {
      table.close();
    }
  });

  it("同一个群里已有未收尾的 advisor 时，另一个 Bot 的 advisor 也被拒，牌友不受影响", async () => {
    const table = await makeTable();
    try {
      await startedRun(table, 1, "advisor");
      expect(await sendHiddenRun(table.deps, tableInput(table, 0, "advisor"))).toEqual({ kind: "busy" });
      expect((await sendHiddenRun(table.deps, tableInput(table, 0, "player"))).kind).toBe("sent");
    } finally {
      table.close();
    }
  });

  it("run_done 之后该 Bot 可以再派", async () => {
    const table = await makeTable();
    try {
      const first = await startedRun(table, 0, "player");
      table.agent.send({
        type: "run_done",
        runId: first,
        botId: table.bots[0].id,
        groupId: table.groupId,
        steps: 1,
        inputTokens: 0,
        outputTokens: 0,
      });
      await table.agent.ack(first);

      const again = await sendHiddenRun(table.deps, tableInput(table, 0, "player"));
      if (again.kind !== "sent") throw new Error(`run_done 之后应能再派，实际是 ${again.kind}`);
      expect(again.runId).not.toBe(first);
    } finally {
      table.close();
    }
  });

  it("选不到在线电脑时不建 run、不写触发消息", async () => {
    const table = await makeTable({ online: false });
    try {
      const before = await storedMessages(table.groupId);
      const outcome = await sendHiddenRun(table.deps, tableInput(table, 0, "player"));
      expect(outcome).toMatchObject({ kind: "unplaced" });
      expect(await storedMessages(table.groupId)).toEqual(before);
      expect(table.sent).toEqual([]);
    } finally {
      table.close();
    }
  });
});

describe("表桌 run 的上行白名单", () => {
  it("player 的 run 上行 bot_text 被丢弃，不落库不推送", async () => {
    const table = await makeTable();
    try {
      const runId = await startedRun(table, 0, "player");
      const leaked = randomUUID() as MessageId;
      botText(table, runId, 0, leaked, "我拿着 AK，准备慢打");

      const pushes = await settleAfter(table);
      expect(await storedMessages(table.groupId).then((rows) => rows.map((row) => row.id))).not.toContain(leaked);
      for (const push of pushes) {
        if (push.type === "message") expect(push.message.id).not.toBe(leaked);
        if (push.type === "message_delta") expect(push.messageId).not.toBe(leaked);
      }
    } finally {
      table.close();
    }
  });

  it("player 的 run 上行 handoff、mention、approval_request 被丢弃", async () => {
    const table = await makeTable();
    try {
      const runId = await startedRun(table, 0, "player");
      const [self, other] = table.bots;
      const common = { runId, botId: self.id, groupId: table.groupId } as const;
      table.agent.send({
        type: "handoff",
        ...common,
        toBotId: other.id,
        done: "发了牌",
        notDone: "没下注",
        next: "替我弃牌",
        checklistIndex: null,
      });
      table.agent.send({ type: "mention", ...common, targetBotId: other.id, text: "看我的底牌" });
      table.agent.send({
        type: "approval_request",
        ...common,
        callId: "call-1",
        tool: "bash",
        action: "shell",
        target: null,
        view: { kind: "bash", command: "rm -rf /" },
      });

      await settleAfter(table);
      const kinds = (await storedMessages(table.groupId)).map((row) => row.kind);
      expect(kinds, "牌桌 run 不能往桌上插卡、@ 人").not.toContain("handoff");
      expect(kinds).not.toContain("approval");
      const [handoffs] = await database.sql<{ count: string }[]>`SELECT count(*) FROM handoffs`;
      const [approvals] = await database.sql<
        { count: string }[]
      >`SELECT count(*) FROM approvals WHERE run_id = ${runId}`;
      expect(handoffs?.count).toBe("0");
      expect(approvals?.count).toBe("0");
      expect(
        table.agent.received().filter((message) => message.type === "prompt"),
        "mention 不能派出新活",
      ).toEqual([]);
    } finally {
      table.close();
    }
  });

  it("advisor 的 bot_text 落库后可见范围只有用户", async () => {
    const table = await makeTable();
    try {
      const runId = await startedRun(table, 1, "advisor");
      const answer = randomUUID() as MessageId;
      botText(table, runId, 1, answer, "跟注，赔率够");
      await settleAfter(table);

      const [stored] = await database.sql<{ visible_to: unknown; body: { text: string } }[]>`
        SELECT visible_to, body FROM messages WHERE id = ${answer}
      `;
      expect(stored?.body.text).toBe("跟注，赔率够");
      expect(stored?.visible_to).toEqual([{ kind: "user" }]);
    } finally {
      table.close();
    }
  });

  it("advisor 不能发 handoff，reviewer 不能发 bot_text，reviewer 的 run_done 照常收", async () => {
    const table = await makeTable();
    try {
      const advisorRun = await startedRun(table, 1, "advisor");
      table.agent.send({
        type: "handoff",
        runId: advisorRun,
        botId: table.bots[1].id,
        groupId: table.groupId,
        toBotId: table.bots[0].id,
        done: "a",
        notDone: "b",
        next: "c",
        checklistIndex: null,
      });
      table.agent.send({
        type: "run_done",
        runId: advisorRun,
        botId: table.bots[1].id,
        groupId: table.groupId,
        steps: 1,
        inputTokens: 0,
        outputTokens: 0,
      });
      await table.agent.ack(advisorRun);

      const reviewerRun = await startedRun(table, 1, "reviewer");
      const chatter = randomUUID() as MessageId;
      botText(table, reviewerRun, 1, chatter, "复盘我直接说了");
      table.agent.send({
        type: "run_done",
        runId: reviewerRun,
        botId: table.bots[1].id,
        groupId: table.groupId,
        steps: 1,
        inputTokens: 0,
        outputTokens: 0,
      });
      await table.agent.ack(reviewerRun);

      const rows = await storedMessages(table.groupId);
      expect(rows.map((row) => row.kind)).not.toContain("handoff");
      expect(rows.map((row) => row.id)).not.toContain(chatter);
      const [ended] = await database.sql<{ count: string }[]>`
        SELECT count(*) FROM runs WHERE id IN (${advisorRun}, ${reviewerRun}) AND ended_at IS NOT NULL
      `;
      expect(ended?.count).toBe("2");
    } finally {
      table.close();
    }
  });

  it("非表桌 run 的上行行为和以前一致", async () => {
    const table = await makeTable();
    try {
      const runId = await plainRun(table, 0);
      const said = randomUUID() as MessageId;
      botText(table, runId, 0, said, "普通 run 照常说话");
      table.agent.send({
        type: "approval_request",
        runId,
        botId: table.bots[0].id,
        groupId: table.groupId,
        callId: "call-plain",
        tool: "bash",
        action: "shell",
        target: null,
        view: { kind: "bash", command: "ls" },
      });
      const pushes = await settleAfter(table);

      const [stored] = await database.sql<{ visible_to: unknown; body: { text: string } }[]>`
        SELECT visible_to, body FROM messages WHERE id = ${said}
      `;
      expect(stored?.body.text).toBe("普通 run 照常说话");
      expect(stored?.visible_to).toBeNull();
      expect(pushes.some((push) => push.type === "message_delta" && push.messageId === said)).toBe(true);
      const [approvals] = await database.sql<
        { count: string }[]
      >`SELECT count(*) FROM approvals WHERE run_id = ${runId}`;
      expect(approvals?.count).toBe("1");
    } finally {
      table.close();
    }
  });
});
