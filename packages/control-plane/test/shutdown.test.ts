import type { ComputerId } from "@baize/shared";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import * as events from "../src/agent/events.js";
import { computers } from "../src/db/schema.js";
import * as computersRepo from "../src/repo/computers.js";
import { helloAgent, openAgent, sendHello, type AgentClient } from "./helpers/agent.js";
import { startTestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { makeComputer, makeUser, PASSWORD } from "./helpers/fixtures.js";
import { gatedDb } from "./helpers/gated-db.js";
import { connectPush } from "./helpers/ws.js";

/**
 * 停机的收敛契约：closeAll 返回之后，这台控制面手里的电脑在库里都是休眠，没有一条 socket 还开着，
 * 认身份在链外、停机期间才回来的 hello 不能上线；停机前已经收下的帧照常做完，停机后收到的帧丢掉，所以停机有限步返回。
 * 等异步效果都靠查询屏障、spy 和 ping/pong，不靠超时。
 */

const SERVICE_RESTART = 1012;
const BATCH_SLEEP = /^update "computers" set "status".*"computers"\."id" in \(/;
const HEARTBEAT = /"last_seen_at"/;

async function stack() {
  const database = await createTestDb();
  const gated = gatedDb(database.sql);
  const server = await startTestServer(gated.db);
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const status = async (computerId: ComputerId = computer.computerId): Promise<string> => {
    const [row] = await database.db
      .select({ status: computers.status })
      .from(computers)
      .where(eq(computers.id, computerId));
    return row?.status ?? "没有这台电脑";
  };
  // server.close 兑现与否只在这个标记上看，不等它。
  const closing = () => {
    let done = false;
    const promise = server.close().then(() => (done = true));
    return { promise, done: () => done };
  };
  return { database, gated, server, port: server.server.port, user, computer, status, closing };
}

async function finish(database: TestDb, ...rest: { close(): void }[]) {
  for (const item of rest) item.close();
  await database.close();
}

function heartbeat(agent: AgentClient): void {
  agent.send({ type: "heartbeat", at: new Date().toISOString() });
}

/** pong 回来说明服务端已经读完这条连接上先发的帧，它们的 message 回调都跑过了。 */
function received(agent: AgentClient): Promise<void> {
  return new Promise((resolve) => {
    agent.socket.once("pong", () => resolve());
    agent.socket.ping();
  });
}

/** 每台电脑做完的帧数，以及批量休眠被调用那一刻的这份计数：钉「停机前收下的帧做完才批量休眠」。 */
function observe() {
  const handled = new Map<ComputerId, number>();
  let atBatch: Map<ComputerId, number> | null = null;
  const originalHandle = events.handleAgentEvent;
  const handleSpy = vi.spyOn(events, "handleAgentEvent").mockImplementation(async (deps, conn, message) => {
    try {
      await originalHandle(deps, conn, message);
    } finally {
      handled.set(conn.computerId, (handled.get(conn.computerId) ?? 0) + 1);
    }
  });
  const originalBatch = computersRepo.markComputersSleeping;
  const batchSpy = vi.spyOn(computersRepo, "markComputersSleeping").mockImplementation((db, ids) => {
    atBatch = new Map(handled);
    return originalBatch(db, ids);
  });
  return {
    handled: (computerId: ComputerId): number => handled.get(computerId) ?? 0,
    handledAtBatch: (computerId: ComputerId): number | null => atBatch?.get(computerId) ?? null,
    restore: () => {
      handleSpy.mockRestore();
      batchSpy.mockRestore();
    },
  };
}

it("停机期间认身份才回来的 hello：被关掉，没有 welcome，库里不是在线，server.close 照样返回", async () => {
  const s = await stack();
  const first = await helloAgent(s.port, s.computer.computerId, s.computer.token);
  const original = computersRepo.authenticateComputer;
  let authenticated!: () => void;
  const authenticatedDone = new Promise<void>((resolve) => (authenticated = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const spy = vi.spyOn(computersRepo, "authenticateComputer").mockImplementation(async (...args) => {
    const result = await original(...args);
    authenticated();
    await released;
    return result;
  });
  const markSleeping = computersRepo.markComputersSleeping;
  let slept!: () => void;
  let releaseSleep!: () => void;
  const sleepReached = new Promise<void>((resolve) => (slept = resolve));
  const sleepReleased = new Promise<void>((resolve) => (releaseSleep = resolve));
  const sleepSpy = vi.spyOn(computersRepo, "markComputersSleeping").mockImplementation(async (...args) => {
    await markSleeping(...args);
    slept();
    await sleepReleased;
  });
  const second = await openAgent(s.port);
  let close: ReturnType<typeof s.closing> | undefined;
  try {
    sendHello(second, s.computer.computerId, s.computer.token);
    await authenticatedDone;

    close = s.closing();
    // 认身份那一步挂在 B 的 inbox 尾上，停机等它回来；回来之后它自己看到停机，关 socket 不入链。
    release();
    expect(await second.closed(), "停机期间认完身份的 hello 当场被关").toBe(SERVICE_RESTART);
    expect(second.received(), "没有 welcome，也没有 config").toEqual([]);

    await sleepReached;
    expect(await first.agent.closed(), "已有连接在批量休眠前就被关掉").toBe(SERVICE_RESTART);
    expect(await s.status(), "批量休眠已经落库，B 没有把电脑写回在线").toBe("sleeping");
    expect(close.done(), "批量休眠的返回还扣着，server.close 没返回").toBe(false);

    releaseSleep();
    await close.promise;
    expect(await s.status(), "停机结束后电脑仍是休眠").toBe("sleeping");
  } finally {
    release();
    releaseSleep();
    await close?.promise;
    spy.mockRestore();
    sleepSpy.mockRestore();
    await finish(s.database, first.agent, second);
  }
});

it("网页推送连接迟迟不回关闭帧时，认身份才回来的 hello 照样被关、没有 welcome，已在线电脑新发的帧也丢掉", async () => {
  const s = await stack();
  const client = s.server.client();
  expect((await client.login(s.user.email, PASSWORD)).status).toBe(200);
  const push = await connectPush(s.port, client.cookie ?? "");
  const other = await makeUser(s.database.db, "另一个人");
  const otherComputer = await makeComputer(s.database.db, other.id);
  const first = await helloAgent(s.port, s.computer.computerId, s.computer.token);
  const original = computersRepo.authenticateComputer;
  let authenticated!: () => void;
  const authenticatedDone = new Promise<void>((resolve) => (authenticated = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const spy = vi.spyOn(computersRepo, "authenticateComputer").mockImplementation(async (...args) => {
    const result = await original(...args);
    authenticated();
    await released;
    return result;
  });
  const seen = observe();
  const second = await openAgent(s.port);
  let close: ReturnType<typeof s.closing> | undefined;
  try {
    sendHello(second, otherComputer.computerId, otherComputer.token);
    await authenticatedDone;

    // 网页这头暂不读 socket，读不到服务端的关闭帧也就不回，网页那边的关闭握手一直挂着。
    push.socket.pause();
    close = s.closing();
    heartbeat(first.agent);
    await received(first.agent);
    release();
    const outcome = await Promise.race([
      second.next().then((message) => message.type),
      second.closed().then((code) => code),
    ]);
    expect(outcome, "认完身份回来先看到停机，当场关掉，不是先收到 welcome").toBe(SERVICE_RESTART);
    expect(second.received(), "没有 welcome，也没有 config").toEqual([]);

    push.socket.resume();
    await close.promise;
    expect(seen.handled(s.computer.computerId), "close 之后已在线电脑发的心跳没进业务").toBe(0);
    expect(await first.agent.closed()).toBe(SERVICE_RESTART);
  } finally {
    release();
    push.socket.resume();
    await close?.promise;
    spy.mockRestore();
    seen.restore();
    await finish(s.database, first.agent, second, push);
  }
});

it("停机开始后才到的 socket 直接被关，hello 发了也没有回应", async () => {
  const s = await stack();
  const first = await helloAgent(s.port, s.computer.computerId, s.computer.token);
  const sleep = s.gated.arm(BATCH_SLEEP, "before");
  const close = s.closing();
  await sleep.reached;
  const late = await openAgent(s.port);
  try {
    sendHello(late, s.computer.computerId, s.computer.token);
    expect(await late.closed(), "停机中接到的升级当场关掉").toBe(SERVICE_RESTART);
    expect(late.received()).toEqual([]);
    sleep.release();
    await close.promise;
    expect(await s.status(), "停机结束后电脑是休眠").toBe("sleeping");
  } finally {
    sleep.release();
    await close.promise;
    await finish(s.database, first.agent, late);
  }
});

it("停机前已经收下、还排在 inbox 里的帧照常做完，批量休眠排在它后面", async () => {
  const s = await stack();
  const other = await makeUser(s.database.db, "另一个人");
  const otherComputer = await makeComputer(s.database.db, other.id);
  const first = await helloAgent(s.port, s.computer.computerId, s.computer.token);
  const second = await helloAgent(s.port, otherComputer.computerId, otherComputer.token);
  const seen = observe();
  try {
    const heldX = s.gated.arm(HEARTBEAT, "before");
    heartbeat(first.agent);
    await heldX.reached;
    const heldY = s.gated.arm(HEARTBEAT, "before");
    heartbeat(second.agent);
    await heldY.reached;
    // Y 的第二帧在停机前收下，排在 Y 停着的那帧后面，还没进链。
    heartbeat(second.agent);
    await received(second.agent);

    const close = s.closing();
    heldX.release();
    await heldX.finished;
    const lateY = s.gated.arm(HEARTBEAT, "before");
    heldY.release();
    await lateY.reached;
    expect(seen.handledAtBatch(otherComputer.computerId), "Y 的第二帧还停着，批量休眠没有开始").toBeNull();
    expect(close.done()).toBe(false);

    lateY.release();
    await close.promise;
    expect(seen.handled(otherComputer.computerId), "Y 停机前收下的两帧都做完了").toBe(2);
    expect(seen.handledAtBatch(otherComputer.computerId), "批量休眠开始时 Y 的两帧已经做完").toBe(2);
    expect(seen.handledAtBatch(s.computer.computerId), "批量休眠开始时 X 的帧已经做完").toBe(1);
    expect(await s.status(), "X 休眠").toBe("sleeping");
    expect(await s.status(otherComputer.computerId), "Y 的心跳落在批量休眠之前，停机后不是在线").toBe("sleeping");
    expect(await first.agent.closed()).toBe(SERVICE_RESTART);
    expect(await second.agent.closed()).toBe(SERVICE_RESTART);
  } finally {
    seen.restore();
    await finish(s.database, first.agent, second.agent);
  }
});

it("两台电脑停机后交替续帧：续的帧丢掉，停机前那两帧做完就返回", async () => {
  const s = await stack();
  const other = await makeUser(s.database.db, "另一个人");
  const otherComputer = await makeComputer(s.database.db, other.id);
  const first = await helloAgent(s.port, s.computer.computerId, s.computer.token);
  const second = await helloAgent(s.port, otherComputer.computerId, otherComputer.token);
  const seen = observe();
  try {
    const heldX = s.gated.arm(HEARTBEAT, "after");
    heartbeat(first.agent);
    await heldX.reached;
    const heldY = s.gated.arm(HEARTBEAT, "after");
    heartbeat(second.agent);
    await heldY.reached;

    const close = s.closing();
    // 停机后两台交替续帧：放开一台停着的帧之前，它的下一帧已经被服务端读到，这时停机一定还在等；
    // 不丢的话每放开一帧就多出一帧，停机等不到头。最后一帧之后不再 ping：停机可能已经把 socket 关了。
    heartbeat(first.agent);
    await received(first.agent);
    heldX.release();
    await heldX.finished;
    heartbeat(second.agent);
    await received(second.agent);
    heldY.release();

    await close.promise;
    expect(seen.handled(s.computer.computerId), "X 只做了停机前那一帧").toBe(1);
    expect(seen.handled(otherComputer.computerId), "Y 只做了停机前那一帧").toBe(1);
    expect(seen.handledAtBatch(s.computer.computerId)).toBe(1);
    expect(seen.handledAtBatch(otherComputer.computerId)).toBe(1);
    expect(await s.status()).toBe("sleeping");
    expect(await s.status(otherComputer.computerId)).toBe("sleeping");
    expect(await first.agent.closed()).toBe(SERVICE_RESTART);
    expect(await second.agent.closed()).toBe(SERVICE_RESTART);
  } finally {
    seen.restore();
    await finish(s.database, first.agent, second.agent);
  }
});
