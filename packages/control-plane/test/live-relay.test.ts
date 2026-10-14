import { randomBytes, randomUUID } from "node:crypto";
import {
  BotId,
  decodeLive,
  encodeLive,
  GroupId,
  LiveId,
  LiveSessionsResponse,
  LiveToViewer,
  LiveViewerClose,
  type LiveAnnounce,
  type LiveDown,
  type LiveFromViewer,
  type LiveInput,
  type LiveSession,
  type ServerPush,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { bytesOf } from "../src/live/relay.js";
import { ensureComputer } from "../src/repo/computers.js";
import * as toolsRepo from "../src/repo/tools.js";
import { expectHello, helloAgent, openAgent, sendHello, type AgentClient } from "./helpers/agent.js";
import { startTestServer, type ApiClient, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { makeComputer, makeUser, PASSWORD, type TestComputer } from "./helpers/fixtures.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

const INPUT_PER_SECOND = 120;

let database: TestDb;
let server: TestServer;
/** 输入限额的时钟。除了数限额那条，别的用例都不动它。 */
let clock = 1_000_000;

beforeAll(async () => {
  database = await createTestDb();
  server = await startTestServer(database.db, {}, undefined, undefined, undefined, {
    live: { inputPerSecond: INPUT_PER_SECOND, now: () => clock },
  });
});

afterAll(async () => {
  await server.close();
  await database.close();
});

type Owner = {
  readonly client: ApiClient;
  readonly computer: TestComputer;
  readonly agent: AgentClient;
  readonly push: PushClient;
};

/** 登录、电脑握手完、网页推送连上。推送在握手之后才连，握手时的推送不会混进来。 */
async function onlineOwner(): Promise<Owner> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  const push = await connectPush(server.server.port, cookieOf(client));
  return { client, computer, agent, push };
}

function cookieOf(client: ApiClient): string {
  if (client.cookie === null) throw new Error("还没登录");
  return client.cookie;
}

function announce(origin: string | null = "https://www.xiaohongshu.com"): LiveAnnounce {
  return {
    liveId: LiveId.parse(randomUUID()),
    purpose: {
      kind: "takeover",
      botId: BotId.parse(randomUUID()),
      groupId: GroupId.parse(randomUUID()),
      reason: "要扫码登录",
    },
    origin,
  };
}

function report(agent: AgentClient, session: LiveAnnounce): void {
  agent.sendLive(encodeLive({ t: "session", session }));
}

/** 报会话，等网页收到 live_session。 */
async function reported(owner: Owner, session: LiveAnnounce = announce()): Promise<LiveSession> {
  report(owner.agent, session);
  const pushed = await owner.push.next();
  const expected: LiveSession = { ...session, computerId: owner.computer.computerId };
  expect(pushed).toEqual({ type: "live_session", session: expected });
  return expected;
}

function frame(liveId: LiveId, size = 64 * 1024): Uint8Array {
  return encodeLive({ t: "frame", liveId }, randomBytes(size));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

/** 跳过跟画面无关的推送（握手、上下线），拿下一条 live_session 或 live_closed。 */
async function nextLivePush(push: PushClient): Promise<ServerPush> {
  for (;;) {
    const next = await push.next();
    if (next.type === "live_session" || next.type === "live_closed") return next;
  }
}

/** 先进先出的等待队列，测试里收帧和收关闭码共用。 */
function mailbox<T>(what: string) {
  const items: T[] = [];
  const waiters: ((item: T) => void)[] = [];
  return {
    put(item: T): void {
      const waiter = waiters.shift();
      if (waiter === undefined) items.push(item);
      else waiter(item);
    },
    take(timeoutMs = 5000): Promise<T> {
      return new Promise((resolve, reject) => {
        const buffered = items.shift();
        if (buffered !== undefined) {
          resolve(buffered);
          return;
        }
        const waiter = (item: T) => {
          clearTimeout(timer);
          resolve(item);
        };
        const timer = setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at !== -1) waiters.splice(at, 1);
          reject(new Error(`等${what}超时`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

type ViewerFrame = { readonly header: LiveToViewer; readonly bytes: Uint8Array };
type Viewer = {
  readonly socket: WebSocket;
  next(): Promise<ViewerFrame>;
  send(header: LiveFromViewer): void;
  sendRaw(data: Uint8Array | string): void;
  closed(): Promise<number>;
};

function viewerUrl(liveId: string): string {
  return `ws://localhost:${server.server.port}/api/live/${liveId}`;
}

/** 扮演网页看画面。只通过 /api/live/<id> 这条 WebSocket 碰控制面。 */
async function openViewer(client: ApiClient, liveId: string, origin?: string): Promise<Viewer> {
  const socket = new WebSocket(viewerUrl(liveId), {
    headers: { cookie: cookieOf(client) },
    ...(origin === undefined ? {} : { origin }),
  });
  const frames = mailbox<ViewerFrame>("观看者收帧");
  const close = mailbox<number>("观看者的 socket 关闭");
  socket.on("message", (raw, isBinary) => {
    if (!isBinary) throw new Error("看画面的 socket 只该收到二进制帧");
    const bytes = new Uint8Array(bytesOf(raw));
    const decoded = decodeLive(LiveToViewer, bytes);
    if (decoded === null) throw new Error("控制面发给观看者的帧不合 LiveToViewer");
    frames.put({ header: decoded.header, bytes });
  });
  socket.on("close", (code) => close.put(code));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return {
    socket,
    next: () => frames.take(),
    send: (header) => socket.send(encodeLive(header)),
    sendRaw: (data) => socket.send(data),
    closed: () => close.take(),
  };
}

/** 连上并收到会话：控制面挂上观看者之后第一件事就是把会话发给他。 */
async function watching(client: ApiClient, session: LiveSession): Promise<Viewer> {
  const viewer = await openViewer(client, session.liveId);
  expect((await viewer.next()).header).toEqual({ t: "session", session });
  return viewer;
}

function rejectedStatus(liveId: string, headers: { cookie?: string; origin?: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(viewerUrl(liveId), {
      headers: headers.cookie === undefined ? {} : { cookie: headers.cookie },
      ...(headers.origin === undefined ? {} : { origin: headers.origin }),
    });
    socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    socket.once("open", () => reject(new Error("握手本应被拒绝")));
    socket.once("error", reject);
  });
}

function viewerState(liveId: LiveId, state: "attached" | "detached"): LiveDown {
  return { t: "viewer", liveId, state };
}

/** 收电脑的画面下行直到 reveal 哨兵（含）。哨兵前面的就是这段时间控制面发给电脑的全部画面帧。 */
async function liveUntilReveal(agent: AgentClient): Promise<LiveDown[]> {
  const received: LiveDown[] = [];
  for (;;) {
    const next = await agent.nextLive();
    received.push(next);
    if (next.t === "reveal") return received;
  }
}

const KEY_INPUT: LiveInput = {
  kind: "key",
  phase: "down",
  key: "a",
  code: "KeyA",
  keyCode: 65,
  text: "a",
  modifiers: 0,
};

function rawFrame(header: unknown): Uint8Array {
  const json = Buffer.from(JSON.stringify(header));
  const out = Buffer.alloc(4 + json.length);
  out.writeUInt32BE(json.length, 0);
  json.copy(out, 4);
  return out;
}

async function tableCounts(): Promise<Record<string, number>> {
  const tables = await database.sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  const counts: Record<string, number> = {};
  for (const { table_name: table } of tables) {
    const [row] = await database.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${database.sql(table)}`;
    counts[table] = row?.n ?? -1;
  }
  return counts;
}

describe("画面面：会话登记和列表", () => {
  it("电脑报的会话推 live_session，computerId 取自连接；GET /api/live 只列自己的", async () => {
    const owner = await onlineOwner();
    const other = await onlineOwner();
    const session = await reported(owner);

    const mine = LiveSessionsResponse.parse(await (await owner.client.get("/api/live")).json());
    expect(mine.sessions).toEqual([session]);
    const theirs = LiveSessionsResponse.parse(await (await other.client.get("/api/live")).json());
    expect(theirs.sessions).toEqual([]);
  });

  it("同一个会话重报是整份 upsert：推新的一份，列表里只有一条", async () => {
    const owner = await onlineOwner();
    const first = await reported(owner, announce(null));
    const moved = await reported(owner, { ...announce(), liveId: first.liveId });

    const listed = LiveSessionsResponse.parse(await (await owner.client.get("/api/live")).json());
    expect(listed.sessions).toEqual([moved]);
  });

  it("没登录不能拉列表", async () => {
    expect((await server.client().get("/api/live")).status).toBe(401);
  });
});

describe("画面面：看画面", () => {
  it("连上之后电脑收到 viewer attached；电脑的 frame 逐字节原样到观看者", async () => {
    const owner = await onlineOwner();
    const session = await reported(owner);
    const viewer = await watching(owner.client, session);
    expect(await owner.agent.nextLive()).toEqual(viewerState(session.liveId, "attached"));

    const sent = frame(session.liveId, 300 * 1024);
    owner.agent.sendLive(sent);
    const received = await viewer.next();
    expect(received.header).toEqual({ t: "frame", liveId: session.liveId });
    expect(sameBytes(received.bytes, sent), "转给观看者的帧应和电脑发的逐字节相等").toBe(true);
  });

  it("观看者的输入、结束、看密码原样转给电脑；坏帧、文本帧、不合 schema 的帧静默丢", async () => {
    const owner = await onlineOwner();
    const session = await reported(owner);
    const viewer = await watching(owner.client, session);
    expect(await owner.agent.nextLive()).toEqual(viewerState(session.liveId, "attached"));

    viewer.sendRaw(randomBytes(32));
    viewer.sendRaw(JSON.stringify({ t: "reveal" }));
    viewer.sendRaw(rawFrame({ t: "input", input: { ...KEY_INPUT, text: "太长了的一段字" } }));
    viewer.sendRaw(rawFrame({ t: "input", liveId: session.liveId, input: KEY_INPUT }));

    const inputs: LiveInput[] = [
      { kind: "mouse", phase: "down", x: 0.25, y: 0.5, button: "left", clicks: 1, modifiers: 0 },
      { kind: "wheel", x: 0.5, y: 0.5, dx: 0, dy: -120, modifiers: 0 },
      KEY_INPUT,
      { kind: "text", text: "验证码 123456" },
    ];
    for (const input of inputs) viewer.send({ t: "input", input });
    viewer.send({ t: "end", action: "finish" });
    viewer.send({ t: "reveal" });

    expect(await liveUntilReveal(owner.agent)).toEqual([
      ...inputs.map((input) => ({ t: "input", liveId: session.liveId, input })),
      { t: "end", liveId: session.liveId, action: "finish" },
      { t: "reveal", liveId: session.liveId },
    ]);
  });

  it("同一会话来了第二个观看者：第一个 4101，电脑收到 detached 再 attached", async () => {
    const owner = await onlineOwner();
    const session = await reported(owner);
    const first = await watching(owner.client, session);
    expect(await owner.agent.nextLive()).toEqual(viewerState(session.liveId, "attached"));

    const second = await watching(owner.client, session);
    expect(await first.closed()).toBe(LiveViewerClose.replaced);
    second.send({ t: "reveal" });
    expect(await liveUntilReveal(owner.agent)).toEqual([
      viewerState(session.liveId, "detached"),
      viewerState(session.liveId, "attached"),
      { t: "reveal", liveId: session.liveId },
    ]);
  });

  it("同一台电脑另一个会话的观看者顶掉第一个：4101，电脑先收 A 的 detached 再收 B 的 attached", async () => {
    const owner = await onlineOwner();
    const a = await reported(owner);
    const b = await reported(owner);
    const first = await watching(owner.client, a);
    expect(await owner.agent.nextLive()).toEqual(viewerState(a.liveId, "attached"));

    const second = await watching(owner.client, b);
    expect(await first.closed()).toBe(LiveViewerClose.replaced);
    second.send({ t: "reveal" });
    expect(await liveUntilReveal(owner.agent)).toEqual([
      viewerState(a.liveId, "detached"),
      viewerState(b.liveId, "attached"),
      { t: "reveal", liveId: b.liveId },
    ]);

    // A 还在，只是没人看：它的帧不再转给任何人，B 的照转。
    owner.agent.sendLive(frame(a.liveId));
    const sent = frame(b.liveId);
    owner.agent.sendLive(sent);
    const received = await second.next();
    expect(sameBytes(received.bytes, sent), "B 的观看者只该收到 B 的帧").toBe(true);
  });

  it("两台电脑各有一个观看者，互不顶", async () => {
    const user = await makeUser(database.db);
    const local = await makeComputer(database.db, user.id);
    const remote = await ensureComputer(database.db, user.id, "remote");
    if (remote.token === null) throw new Error("远程电脑刚建，应拿得到 token");
    const client = server.client();
    expect((await client.login(user.email, PASSWORD)).status).toBe(200);
    const { agent: localAgent } = await helloAgent(server.server.port, local.computerId, local.token);
    const { agent: remoteAgent } = await helloAgent(server.server.port, remote.computer.id, remote.token);
    const push = await connectPush(server.server.port, cookieOf(client));

    const onLocal = announce();
    report(localAgent, onLocal);
    const onRemote = announce();
    report(remoteAgent, onRemote);
    const localSession: LiveSession = { ...onLocal, computerId: local.computerId };
    const remoteSession: LiveSession = { ...onRemote, computerId: remote.computer.id };
    // 两台电脑是两条 socket，谁先到不定。
    const pushed = [await nextLivePush(push), await nextLivePush(push)];
    expect(pushed).toEqual(
      expect.arrayContaining([
        { type: "live_session", session: localSession },
        { type: "live_session", session: remoteSession },
      ]),
    );

    const localViewer = await watching(client, localSession);
    const remoteViewer = await watching(client, remoteSession);
    localViewer.send({ t: "reveal" });
    remoteViewer.send({ t: "reveal" });
    expect(await liveUntilReveal(localAgent)).toEqual([
      viewerState(onLocal.liveId, "attached"),
      { t: "reveal", liveId: onLocal.liveId },
    ]);
    expect(await liveUntilReveal(remoteAgent)).toEqual([
      viewerState(onRemote.liveId, "attached"),
      { t: "reveal", liveId: onRemote.liveId },
    ]);

    const localFrame = frame(onLocal.liveId);
    localAgent.sendLive(localFrame);
    const remoteFrame = frame(onRemote.liveId);
    remoteAgent.sendLive(remoteFrame);
    expect(sameBytes((await localViewer.next()).bytes, localFrame)).toBe(true);
    expect(sameBytes((await remoteViewer.next()).bytes, remoteFrame)).toBe(true);
  });

  it("别人的会话、不存在的号、不合法的号一律 4104", async () => {
    const owner = await onlineOwner();
    const stranger = await onlineOwner();
    const session = await reported(owner);

    for (const liveId of [session.liveId, randomUUID(), "not-a-live-id"]) {
      const viewer = await openViewer(stranger.client, liveId);
      expect(await viewer.closed(), `${liveId} 应回 notFound`).toBe(LiveViewerClose.notFound);
    }
    // 被拒的那几次没打扰到电脑：它收到的下一条画面下行是真正挂上的观看者。
    await watching(owner.client, session);
    expect(await owner.agent.nextLive()).toEqual(viewerState(session.liveId, "attached"));
  });

  it("Origin 的 host 不等于 Host 时 403（先于认人）；没登录 401；同源放行", async () => {
    const owner = await onlineOwner();
    const session = await reported(owner);
    const cookie = cookieOf(owner.client);

    expect(await rejectedStatus(session.liveId, { cookie, origin: "https://evil.example" })).toBe(403);
    expect(await rejectedStatus(session.liveId, { cookie, origin: `http://localhost:${server.server.port + 1}` })).toBe(
      403,
    );
    expect(await rejectedStatus(session.liveId, { cookie, origin: "null" })).toBe(403);
    expect(await rejectedStatus(session.liveId, { origin: "https://evil.example" })).toBe(403);
    expect(await rejectedStatus(session.liveId, {})).toBe(401);

    const viewer = await openViewer(owner.client, session.liveId, `http://localhost:${server.server.port}`);
    expect((await viewer.next()).header).toEqual({ t: "session", session });
  });
});

describe("画面面：结束", () => {
  it("电脑报 closed：观看者 4100，网页收到 live_closed，列表里没了", async () => {
    const owner = await onlineOwner();
    const session = await reported(owner);
    const viewer = await watching(owner.client, session);

    owner.agent.sendLive(encodeLive({ t: "closed", liveId: session.liveId }));
    expect(await viewer.closed()).toBe(LiveViewerClose.gone);
    expect(await owner.push.next()).toEqual({ type: "live_closed", liveId: session.liveId });
    const listed = LiveSessionsResponse.parse(await (await owner.client.get("/api/live")).json());
    expect(listed.sessions).toEqual([]);
  });

  it("电脑断开：观看者 4100，网页先收到 live_closed，列表里没了", async () => {
    const owner = await onlineOwner();
    const session = await reported(owner);
    const viewer = await watching(owner.client, session);

    owner.agent.close();
    expect(await viewer.closed()).toBe(LiveViewerClose.gone);
    expect(await owner.push.next()).toEqual({ type: "live_closed", liveId: session.liveId });
    const listed = LiveSessionsResponse.parse(await (await owner.client.get("/api/live")).json());
    expect(listed.sessions).toEqual([]);
  });

  it("电脑重连后重报会话：观看者留着，新连接收到 viewer attached；旧连接断开只结束它没重报的那个", async () => {
    const owner = await onlineOwner();
    const kept = await reported(owner);
    const dropped = await reported(owner);
    const viewer = await watching(owner.client, kept);
    expect(await owner.agent.nextLive()).toEqual(viewerState(kept.liveId, "attached"));

    // 旧连接不读，控制面顶号时发的关闭帧就一直没人回，旧连接的 close 回调要等它恢复读才会到。
    owner.agent.socket.pause();
    const { agent: reconnected } = await helloAgent(
      server.server.port,
      owner.computer.computerId,
      owner.computer.token,
    );
    const moved: LiveAnnounce = {
      liveId: kept.liveId,
      purpose: kept.purpose,
      origin: "https://www.xiaohongshu.com/explore",
    };
    report(reconnected, moved);
    const movedSession: LiveSession = { ...moved, computerId: owner.computer.computerId };
    expect(await nextLivePush(owner.push)).toEqual({ type: "live_session", session: movedSession });
    expect((await viewer.next()).header).toEqual({ t: "session", session: movedSession });
    expect(await reconnected.nextLive()).toEqual(viewerState(kept.liveId, "attached"));

    owner.agent.socket.resume();
    expect(await nextLivePush(owner.push), "旧连接断开只结束没被重报的会话").toEqual({
      type: "live_closed",
      liveId: dropped.liveId,
    });
    const listed = LiveSessionsResponse.parse(await (await owner.client.get("/api/live")).json());
    expect(listed.sessions).toEqual([movedSession]);
    const sent = frame(kept.liveId);
    reconnected.sendLive(sent);
    expect(sameBytes((await viewer.next()).bytes, sent), "观看者还连着，新连接的帧照转").toBe(true);
  });
});

describe("画面面：和 hub 的接线", () => {
  it("握手前的二进制帧直接丢，握手照常完成", async () => {
    const user = await makeUser(database.db);
    const computer = await makeComputer(database.db, user.id);
    const client = server.client();
    expect((await client.login(user.email, PASSWORD)).status).toBe(200);
    const push = await connectPush(server.server.port, cookieOf(client));

    const agent = await openAgent(server.server.port);
    const early = announce();
    report(agent, early);
    sendHello(agent, computer.computerId, computer.token);
    await expectHello(agent);

    const late = announce();
    report(agent, late);
    expect(await nextLivePush(push), "握手前报的会话不该登记").toEqual({
      type: "live_session",
      session: { ...late, computerId: computer.computerId },
    });
    const listed = LiveSessionsResponse.parse(await (await client.get("/api/live")).json());
    expect(listed.sessions.map((session) => session.liveId)).toEqual([late.liveId]);
  });

  it("welcome 之后、config 之前报的会话照样登记，观看者也挂得上", async () => {
    const user = await makeUser(database.db);
    const computer = await makeComputer(database.db, user.id);
    const client = server.client();
    expect((await client.login(user.email, PASSWORD)).status).toBe(200);
    const push = await connectPush(server.server.port, cookieOf(client));

    // 把 hello 卡在 config 的第一批查询里：这时连接已入表、welcome 已发，hub 闭包里的 conn 还是 null。
    const original = toolsRepo.listToolConfigs;
    let reached!: () => void;
    const atGate = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const spy = vi.spyOn(toolsRepo, "listToolConfigs").mockImplementation(async (...args) => {
      reached();
      await gate;
      return original(...args);
    });
    const agent = await openAgent(server.server.port);
    try {
      sendHello(agent, computer.computerId, computer.token);
      await agent.expect("welcome");
      await atGate;

      const session = announce();
      report(agent, session);
      const expected: LiveSession = { ...session, computerId: computer.computerId };
      expect(await nextLivePush(push)).toEqual({ type: "live_session", session: expected });
      await watching(client, expected);
      expect(await agent.nextLive()).toEqual(viewerState(session.liveId, "attached"));
      expect(agent.received(), "这时 config 还没发").toEqual([]);
    } finally {
      release();
      spy.mockRestore();
    }
    expect((await agent.next()).type).toBe("config");
  });
});

describe("画面面：限额和不落库", () => {
  it("时钟不动时一口气 500 条输入只转 120 条，时钟走一秒再放 120 条", async () => {
    const owner = await onlineOwner();
    const session = await reported(owner);
    const viewer = await watching(owner.client, session);
    expect(await owner.agent.nextLive()).toEqual(viewerState(session.liveId, "attached"));

    const burst = async (): Promise<number> => {
      for (let index = 0; index < 500; index += 1) viewer.send({ t: "input", input: KEY_INPUT });
      viewer.send({ t: "reveal" });
      const received = await liveUntilReveal(owner.agent);
      return received.filter((item) => item.t === "input").length;
    };
    expect(await burst()).toBe(INPUT_PER_SECOND);
    expect(await burst(), "时钟没走，桶里一条都没回填").toBe(0);
    clock += 1000;
    expect(await burst()).toBe(INPUT_PER_SECOND);
  });

  it("一整轮会话、观看、帧、输入、结束前后，public 下每张表的行数不变，输入不进日志", async () => {
    const owner = await onlineOwner();
    const secret = `密码-${randomUUID()}`;
    const spies = (["log", "info", "warn", "error"] as const).map((level) => vi.spyOn(console, level));
    try {
      const before = await tableCounts();
      expect(Object.keys(before)).toEqual(expect.arrayContaining(["agent_outbox", "messages", "computers"]));

      const session = await reported(owner);
      const viewer = await watching(owner.client, session);
      for (let index = 0; index < 3; index += 1) {
        const sent = frame(session.liveId);
        owner.agent.sendLive(sent);
        expect(sameBytes((await viewer.next()).bytes, sent)).toBe(true);
      }
      viewer.send({ t: "input", input: { kind: "text", text: secret } });
      viewer.sendRaw(rawFrame({ t: "input", input: { kind: "text", text: secret, extra: true } }));
      viewer.send({ t: "end", action: "finish" });
      viewer.send({ t: "reveal" });
      expect(await liveUntilReveal(owner.agent)).toEqual([
        viewerState(session.liveId, "attached"),
        { t: "input", liveId: session.liveId, input: { kind: "text", text: secret } },
        { t: "end", liveId: session.liveId, action: "finish" },
        { t: "reveal", liveId: session.liveId },
      ]);
      owner.agent.sendLive(encodeLive({ t: "closed", liveId: session.liveId }));
      expect(await viewer.closed()).toBe(LiveViewerClose.gone);
      expect(await owner.push.next()).toEqual({ type: "live_closed", liveId: session.liveId });

      expect(await tableCounts()).toEqual(before);
      const logged = spies.flatMap((spy) => spy.mock.calls.flat().map((arg) => String(arg)));
      expect(logged.filter((line) => line.includes(secret))).toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
