import { AccountId, AccountListResponse, CreateBotResponse, LoginAttemptId, type ServerPush } from "@baize/shared";
import { expect, it, vi } from "vitest";
import { accounts, computers } from "../src/db/schema.js";
import { hashSecret, newId } from "../src/ids.js";
import * as events from "../src/agent/events.js";
import * as accountRepo from "../src/repo/accounts.js";
import { expectHello, helloAgent, openAgent, sendHello, type AgentClient } from "./helpers/agent.js";
import { startTestServer } from "./helpers/client.js";
import { createTestDb } from "./helpers/db.js";
import { makeComputer, makeUser, PASSWORD } from "./helpers/fixtures.js";
import { gatedDb } from "./helpers/gated-db.js";
import { queueHello } from "./helpers/queued-hello.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

/**
 * 同一台电脑的处理是一条链：旧连接的任务停在哪一步，新连接的 hello 和它后面的帧都只能等它整个做完。
 * 这里每条用例按复核报告里的一条探针序列来：旧连接卡住、新连接排上、放开旧连接，然后看落库和推送的先后。
 */

function signal() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

type Login = Extract<ServerPush, { type: "account_updated" }>["account"];

const label = (account: Login) =>
  `${account.login}:${account.handle ?? ""}${account.lastLoginFailure === null ? "" : ` 没成:${account.lastLoginFailure.reason}`}`;

/** 收推送直到 until 命中，返回命中之前看到的账号快照和登录失败。 */
async function collect(
  push: PushClient,
  accountId: AccountId,
  until: (pushed: ServerPush) => boolean,
): Promise<string[]> {
  const seen: string[] = [];
  for (;;) {
    const pushed = await push.next();
    if (until(pushed)) return seen;
    if (pushed.type === "account_updated" && pushed.account.id === accountId) seen.push(label(pushed.account));
    if (pushed.type === "login_failed") seen.push(`failure:${pushed.attempt}`);
    if (pushed.type === "notify" && pushed.notice.kind === "failed") seen.push("notify:failed");
  }
}

const failed = (accountId: AccountId, attempt: string) =>
  ({
    type: "login_state",
    accountId,
    state: { login: "failed", reason: "window_failed", attempt: LoginAttemptId.parse(attempt) },
  }) as const;

async function setup(secondAccount = false) {
  const database = await createTestDb();
  const gated = gatedDb(database.sql);
  const server = await startTestServer(gated.db);
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const a = AccountId.parse(newId());
  const b = secondAccount ? AccountId.parse(newId()) : a;
  // 哨兵报在这个号上：登录失败会记到它身上并推它的快照，collect 只收被测账号的快照，哨兵到了不会被当成晚到的写。
  const beacon = AccountId.parse(newId());
  await database.db.insert(accounts).values([
    { id: a, ownerId: user.id, computerId: computer.computerId, platform: "xiaohongshu", handle: "@A", login: "valid" },
    {
      id: beacon,
      ownerId: user.id,
      computerId: computer.computerId,
      platform: "xiaohongshu",
      handle: "@哨兵",
      login: "valid",
    },
    ...(secondAccount
      ? [
          {
            id: b,
            ownerId: user.id,
            computerId: computer.computerId,
            platform: "xiaohongshu" as const,
            handle: "@B",
            login: "valid" as const,
          },
        ]
      : []),
  ]);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const push = await connectPush(server.server.port, client.cookie ?? "");
  const stale = (await helloAgent(server.server.port, computer.computerId, computer.token)).agent;
  let fresh: AgentClient | null = null;
  const reconnect = async () => {
    fresh = await queueHello(server.server.port, computer.computerId, computer.token);
    return fresh;
  };
  const close = async () => {
    stale.close();
    fresh?.close();
    push.close();
    await server.close();
    await database.close();
  };
  const account = async (id: AccountId) =>
    AccountListResponse.parse(await (await client.get("/api/accounts")).json()).accounts.find((one) => one.id === id);
  const sentinel = (attempt: string) => failed(beacon, attempt);
  return { database, gated, server, computer, a, b, client, push, stale, reconnect, close, account, sentinel };
}

it("高 1：旧连接报甲改名成乙、停在找 known 行那一步，新连接把乙报成过期：旧写先落、新写后落，乙最终过期", async () => {
  const s = await setup(true);
  const gate = s.gated.arm(/"accounts"\."id" <>/);
  try {
    s.stale.send({ type: "login_state", accountId: s.a, state: { login: "valid", handle: "@B" } });
    await gate.reached;
    const fresh = await s.reconnect();
    gate.release();

    expect(await s.stale.closed(), "旧连接做完自己那条才被顶掉").toBe(4000);
    await expectHello(fresh);
    fresh.send({ type: "login_state", accountId: s.b, state: { login: "expired" } });
    // 过期的推送是快照加一条失败通知，通知是它的最后一条。
    const written = await collect(s.push, s.b, (pushed) => pushed.type === "notify" && pushed.notice.kind === "failed");
    expect(written, "旧连接的合并先落，乙先被记成 valid，然后才是新连接的过期").toEqual(["valid:@B", "expired:@B"]);
    await fresh.expect("config");
    fresh.send(s.sentinel("sentinel"));
    const late = await collect(
      s.push,
      s.b,
      (pushed) => pushed.type === "login_failed" && pushed.attempt === "sentinel",
    );
    expect(late, "新连接记的过期之后没有别的快照").toEqual([]);
    expect((await s.account(s.b))?.login, "新连接把乙记成过期，旧连接的合并排在它前面，恢复不了").toBe("expired");
  } finally {
    gate.release();
    await s.close();
  }
});

it("高 2：旧 hello 的 key 轮换已落库、返回晚到，新 hello 排在它后面：旧连接先握手完再被顶掉，新连接拿到的 key 才是库里那把", async () => {
  const database = await createTestDb();
  const gated = gatedDb(database.sql);
  const server = await startTestServer(gated.db);
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小轮" })).json());
  const stale = await openAgent(server.server.port);
  const gate = gated.arm(/update "computers" set "gateway_key_hash"/, "after");
  let fresh: AgentClient | null = null;
  try {
    sendHello(stale, computer.computerId, computer.token);
    await gate.reached;
    fresh = await queueHello(server.server.port, computer.computerId, computer.token);
    gate.release();

    const old = await expectHello(stale);
    expect(await stale.closed(), "旧连接先握手完，新连接轮到了才顶掉它").toBe(4000);
    const current = await expectHello(fresh);
    const [row] = await database.db.select({ keyHash: computers.gatewayKeyHash }).from(computers);
    expect(row?.keyHash, "库里的 key 是新连接那把").toBe(hashSecret(current.config.modelGateway.apiKey));
    expect((await client.post(`/api/groups/${created.group.id}/messages`, { text: "轮换后派活" })).status).toBe(201);
    const prompt = await fresh.expect("prompt");
    const gateway = (key: string) =>
      fetch(`${client.origin}/gateway/v1/models`, {
        headers: {
          Authorization: `Bearer ${key}`,
          "x-baize-lane": `${created.bot.id}/${created.group.id}/${prompt.lane.epoch}`,
        },
      });
    expect((await gateway(current.config.modelGateway.apiKey)).status, "新连接的 key 能过网关").toBe(200);
    expect((await gateway(old.config.modelGateway.apiKey)).status, "旧连接的 key 已作废").toBe(401);
  } finally {
    gate.release();
    stale.close();
    fresh?.close();
    await server.close();
    await database.close();
  }
});

async function lateReturn(
  s: Awaited<ReturnType<typeof setup>>,
  held: { reached: Promise<void>; release: () => void },
  staleState: { login: "valid"; handle: string } | { login: "expired" },
): Promise<{ before: string[]; late: string[] }> {
  s.stale.send({ type: "login_state", accountId: s.a, state: staleState });
  await held.reached;
  const fresh = await s.reconnect();
  held.release();

  await expectHello(fresh);
  fresh.send({ type: "login_state", accountId: s.a, state: { login: "valid", handle: "@fresh" } });
  const before = await collect(
    s.push,
    s.a,
    (pushed) => pushed.type === "account_updated" && pushed.account.id === s.a && pushed.account.handle === "@fresh",
  );
  await fresh.expect("config");
  fresh.send(s.sentinel("sentinel"));
  const late = await collect(s.push, s.a, (pushed) => pushed.type === "login_failed" && pushed.attempt === "sentinel");
  return { before, late };
}

it("中 1：旧 valid 已提交、返回晚到，新连接再报 valid：旧快照推在新快照前面，之后没有晚到的快照", async () => {
  const s = await setup();
  const reached = signal();
  const release = signal();
  const original = accountRepo.markLoginValid;
  const spy = vi.spyOn(accountRepo, "markLoginValid").mockImplementation(async (...args) => {
    const result = await original(...args);
    if (args[4] === "@stale") {
      reached.release();
      await release.promise;
    }
    return result;
  });
  try {
    const { before, late } = await lateReturn(
      s,
      { reached: reached.promise, release: release.release },
      { login: "valid", handle: "@stale" },
    );
    expect(before, "旧连接的快照先推").toEqual(["valid:@stale"]);
    expect(late, "新连接落下 @fresh 之后没有旧连接晚到的快照").toEqual([]);
    expect((await s.account(s.a))?.handle).toBe("@fresh");
  } finally {
    release.release();
    spy.mockRestore();
    await s.close();
  }
});

it("中 1：旧 expired 已提交、返回晚到，新连接报 valid：过期推在 valid 前面，之后没有晚到的过期快照", async () => {
  const s = await setup();
  const reached = signal();
  const release = signal();
  const original = accountRepo.markLoginExpired;
  const spy = vi.spyOn(accountRepo, "markLoginExpired").mockImplementation(async (...args) => {
    const result = await original(...args);
    if (args[1].evidence.kind === "reported") {
      reached.release();
      await release.promise;
    }
    return result;
  });
  try {
    const { before, late } = await lateReturn(
      s,
      { reached: reached.promise, release: release.release },
      { login: "expired" },
    );
    expect(before, "旧连接的过期先推，连着它的失败通知").toEqual(["expired:@A", "notify:failed"]);
    expect(late, "新连接落下 valid 之后没有旧连接晚到的过期快照").toEqual([]);
    expect((await s.account(s.a))?.login).toBe("valid");
  } finally {
    release.release();
    spy.mockRestore();
    await s.close();
  }
});

it("中 2：旧连接的登录失败已进 handler，新连接报 valid：失败推在 valid 前面，之后不再有它的失败通知", async () => {
  const s = await setup();
  const gate = s.gated.arm(/select "platform" from "accounts"/);
  try {
    s.stale.send(failed(s.a, "old-failed"));
    await gate.reached;
    const fresh = await s.reconnect();
    gate.release();

    expect(await s.stale.closed(), "旧连接的失败帧处理完才轮到新 hello").toBe(4000);
    await expectHello(fresh);
    fresh.send({ type: "login_state", accountId: s.a, state: { login: "valid", handle: "@fresh" } });
    const before = await collect(
      s.push,
      s.a,
      (pushed) => pushed.type === "account_updated" && pushed.account.id === s.a && pushed.account.handle === "@fresh",
    );
    await fresh.expect("config");
    fresh.send(s.sentinel("sentinel"));
    const late = await collect(
      s.push,
      s.a,
      (pushed) => pushed.type === "login_failed" && pushed.attempt === "sentinel",
    );
    expect(before, "旧连接的失败落在账号上，快照、失败和通知都在新连接的 valid 之前").toEqual([
      "valid:@A 没成:window_failed",
      "failure:old-failed",
      "notify:failed",
    ]);
    expect(late, "valid 之后只剩哨兵自己").toEqual([]);
    expect((await s.account(s.a))?.lastLoginFailure, "新连接登上之后旧连接那次失败已清掉").toBeNull();
  } finally {
    gate.release();
    await s.close();
  }
});

it("链上一个任务抛错，排在它后面的任务照跑：旧连接那帧的 handler 抛错，新连接的 hello 仍然握手", async () => {
  const s = await setup();
  const reached = signal();
  const release = signal();
  const original = events.handleAgentEvent;
  const spy = vi.spyOn(events, "handleAgentEvent").mockImplementation(async (deps, conn, message) => {
    if (message.type === "login_state" && message.state.login === "failed" && message.state.attempt === "boom") {
      reached.release();
      await release.promise;
      throw new Error("测试：handler 抛错");
    }
    return original(deps, conn, message);
  });
  try {
    s.stale.send(failed(s.a, "boom"));
    await reached.promise;
    const fresh = await s.reconnect();
    release.release();

    expect(await s.stale.closed(), "抛错的任务之后轮到新连接的 hello，旧连接被顶掉").toBe(4000);
    await expectHello(fresh);
    fresh.send(s.sentinel("after"));
    const seen = await collect(s.push, s.a, (pushed) => pushed.type === "login_failed" && pushed.attempt === "after");
    expect(seen, "抛错那帧自己的推送没发出去").toEqual([]);
  } finally {
    release.release();
    spy.mockRestore();
    await s.close();
  }
});
