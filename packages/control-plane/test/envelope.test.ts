import {
  AccountId,
  AgentCloseCode,
  ControlToAgent,
  CreateBotResponse,
  DownlinkFrame,
  MessageId,
  MessageListResponse,
  UplinkAck,
  type ComputerId,
  type RunId,
  type AgentToControl,
  type BotId,
  type GroupId,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { helloAgent, openAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, TEST_CREDENTIALS_KEY, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, waitFor } from "./helpers/fixtures.js";
import { DEFAULT_RUNTIME_CONFIG, startServer } from "../src/server.js";
import { AGENT_PATH } from "../src/agent/hub.js";
import { gatedDb } from "./helpers/gated-db.js";

type RawMessage = ControlToAgent | DownlinkFrame | UplinkAck;
type RawAgent = {
  readonly socket: WebSocket;
  readonly welcome: Extract<ControlToAgent, { type: "welcome" }>;
  next<T extends RawMessage["type"]>(type: T, timeoutMs?: number): Promise<Extract<RawMessage, { type: T }>>;
  sendBare(body: Extract<AgentToControl, { type: "downlink_ack" | "bot_text" }>): void;
  sendReliable(seq: number, body: AgentToControl): void;
  close(): void;
};

async function rawHello(
  port: number,
  computerId: ComputerId,
  token: string,
  downApplied = 0,
  activeRuns: readonly RunId[] = [],
  stream = computerId as string,
): Promise<RawAgent> {
  const socket = new WebSocket(`ws://localhost:${port}${AGENT_PATH}`);
  const inbox: RawMessage[] = [];
  const waiters: {
    type: RawMessage["type"];
    resolve: (message: RawMessage) => void;
    reject: (error: Error) => void;
  }[] = [];
  socket.on("message", (raw) => {
    const value: unknown = JSON.parse(raw.toString());
    const message =
      typeof value === "object" && value !== null && "type" in value && value.type === "uplink_ack"
        ? UplinkAck.parse(value)
        : typeof value === "object" && value !== null && "type" in value && value.type === "downlink"
          ? DownlinkFrame.parse(value)
          : ControlToAgent.parse(value);
    const waiter = waiters.find((entry) => entry.type === message.type);
    if (waiter === undefined) inbox.push(message);
    else {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const next = <T extends RawMessage["type"]>(
    type: T,
    timeoutMs = 5_000,
  ): Promise<Extract<RawMessage, { type: T }>> => {
    const buffered = inbox.find((message) => message.type === type);
    if (buffered !== undefined) {
      inbox.splice(inbox.indexOf(buffered), 1);
      return Promise.resolve(buffered as Extract<RawMessage, { type: T }>);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        type,
        resolve: (message: RawMessage) => {
          clearTimeout(timer);
          resolve(message as Extract<RawMessage, { type: T }>);
        },
        reject,
      };
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        reject(new Error(`等待 ${type} 超时`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
  socket.send(
    JSON.stringify({
      type: "hello",
      computerId,
      token,
      version: "test",
      protocol: 2,
      uplinkStream: stream,
      downApplied,
      activeRuns,
    }),
  );
  const welcome = await next("welcome");
  const config = await next("config");
  for (const bot of config.bots) {
    const state = await next("resume").catch(() => next("pause"));
    if (state.botId !== bot.id) throw new Error(`运行状态 botId 不匹配: ${state.botId}`);
  }
  return {
    socket,
    welcome,
    next,
    sendBare: (body) => socket.send(JSON.stringify({ conn: welcome.conn, body })),
    sendReliable: (seq, body) =>
      socket.send(
        JSON.stringify({
          type: "uplink",
          conn: welcome.conn,
          stream,
          seq,
          body,
        }),
      ),
    close: () => socket.close(),
  };
}

let database: TestDb;
let server: TestServer;

beforeAll(async () => {
  database = await createTestDb();
  const running = await startServer({
    db: database.db,
    port: 0,
    toolSecretKey: "a".repeat(64),
    credentialsKey: TEST_CREDENTIALS_KEY,
    config: DEFAULT_RUNTIME_CONFIG,
    disconnectGraceMs: 1_000,
  });
  server = { server: running, client: () => new ApiClient(running.port), close: () => running.close() };
});

afterAll(async () => {
  await server.close();
  await database.close();
});

async function owner() {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小服" })).json());
  return { client, computer, botId: created.bot.id, groupId: created.group.id };
}

async function startRun(client: ApiClient, groupId: GroupId, agent: AgentClient): Promise<RunId> {
  expect((await client.post(`/api/groups/${groupId}/messages`, { text: "做这件事" })).status).toBe(201);
  return (await agent.expect("prompt")).runId;
}

function watchAcks(agent: AgentClient): {
  next(seq: number, afterCount?: number, timeoutMs?: number): Promise<UplinkAck>;
} {
  const seen: UplinkAck[] = [];
  const waiters: { readonly seq: number; resolve: (ack: UplinkAck) => void }[] = [];
  agent.socket.on("message", (raw) => {
    const value: unknown = JSON.parse(raw.toString());
    if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "uplink_ack") return;
    const ack = UplinkAck.parse(value);
    seen.push(ack);
    for (const waiter of waiters.toReversed()) {
      if (ack.upTo < waiter.seq) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(ack);
    }
  });
  return {
    next: (seq, afterCount = 0, timeoutMs = 5_000) => {
      const buffered = seen.slice(afterCount).find((ack) => ack.upTo >= seq);
      if (buffered !== undefined) return Promise.resolve(buffered);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const waiter = waiters.find((entry) => entry.seq === seq);
          if (waiter === undefined) return;
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error(`等上行累计确认 ${seq} 超时`));
        }, timeoutMs);
        const waiter = {
          seq,
          resolve: (ack: UplinkAck) => {
            clearTimeout(timer);
            resolve(ack);
          },
        };
        waiters.push(waiter);
      });
    },
  };
}

function sendFrame(
  agent: AgentClient,
  computerId: ComputerId,
  conn: number,
  seq: number,
  body: AgentToControl | Record<string, unknown>,
): void {
  agent.socket.send(JSON.stringify({ type: "uplink", conn, stream: computerId, seq, body }));
}

const runDone = (runId: RunId, botId: BotId, groupId: GroupId): AgentToControl => ({
  type: "run_done",
  runId,
  botId,
  groupId,
  prompt: "entered",
  steps: 0,
  inputTokens: 0,
  outputTokens: 0,
});

const textDone = (
  runId: RunId,
  botId: BotId,
  groupId: GroupId,
  messageId: MessageId,
  text: string,
): AgentToControl => ({
  type: "bot_text_done",
  runId,
  botId,
  groupId,
  messageId,
  text,
});

describe("可靠信封", () => {
  it("同一上行帧重复到达只处理一次，仍累计确认", async () => {
    const s = await owner();
    const connected = await helloAgent(server.server.port, s.computer.computerId, s.computer.token);
    const runId = await startRun(s.client, s.groupId, connected.agent);
    const acks = watchAcks(connected.agent);
    const messageId = MessageId.parse("message-envelope-repeat");
    const body = textDone(runId, s.botId, s.groupId, messageId, "只落一次");
    const frame = JSON.stringify({
      type: "uplink",
      conn: connected.welcome.conn,
      stream: s.computer.computerId,
      seq: 1,
      body,
    });
    connected.agent.socket.send(frame);
    expect((await acks.next(1)).upTo).toBe(1);
    const before = MessageListResponse.parse(await (await s.client.get(`/api/groups/${s.groupId}/messages`)).json());
    const firstMessage = before.messages.find((message) => message.id === messageId);
    expect(firstMessage).toBeDefined();
    connected.agent.socket.send(frame);
    const duplicateAck = await acks.next(1, 1);
    expect(duplicateAck.upTo).toBe(1);
    const messages = MessageListResponse.parse(await (await s.client.get(`/api/groups/${s.groupId}/messages`)).json());
    expect(
      messages.messages.filter((message) => message.body.kind === "bot" && message.body.text === "只落一次"),
    ).toHaveLength(1);
    expect(messages.messages.find((message) => message.id === messageId)?.revision).toBe(firstMessage?.revision);
    connected.agent.close();
  });

  it("缺号关闭 1011，重连游标停在缺口之前", async () => {
    const s = await owner();
    const first = await helloAgent(server.server.port, s.computer.computerId, s.computer.token);
    sendFrame(first.agent, s.computer.computerId, first.welcome.conn, 2, {
      type: "login_state",
      accountId: AccountId.parse("missing-account"),
      state: { login: "expired" },
    });
    expect(await first.agent.closed()).toBe(1011);
    const second = await helloAgent(server.server.port, s.computer.computerId, s.computer.token);
    try {
      expect(second.welcome.upAcked).toBe(0);
    } finally {
      second.agent.close();
    }
  });

  it("毒帧两次失败后回 invalid 并推进游标，后续合法帧继续处理", async () => {
    const s = await owner();
    const connected = await helloAgent(server.server.port, s.computer.computerId, s.computer.token);
    const runId = await startRun(s.client, s.groupId, connected.agent);
    await database.sql.unsafe(`
      CREATE FUNCTION envelope_reject_poison() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.body->>'text' = '毒帧' THEN RAISE EXCEPTION 'injected envelope failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER envelope_reject_poison BEFORE INSERT ON messages
      FOR EACH ROW EXECUTE FUNCTION envelope_reject_poison()
    `);
    await database.sql.unsafe(`
      CREATE TRIGGER envelope_reject_poison_update BEFORE UPDATE ON messages
      FOR EACH ROW EXECUTE FUNCTION envelope_reject_poison()
    `);
    const acks = watchAcks(connected.agent);
    sendFrame(
      connected.agent,
      s.computer.computerId,
      connected.welcome.conn,
      1,
      textDone(runId, s.botId, s.groupId, MessageId.parse("message-poison"), "毒帧"),
    );
    const rejected = await acks.next(1);
    expect(rejected).toMatchObject({ upTo: 1, rejected: [{ seq: 1, code: "invalid" }] });
    sendFrame(connected.agent, s.computer.computerId, connected.welcome.conn, 2, {
      type: "bot_tool_call",
      runId,
      botId: s.botId,
      groupId: s.groupId,
      callId: "call-after-poison",
      tool: "bash",
      view: { kind: "bash", command: "true" },
      status: "ok",
      durationMs: 1,
    });
    expect((await acks.next(2)).upTo).toBe(2);
    connected.agent.close();
  });

  it("收尾 run 拒绝审批请求，但接收 run_done、定稿文字和工具结果", async () => {
    const s = await owner();
    const connected = await helloAgent(server.server.port, s.computer.computerId, s.computer.token);
    const runId = await startRun(s.client, s.groupId, connected.agent);
    const acks = watchAcks(connected.agent);
    sendFrame(connected.agent, s.computer.computerId, connected.welcome.conn, 1, runDone(runId, s.botId, s.groupId));
    await acks.next(1);
    sendFrame(connected.agent, s.computer.computerId, connected.welcome.conn, 2, {
      type: "approval_request",
      runId,
      botId: s.botId,
      groupId: s.groupId,
      callId: "closed-approval",
      tool: "bash",
      action: "shell",
      target: null,
      view: { kind: "bash", command: "false" },
    });
    expect((await acks.next(2)).rejected).toEqual([{ seq: 2, code: "run_closed", runId }]);
    sendFrame(connected.agent, s.computer.computerId, connected.welcome.conn, 3, runDone(runId, s.botId, s.groupId));
    expect((await acks.next(3)).rejected).toEqual([]);
    sendFrame(
      connected.agent,
      s.computer.computerId,
      connected.welcome.conn,
      4,
      textDone(runId, s.botId, s.groupId, MessageId.parse("closed-run-text"), "已收尾文字"),
    );
    expect((await acks.next(4)).rejected).toEqual([]);
    sendFrame(connected.agent, s.computer.computerId, connected.welcome.conn, 5, {
      type: "bot_tool_call",
      runId,
      botId: s.botId,
      groupId: s.groupId,
      callId: "closed-tool",
      tool: "bash",
      view: { kind: "bash", command: "true" },
      status: "ok",
      durationMs: 1,
    });
    expect((await acks.next(5)).rejected).toEqual([]);
    const approvals = await database.sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM approvals WHERE call_id = 'closed-approval'`;
    expect(approvals[0]?.count).toBe(0);
    connected.agent.close();
  });

  it("旧连接代际的帧不处理也不确认", async () => {
    const s = await owner();
    const current = await helloAgent(server.server.port, s.computer.computerId, s.computer.token);
    const acks = watchAcks(current.agent);
    sendFrame(current.agent, s.computer.computerId, current.welcome.conn - 1, 1, {
      type: "login_state",
      accountId: AccountId.parse("stale-account"),
      state: { login: "expired" },
    });
    const loginStateCount = async () => {
      const rows = await database.sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM accounts WHERE id = 'stale-account'`;
      return rows[0]?.count ?? 0;
    };
    expect(await loginStateCount()).toBe(0);
    await expect(acks.next(1, 0, 200)).rejects.toThrow("超时");
    current.agent.close();
  });

  it("旧代际的 downlink_ack 不推进游标也不清发件箱，超前确认也不生效，hello 游标会钳制", async () => {
    const s = await owner();
    const first = await rawHello(server.server.port, s.computer.computerId, s.computer.token);
    try {
      expect((await s.client.post(`/api/groups/${s.groupId}/messages`, { text: "待确认 prompt" })).status).toBe(201);
      const downlink = await first.next("downlink");
      if (downlink.body.type !== "prompt") throw new Error(`本应收到 prompt，实际是 ${downlink.body.type}`);
      const prompt = downlink.body;

      first.sendBare({ type: "downlink_ack", upTo: downlink.seq + 100 });
      first.sendReliable(1, {
        type: "bot_tool_call",
        runId: prompt.runId,
        botId: s.botId,
        groupId: s.groupId,
        callId: "oversized-down-ack-barrier",
        tool: "bash",
        view: { kind: "bash", command: "true" },
        status: "ok",
        durationMs: 1,
      });
      expect((await first.next("uplink_ack")).upTo).toBe(1);
      const beforeHello = await database.sql<{ down_seq: number; down_applied: number; outbox: number }[]>`
        SELECT c.down_seq, c.down_applied, count(o.seq)::int AS outbox
        FROM computers c LEFT JOIN agent_outbox o ON o.computer_id = c.id
        WHERE c.id = ${s.computer.computerId} GROUP BY c.id
      `;
      expect(beforeHello[0]).toMatchObject({ down_applied: 0, outbox: 1 });

      const second = await rawHello(server.server.port, s.computer.computerId, s.computer.token, 10_000, [
        prompt.runId,
      ]);
      try {
        const afterHello = await database.sql<{ down_seq: number; down_applied: number; outbox: number }[]>`
          SELECT c.down_seq, c.down_applied, count(o.seq)::int AS outbox
          FROM computers c LEFT JOIN agent_outbox o ON o.computer_id = c.id
          WHERE c.id = ${s.computer.computerId} GROUP BY c.id
        `;
        expect(afterHello[0]).toMatchObject({ down_applied: afterHello[0]?.down_seq, outbox: 0 });
      } finally {
        second.close();
      }
    } finally {
      first.close();
    }
  });

  it("新控制面接管后，旧控制面的 socket 不能处理或确认新代际之后的帧", async () => {
    const s = await owner();
    const old = await rawHello(server.server.port, s.computer.computerId, s.computer.token);
    const newerServer = await startServer({
      db: database.db,
      port: 0,
      toolSecretKey: "a".repeat(64),
      credentialsKey: TEST_CREDENTIALS_KEY,
      config: DEFAULT_RUNTIME_CONFIG,
      disconnectGraceMs: 1_000,
    });
    let current: RawAgent | undefined;
    try {
      expect((await s.client.post(`/api/groups/${s.groupId}/messages`, { text: "旧代际 pending prompt" })).status).toBe(
        201,
      );
      const oldDownlink = await old.next("downlink");
      if (oldDownlink.body.type !== "prompt") throw new Error("旧连接未收到 prompt");

      current = await rawHello(newerServer.port, s.computer.computerId, s.computer.token);
      const replayed = await current.next("downlink");
      expect(replayed).toMatchObject({ seq: oldDownlink.seq, body: { type: "prompt", runId: oldDownlink.body.runId } });
      const runId = oldDownlink.body.runId;
      const staleBareId = MessageId.parse("message-stale-old-bare");
      const staleReliableId = MessageId.parse("message-stale-old-reliable");

      old.sendBare({ type: "downlink_ack", upTo: oldDownlink.seq });
      old.sendBare({
        type: "bot_text",
        runId,
        botId: s.botId,
        groupId: s.groupId,
        messageId: staleBareId,
        delta: "旧连接文本",
        done: false,
      });
      old.sendReliable(1, textDone(runId, s.botId, s.groupId, staleReliableId, "旧连接定稿"));
      current.sendReliable(1, {
        type: "bot_tool_call",
        runId,
        botId: s.botId,
        groupId: s.groupId,
        callId: "new-connection-barrier",
        tool: "bash",
        view: { kind: "bash", command: "true" },
        status: "ok",
        durationMs: 1,
      });
      expect((await current.next("uplink_ack")).upTo).toBe(1);
      await expect(old.next("uplink_ack", 200)).rejects.toThrow("超时");

      const staleRows = await database.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM messages WHERE id IN (${staleBareId}, ${staleReliableId})
      `;
      const cursors = await database.sql<{ down_applied: number; outbox: number }[]>`
        SELECT c.down_applied, count(o.seq)::int AS outbox FROM computers c
        LEFT JOIN agent_outbox o ON o.computer_id = c.id WHERE c.id = ${s.computer.computerId} GROUP BY c.id
      `;
      expect(staleRows[0]?.count).toBe(0);
      expect(cursors[0]).toMatchObject({ down_applied: 0, outbox: 1 });
    } finally {
      old.close();
      current?.close();
      await newerServer.close();
    }
  });

  it("hello 按 welcome、config、运行状态、发件箱顺序重放，断线派活不丢不重", async () => {
    const s = await owner();
    const first = await helloAgent(server.server.port, s.computer.computerId, s.computer.token);
    first.agent.close();
    await first.agent.closed();
    expect((await s.client.post(`/api/bots/${s.botId}/pause`)).status).toBe(200);
    expect((await s.client.post(`/api/groups/${s.groupId}/messages`, { text: "离线派活一" })).status).toBe(201);
    expect((await s.client.post(`/api/groups/${s.groupId}/messages`, { text: "离线派活二" })).status).toBe(201);
    const queued = await database.sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM agent_outbox WHERE computer_id = ${s.computer.computerId}`;
    expect(queued[0]?.count).toBe(2);

    const resumed = await helloAgent(server.server.port, s.computer.computerId, s.computer.token);
    try {
      expect(resumed.welcome.upAcked).toBe(0);
      expect(resumed.runStates.map((message) => message.type)).toEqual(["resume", "pause"]);
      const prompts = [await resumed.agent.expect("prompt"), await resumed.agent.expect("prompt")];
      expect(prompts.map((message) => message.text)).toEqual(["离线派活一", "离线派活二"]);
      await expect(resumed.agent.expect("prompt", 100)).rejects.toThrow("超时");
      const lastPrompt = prompts[1];
      if (lastPrompt === undefined) throw new Error("第二条 prompt 未收到");
      const acks = watchAcks(resumed.agent);
      sendFrame(resumed.agent, s.computer.computerId, resumed.welcome.conn, 1, {
        type: "bot_tool_call",
        runId: lastPrompt.runId,
        botId: s.botId,
        groupId: s.groupId,
        callId: "replay-ack-barrier",
        tool: "bash",
        view: { kind: "bash", command: "true" },
        status: "ok",
        durationMs: 1,
      });
      expect((await acks.next(1)).upTo).toBe(1);
      const remaining = await database.sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM agent_outbox WHERE computer_id = ${s.computer.computerId}`;
      expect(remaining[0]?.count).toBe(0);
    } finally {
      resumed.agent.close();
    }
  });

  it("派活等电脑锁期间提交的新审批，锁后读范围并作废", async () => {
    const gated = gatedDb(database.sql);
    const running = await startServer({
      db: gated.db,
      port: 0,
      toolSecretKey: "a".repeat(64),
      credentialsKey: TEST_CREDENTIALS_KEY,
      config: DEFAULT_RUNTIME_CONFIG,
      approvalTimeoutIntervalMs: 24 * 60 * 60 * 1000,
    });
    const user = await makeUser(database.db);
    const computer = await makeComputer(database.db, user.id);
    const client = new ApiClient(running.port);
    await client.login(user.email, PASSWORD);
    const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "锁后读" })).json());
    const agent = await rawHello(running.port, computer.computerId, computer.token);
    let release: (() => void) | undefined;
    let posting: Promise<Response> | undefined;
    try {
      await client.post(`/api/groups/${created.group.id}/messages`, { text: "先跑一轮" });
      const first = await agent.next("downlink");
      if (first.body.type !== "prompt") throw new Error("没有初始 prompt");
      agent.sendBare({ type: "downlink_ack", upTo: first.seq });
      const gate = gated.arm(/from "computers" where[^]*for no key update/, "before");
      release = gate.release;
      posting = client.post(`/api/groups/${created.group.id}/messages`, { text: "换个做法" });
      await gate.reached;
      agent.sendReliable(1, {
        type: "approval_request",
        runId: first.body.runId,
        botId: created.bot.id,
        groupId: created.group.id,
        callId: "late-before-computer-lock",
        tool: "shop.refund",
        action: "spend",
        target: null,
        view: { kind: "mcp", server: "", tool: "shop.refund", params: [], raw: "退款" },
      });
      expect((await agent.next("uplink_ack")).upTo).toBe(1);
      const pending = MessageListResponse.parse(
        await (await client.get(`/api/groups/${created.group.id}/messages`)).json(),
      );
      expect(pending.approvals).toMatchObject([{ status: "pending" }]);
      gate.release();
      expect((await posting).status).toBe(201);
      const after = MessageListResponse.parse(
        await (await client.get(`/api/groups/${created.group.id}/messages`)).json(),
      );
      expect(after.approvals).toMatchObject([{ status: "voided" }]);
      const voided = await agent.next("downlink");
      const prompt = await agent.next("downlink");
      expect(voided.body).toMatchObject({
        type: "approval_result",
        outcome: "voided",
        callId: "late-before-computer-lock",
      });
      expect(prompt.body).toMatchObject({ type: "prompt", text: "换个做法" });
      expect(voided.seq).toBeLessThan(prompt.seq);
    } finally {
      release?.();
      await posting;
      agent.close();
      await running.close();
    }
  });

  it("run 已结束时，审批决定不把结果放进下行发件箱", async () => {
    const s = await owner();
    const agent = await rawHello(server.server.port, s.computer.computerId, s.computer.token);
    const delivered: DownlinkFrame[] = [];
    agent.socket.on("message", (raw) => {
      const parsed = DownlinkFrame.safeParse(JSON.parse(raw.toString()));
      if (parsed.success) delivered.push(parsed.data);
    });
    try {
      await s.client.post(`/api/groups/${s.groupId}/messages`, { text: "等审批" });
      const first = await agent.next("downlink");
      if (first.body.type !== "prompt") throw new Error("没有初始 prompt");
      agent.sendBare({ type: "downlink_ack", upTo: first.seq });
      agent.sendReliable(1, {
        type: "approval_request",
        runId: first.body.runId,
        botId: s.botId,
        groupId: s.groupId,
        callId: "closed-run-approval",
        tool: "shop.refund",
        action: "spend",
        target: null,
        view: { kind: "mcp", server: "", tool: "shop.refund", params: [], raw: "退款" },
      });
      await agent.next("uplink_ack");
      const page = MessageListResponse.parse(await (await s.client.get(`/api/groups/${s.groupId}/messages`)).json());
      const approval = page.approvals[0];
      if (approval === undefined) throw new Error("审批没落地");
      await database.sql`UPDATE runs SET ended_at = now() WHERE id = ${first.body.runId}`;
      delivered.length = 0;
      expect(
        (await s.client.post(`/api/approvals/${approval.id}`, { decision: "approved", scope: "once" })).status,
      ).toBe(200);
      await s.client.post(`/api/bots/${s.botId}/pause`);
      await agent.next("pause");
      expect(delivered).toEqual([]);
      const rows = await database.sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM agent_outbox WHERE computer_id = ${s.computer.computerId}`;
      expect(rows[0]?.count).toBe(0);
    } finally {
      agent.close();
    }
  });

  it("同一电脑换上行流后 welcome 游标归零，从序号 1 接收", async () => {
    const s = await owner();
    const first = await rawHello(server.server.port, s.computer.computerId, s.computer.token);
    first.sendReliable(1, { type: "agent_error", code: "config_rejected", detail: "流一" });
    expect((await first.next("uplink_ack")).upTo).toBe(1);
    first.close();
    const fresh = await rawHello(
      server.server.port,
      s.computer.computerId,
      s.computer.token,
      0,
      [],
      "replacement-uplink-stream",
    );
    try {
      expect(fresh.welcome.upAcked).toBe(0);
      fresh.sendReliable(1, { type: "agent_error", code: "config_rejected", detail: "新流" });
      expect((await fresh.next("uplink_ack")).upTo).toBe(1);
    } finally {
      fresh.close();
    }
  });

  it("作废和新 prompt 同事务入队：派活回滚不泄漏结论，成功后 voided 序号在前", async () => {
    const s = await owner();
    const agent = await rawHello(server.server.port, s.computer.computerId, s.computer.token);
    const received: RawMessage[] = [];
    agent.socket.on("message", (raw) => {
      const value: unknown = JSON.parse(raw.toString());
      const frame = DownlinkFrame.safeParse(value);
      if (frame.success) received.push(frame.data);
      else {
        const bare = ControlToAgent.safeParse(value);
        if (bare.success) received.push(bare.data);
      }
    });
    const removeFailure = () =>
      database.sql.unsafe(
        "DROP TRIGGER IF EXISTS envelope_reject_prompt ON agent_outbox; DROP FUNCTION IF EXISTS envelope_reject_prompt();",
      );
    try {
      expect((await s.client.post(`/api/groups/${s.groupId}/messages`, { text: "先等审批" })).status).toBe(201);
      const initial = await agent.next("downlink");
      if (initial.body.type !== "prompt") throw new Error("没收到初始 prompt");
      const runId = initial.body.runId;
      agent.sendBare({ type: "downlink_ack", upTo: initial.seq });
      agent.sendReliable(1, {
        type: "approval_request",
        runId,
        botId: s.botId,
        groupId: s.groupId,
        callId: "call-atomic-void",
        tool: "shop.refund",
        action: "spend",
        target: null,
        view: { kind: "mcp", server: "", tool: "shop.refund", params: [], raw: "退款" },
      });
      expect((await agent.next("uplink_ack")).upTo).toBe(1);
      const before = MessageListResponse.parse(await (await s.client.get(`/api/groups/${s.groupId}/messages`)).json());
      expect(before.approvals).toMatchObject([{ runId, status: "pending" }]);
      await database.sql.unsafe(`
        CREATE FUNCTION envelope_reject_prompt() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION '测试钩子：prompt 入队失败'; END $$ LANGUAGE plpgsql;
        CREATE TRIGGER envelope_reject_prompt BEFORE INSERT ON agent_outbox
        FOR EACH ROW WHEN (NEW.body->>'type' = 'prompt') EXECUTE FUNCTION envelope_reject_prompt();
      `);
      received.length = 0;
      expect((await s.client.post(`/api/groups/${s.groupId}/messages`, { text: "这次派活回滚" })).status).toBe(201);
      expect((await s.client.post(`/api/bots/${s.botId}/pause`)).status).toBe(200);
      await agent.next("pause");
      const rolledBack = MessageListResponse.parse(
        await (await s.client.get(`/api/groups/${s.groupId}/messages`)).json(),
      );
      expect(rolledBack.approvals, "prompt 入队失败，审批仍待批").toMatchObject([
        { runId, status: "pending", decidedAt: null },
      ]);
      expect(
        received.filter((message) => message.type === "downlink" || message.type === "approval_result"),
        "事务提交前不能给电脑泄漏作废结论",
      ).toEqual([]);
      await removeFailure();
      expect((await s.client.post(`/api/groups/${s.groupId}/messages`, { text: "成功的新活" })).status).toBe(201);
      const voided = await agent.next("downlink");
      const prompt = await agent.next("downlink");
      expect(voided.body).toMatchObject({
        type: "approval_result",
        runId,
        callId: "call-atomic-void",
        outcome: "voided",
      });
      expect(prompt.body).toMatchObject({ type: "prompt", text: "成功的新活" });
      expect(prompt.seq, "同一电脑作废先于新活").toBe(voided.seq + 1);
      const committed = MessageListResponse.parse(
        await (await s.client.get(`/api/groups/${s.groupId}/messages`)).json(),
      );
      expect(committed.approvals).toMatchObject([{ runId, status: "voided" }]);
    } finally {
      await removeFailure();
      agent.close();
    }
  });

  it("run 因断线被放弃时，同一事务清掉它的 prompt 发件箱行", async () => {
    const s = await owner();
    const connected = await helloAgent(server.server.port, s.computer.computerId, s.computer.token);
    connected.agent.close();
    await connected.agent.closed();
    expect((await s.client.post(`/api/groups/${s.groupId}/messages`, { text: "等待收尾" })).status).toBe(201);
    const queued = await database.sql<
      { id: string }[]
    >`SELECT run_id AS id FROM agent_outbox WHERE computer_id = ${s.computer.computerId} AND run_id IS NOT NULL`;
    expect(queued).toHaveLength(1);
    const runId = queued[0]?.id;
    if (runId === undefined) throw new Error("prompt 没进发件箱");
    await waitFor(async () => {
      const rows = await database.sql<{ ended_at: Date | null }[]>`SELECT ended_at FROM runs WHERE id = ${runId}`;
      return rows[0]?.ended_at !== null && rows[0] !== undefined;
    }, "run 在断线宽限后收尾");
    const leftover = await database.sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM agent_outbox WHERE run_id = ${runId}`;
    expect(leftover[0]?.count).toBe(0);
  });

  it("4004 顶号会清空本机电脑的发件箱", async () => {
    const s = await owner();
    const connected = await helloAgent(server.server.port, s.computer.computerId, s.computer.token);
    connected.agent.close();
    await connected.agent.closed();
    expect((await s.client.post(`/api/groups/${s.groupId}/messages`, { text: "待顶号清理" })).status).toBe(201);
    const before = await database.sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM agent_outbox WHERE computer_id = ${s.computer.computerId}`;
    expect(before[0]?.count).toBe(1);
    expect((await s.client.post("/api/computers/local", { confirmDisplace: true })).status).toBe(200);
    const after = await database.sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM agent_outbox WHERE computer_id = ${s.computer.computerId}`;
    expect(after[0]?.count).toBe(0);
  });

  it("缺少 protocol 或 protocol 1 的 hello 都以 4003 拒绝", async () => {
    const s = await owner();
    for (const protocol of [undefined, 1]) {
      const agent = await openAgent(server.server.port);
      const hello = {
        type: "hello",
        computerId: s.computer.computerId,
        token: s.computer.token,
        version: "old",
        uplinkStream: s.computer.computerId,
        downApplied: 0,
        activeRuns: [],
        ...(protocol === undefined ? {} : { protocol }),
      };
      agent.socket.send(JSON.stringify(hello));
      expect(await agent.closed()).toBe(AgentCloseCode.upgradeRequired);
      expect(agent.received()).toEqual([]);
    }
  });

  it("hello 报告的 activeRuns 中已有收尾 run 时收到 cancel", async () => {
    const s = await owner();
    const first = await helloAgent(server.server.port, s.computer.computerId, s.computer.token);
    const runId = await startRun(s.client, s.groupId, first.agent);
    const acks = watchAcks(first.agent);
    sendFrame(first.agent, s.computer.computerId, first.welcome.conn, 1, runDone(runId, s.botId, s.groupId));
    await acks.next(1);
    first.agent.close();
    await first.agent.closed();

    const reconnected = await helloAgent(server.server.port, s.computer.computerId, s.computer.token, [runId]);
    try {
      expect(await reconnected.agent.expect("cancel")).toMatchObject({ runId });
    } finally {
      reconnected.agent.close();
    }
  });
});
