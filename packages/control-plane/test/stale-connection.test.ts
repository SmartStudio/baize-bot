import {
  AccountId,
  AccountListResponse,
  ComputerListResponse,
  LoginAttemptId,
  type AgentToControl,
  type ServerPush,
} from "@baize/shared";
import { expect, it } from "vitest";
import { accounts } from "../src/db/schema.js";
import { newId } from "../src/ids.js";
import { expectHello, helloAgent, openAgent, sendHello, type AgentClient } from "./helpers/agent.js";
import { startTestServer } from "./helpers/client.js";
import { createTestDb } from "./helpers/db.js";
import { makeComputer, makeUser, PASSWORD } from "./helpers/fixtures.js";
import { gatedDb } from "./helpers/gated-db.js";
import { queueHello } from "./helpers/queued-hello.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

/**
 * 同一台电脑的处理是一条链。旧连接的任务停住时新连接的 hello 只能排在后面，所以这里的新连接都用 queueHello 排上，
 * 放开旧任务之后才等它的 welcome。旧连接 inbox 里排着的帧要等它前一帧做完才入链，排在新 hello 后面，入链时整条丢掉。
 */

async function nextOf<K extends ServerPush["type"]>(
  push: PushClient,
  type: K,
  match: (pushed: Extract<ServerPush, { type: K }>) => boolean = () => true,
): Promise<Extract<ServerPush, { type: K }>> {
  for (;;) {
    const pushed = await push.next();
    if (pushed.type === type && match(pushed as Extract<ServerPush, { type: K }>)) {
      return pushed as Extract<ServerPush, { type: K }>;
    }
  }
}

/** pong 回来说明服务端已经读完这条连接上先发的帧，它们都排进了那条连接的 inbox。 */
function received(agent: AgentClient): Promise<void> {
  return new Promise((resolve) => {
    agent.socket.once("pong", () => resolve());
    agent.socket.ping();
  });
}

/** 远程电脑那条推送排在前面所有推送之后，拿它当屏障数本机电脑的状态推送。 */
async function localStatusesBefore(push: PushClient, post: () => Promise<Response>): Promise<string[]> {
  expect((await post()).status).toBe(200);
  const local: string[] = [];
  for (;;) {
    const updated = await nextOf(push, "computer_updated");
    if (updated.computer.kind === "remote") break;
    local.push(updated.computer.status);
  }
  return local;
}

it("被新连接顶掉的旧连接，inbox 里排着的 expired 不盖新连接落下的 valid", async () => {
  const database = await createTestDb();
  const gated = gatedDb(database.sql);
  const server = await startTestServer(gated.db);
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const blockerId = AccountId.parse(newId());
  const targetId = AccountId.parse(newId());
  await database.db.insert(accounts).values([
    {
      id: blockerId,
      ownerId: user.id,
      computerId: computer.computerId,
      platform: "xiaohongshu",
      handle: "@卡",
      login: "valid",
    },
    {
      id: targetId,
      ownerId: user.id,
      computerId: computer.computerId,
      platform: "xiaohongshu",
      handle: "@old",
      login: "valid",
    },
  ]);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const push = await connectPush(server.server.port, client.cookie ?? "");
  const stale = (await helloAgent(server.server.port, computer.computerId, computer.token)).agent;
  let fresh: AgentClient | null = null;
  const gate = gated.arm(/select "platform" from "accounts"/);

  try {
    stale.send({
      type: "login_state",
      accountId: blockerId,
      state: { login: "failed", reason: "window_failed", attempt: LoginAttemptId.parse("blocker") },
    });
    await gate.reached;
    stale.send({ type: "login_state", accountId: targetId, state: { login: "expired" } });
    await received(stale);
    fresh = await queueHello(server.server.port, computer.computerId, computer.token);
    fresh.send({ type: "login_state", accountId: targetId, state: { login: "valid", handle: "@fresh" } });

    gate.release();
    await nextOf(push, "login_failed", (pushed) => pushed.attempt === "blocker");
    await nextOf(push, "notify");
    expect(await stale.closed(), "卡着的那条一结束就轮到新连接的 hello，旧连接被顶掉").toBe(4000);
    await expectHello(fresh);
    // 旧连接排着的 expired 在新 hello 之后才入链，真落了的话会推在新连接的 valid 前面。
    const between: string[] = [];
    for (;;) {
      const updated = await nextOf(push, "account_updated", (pushed) => pushed.account.id === targetId);
      between.push(updated.account.login);
      if (updated.account.login === "valid") break;
    }
    expect(between, "旧连接排着的 expired 被丢掉，没把账号改成过期").toEqual(["valid"]);
    // valid 落库后还要给这台电脑重发 config，等它到了再关库，不然收尾撞上还在查库的那一段。
    await fresh.expect("config");
  } finally {
    gate.release();
    stale.close();
    fresh?.close();
    push.close();
    await server.close();
    await database.close();
  }
});

it("旧 hello 对账没走完时来了新连接：新 hello 排在后面，旧连接先握手完再被顶掉，上线推两次", async () => {
  const database = await createTestDb();
  const gated = gatedDb(database.sql);
  const server = await startTestServer(gated.db);
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const push = await connectPush(server.server.port, client.cookie ?? "");
  const stale = await openAgent(server.server.port);
  let fresh: AgentClient | null = null;
  const gate = gated.arm(/from "runs"/);

  try {
    sendHello(stale, computer.computerId, computer.token);
    await gate.reached;
    fresh = await queueHello(server.server.port, computer.computerId, computer.token);
    gate.release();

    await expectHello(stale);
    expect(await stale.closed(), "旧连接握手完才轮到新连接，然后才被顶掉").toBe(4000);
    await expectHello(fresh);
    const local = await localStatusesBefore(push, () => client.post("/api/computers/remote"));
    expect(local, "两次 hello 各推一次上线，先旧后新").toEqual(["online", "online"]);
    const listed = ComputerListResponse.parse(await (await client.get("/api/computers")).json());
    expect(listed.computers.find((item) => item.id === computer.computerId)?.status, "电脑状态是在线").toBe("online");
  } finally {
    gate.release();
    stale.close();
    fresh?.close();
    push.close();
    await server.close();
    await database.close();
  }
});

it("排在旧 hello 后面的新连接没轮到就断了：旧连接握手完才被它顶掉，它的关闭排在最后，电脑最终是休眠", async () => {
  const database = await createTestDb();
  const gated = gatedDb(database.sql);
  const server = await startTestServer(gated.db);
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const push = await connectPush(server.server.port, client.cookie ?? "");
  const stale = await openAgent(server.server.port);
  let fresh: AgentClient | null = null;
  const gate = gated.arm(/update "computers" set "status"/);

  try {
    sendHello(stale, computer.computerId, computer.token);
    await gate.reached;
    fresh = await queueHello(server.server.port, computer.computerId, computer.token);
    fresh.close();
    await fresh.closed();
    gate.release();

    await expectHello(stale);
    expect(await stale.closed(), "旧连接握手完才轮到新连接顶掉它").toBe(4000);
    const local: string[] = [];
    while (local.at(-1) !== "sleeping") {
      const updated = await nextOf(push, "computer_updated", (pushed) => pushed.computer.kind === "local");
      local.push(updated.computer.status);
    }
    expect(local, "两次上线按链上顺序推完，新连接的关闭排在它自己的 hello 后面，休眠最后").toEqual([
      "online",
      "online",
      "sleeping",
    ]);
    const listed = ComputerListResponse.parse(await (await client.get("/api/computers")).json());
    expect(
      listed.computers.find((item) => item.id === computer.computerId)?.status,
      "旧连接的上线写排在前面，盖不掉新连接的休眠",
    ).toBe("sleeping");
  } finally {
    gate.release();
    stale.close();
    fresh?.close();
    push.close();
    await server.close();
    await database.close();
  }
});

it("旧 hello 的上线写已经落库、回调晚到：旧连接握手完再轮到新连接，卡住的去重从新连接那次上线算", async () => {
  const database = await createTestDb();
  const gated = gatedDb(database.sql);
  const server = await startTestServer(gated.db);
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const accountId = AccountId.parse(newId());
  await database.db.insert(accounts).values({
    id: accountId,
    ownerId: user.id,
    computerId: computer.computerId,
    platform: "xiaohongshu",
    handle: "@屏障",
    login: "valid",
  });
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const push = await connectPush(server.server.port, client.cookie ?? "");
  const stale = await openAgent(server.server.port);
  let fresh: AgentClient | null = null;
  const gate = gated.arm(/update "computers" set "status"/, "after");

  try {
    sendHello(stale, computer.computerId, computer.token);
    await gate.reached;
    fresh = await queueHello(server.server.port, computer.computerId, computer.token);
    gate.release();

    await expectHello(stale);
    expect(await stale.closed(), "旧连接握手完才被顶掉").toBe(4000);
    const hello = await expectHello(fresh);
    for (let seen = 0; seen < 2; seen += 1) {
      await nextOf(
        push,
        "computer_updated",
        (pushed) => pushed.computer.kind === "local" && pushed.computer.status === "online",
      );
    }
    // 新连接上线后卡住一次，这条 stuck 推出去；同类的下一条只有再有电脑上线才会再推。
    const rejected = (): AgentToControl => ({
      type: "agent_error",
      code: "config_rejected",
      detail: "测试",
      generation: hello.config.generation,
    });
    fresh.send(rejected());
    await nextOf(push, "notify", (pushed) => pushed.notice.kind === "stuck");
    fresh.send(rejected());
    fresh.send({
      type: "login_state",
      accountId,
      state: { login: "failed", reason: "window_failed", attempt: LoginAttemptId.parse("barrier") },
    });
    const seen: string[] = [];
    for (;;) {
      const pushed = await push.next();
      if (pushed.type === "computer_updated") seen.push(`computer:${pushed.computer.kind}:${pushed.computer.status}`);
      if (pushed.type === "notify") seen.push(`notify:${pushed.notice.kind}`);
      if (pushed.type === "notify" && pushed.notice.kind === "failed") break;
    }
    expect(seen, "两次上线都推完了，之后没有晚到的上线，第二条 stuck 照样不推").toEqual(["notify:failed"]);
  } finally {
    gate.release();
    stale.close();
    fresh?.close();
    push.close();
    await server.close();
    await database.close();
  }
});

it("旧连接的休眠写已经落库、回调晚到：休眠先推完，新连接的上线排在它后面", async () => {
  const database = await createTestDb();
  const gated = gatedDb(database.sql);
  const server = await startTestServer(gated.db);
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const push = await connectPush(server.server.port, client.cookie ?? "");
  const stale = (await helloAgent(server.server.port, computer.computerId, computer.token)).agent;
  await nextOf(
    push,
    "computer_updated",
    (pushed) => pushed.computer.kind === "local" && pushed.computer.status === "online",
  );
  let fresh: AgentClient | null = null;
  const gate = gated.arm(/update "computers" set "status"/, "after");

  try {
    stale.close();
    await gate.reached;
    fresh = await queueHello(server.server.port, computer.computerId, computer.token);
    gate.release();

    await expectHello(fresh);
    const local = await localStatusesBefore(push, () => client.post("/api/computers/remote"));
    expect(local, "旧连接的休眠整个做完再轮到新连接上线").toEqual(["sleeping", "online"]);
    const listed = ComputerListResponse.parse(await (await client.get("/api/computers")).json());
    expect(listed.computers.find((item) => item.id === computer.computerId)?.status, "电脑状态是新连接的在线").toBe(
      "online",
    );
  } finally {
    gate.release();
    stale.close();
    fresh?.close();
    push.close();
    await server.close();
    await database.close();
  }
});

/** 旧连接报登录状态的那条帧卡在 handler 里，新连接排在后面，新连接再把同一个账号写成另一种状态，然后放开旧帧。 */
async function staleLoginStateInHandler(
  sent: Extract<AgentToControl, { type: "login_state" }>["state"],
  freshWrites: Extract<AgentToControl, { type: "login_state" }>["state"],
) {
  const database = await createTestDb();
  const gated = gatedDb(database.sql);
  const server = await startTestServer(gated.db);
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const targetId = AccountId.parse(newId());
  await database.db.insert(accounts).values({
    id: targetId,
    ownerId: user.id,
    computerId: computer.computerId,
    platform: "xiaohongshu",
    handle: "@old",
    login: "valid",
  });
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const push = await connectPush(server.server.port, client.cookie ?? "");
  const stale = (await helloAgent(server.server.port, computer.computerId, computer.token)).agent;
  const gate = gated.arm(/select "platform" from "accounts"/);
  stale.send({ type: "login_state", accountId: targetId, state: sent });
  await gate.reached;

  const fresh = await queueHello(server.server.port, computer.computerId, computer.token);
  fresh.send({ type: "login_state", accountId: targetId, state: freshWrites });
  gate.release();
  expect(await stale.closed(), "旧帧整个做完才轮到新连接的 hello").toBe(4000);
  await expectHello(fresh);
  // 新连接再报一次 valid 当哨兵：它排在新连接那条写之后，中间不该再夹别的快照。
  fresh.send({ type: "login_state", accountId: targetId, state: { login: "valid", handle: "@fresh" } });
  const seen: string[] = [];
  for (;;) {
    const updated = await nextOf(push, "account_updated", (pushed) => pushed.account.id === targetId);
    seen.push(`${updated.account.login}:${updated.account.handle ?? ""}`);
    if (updated.account.handle === "@fresh") break;
  }
  // 每次登录状态落库都给这台电脑重发 config，等它们到了再关库。
  await fresh.expect("config");
  await fresh.expect("config");
  const close = async () => {
    stale.close();
    fresh.close();
    push.close();
    await server.close();
    await database.close();
  };
  return { seen, close };
}

it("已经进入 handler 的旧连接 expired 先落库，新连接排在后面把账号登成 valid", async () => {
  const { seen, close } = await staleLoginStateInHandler({ login: "expired" }, { login: "valid", handle: "@new" });
  try {
    expect(seen, "旧帧先落成过期，新连接的 valid 排在它后面，最终是 valid").toEqual([
      "expired:@old",
      "valid:@new",
      "valid:@fresh",
    ]);
  } finally {
    await close();
  }
});

it("已经进入 handler 的旧连接 valid 先落库，新连接排在后面报过期", async () => {
  const { seen, close } = await staleLoginStateInHandler({ login: "valid", handle: "@stale" }, { login: "expired" });
  try {
    expect(seen, "旧帧先落成 valid，新连接的过期排在它后面，再登回来").toEqual([
      "valid:@stale",
      "expired:@stale",
      "valid:@fresh",
    ]);
  } finally {
    await close();
  }
});

/** 登录失败的推送不看库里的连接代次：被顶掉的旧连接 inbox 里排着的帧要靠任务开头的判断整条丢掉。 */
it("被新连接顶掉的旧连接，inbox 里排着的登录失败不再推给页面", async () => {
  const database = await createTestDb();
  const gated = gatedDb(database.sql);
  const server = await startTestServer(gated.db);
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const targetId = AccountId.parse(newId());
  await database.db.insert(accounts).values({
    id: targetId,
    ownerId: user.id,
    computerId: computer.computerId,
    platform: "xiaohongshu",
    handle: "@old",
    login: "valid",
  });
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const push = await connectPush(server.server.port, client.cookie ?? "");
  const stale = (await helloAgent(server.server.port, computer.computerId, computer.token)).agent;
  let fresh: AgentClient | null = null;
  const failed = (attempt: string): Extract<AgentToControl, { type: "login_state" }> => ({
    type: "login_state",
    accountId: targetId,
    state: { login: "failed", reason: "window_failed", attempt: LoginAttemptId.parse(attempt) },
  });
  const gate = gated.arm(/select "platform" from "accounts"/);

  try {
    stale.send(failed("blocker"));
    await gate.reached;
    stale.send(failed("stale"));
    await received(stale);
    fresh = await queueHello(server.server.port, computer.computerId, computer.token);
    gate.release();
    await nextOf(push, "login_failed", (pushed) => pushed.attempt === "blocker");
    expect(await stale.closed(), "卡着的那条一结束就轮到新连接的 hello，旧连接被顶掉").toBe(4000);
    await expectHello(fresh);

    // 旧连接排着的 stale 在新 hello 之后入链，真推了的话排在 fresh-1 前面。
    fresh.send(failed("fresh-1"));
    fresh.send(failed("fresh-2"));
    const attempts: string[] = [];
    for (;;) {
      const pushed = await nextOf(push, "login_failed");
      attempts.push(pushed.attempt);
      if (pushed.attempt === "fresh-2") break;
    }
    expect(attempts, "旧连接排着的登录失败整条丢掉，页面只看到新连接的").toEqual(["fresh-1", "fresh-2"]);
  } finally {
    gate.release();
    stale.close();
    fresh?.close();
    push.close();
    await server.close();
    await database.close();
  }
});

/**
 * 两个控制面共一个库：旧连接在甲上，它报的登录失败停在 handler 里；同一台电脑在乙上握手（轮换了 key）并登上。
 * 同一个控制面里链会把新 hello 排在旧帧后面，到不了这一步，只有库里的连接代次挡得住旧帧把痕迹写回去。
 */
it("两个控制面共库：被另一个控制面上的新连接顶掉之后，旧连接在途的登录失败不落到账号上", async () => {
  const database = await createTestDb();
  const gated = gatedDb(database.sql);
  const first = await startTestServer(gated.db);
  const second = await startTestServer(database.db);
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const targetId = AccountId.parse(newId());
  await database.db.insert(accounts).values({
    id: targetId,
    ownerId: user.id,
    computerId: computer.computerId,
    platform: "xiaohongshu",
    handle: "@old",
    login: "expired",
  });
  const client = first.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const firstPush = await connectPush(first.server.port, client.cookie ?? "");
  const secondPush = await connectPush(second.server.port, client.cookie ?? "");
  const stale = (await helloAgent(first.server.port, computer.computerId, computer.token)).agent;
  let fresh: AgentClient | null = null;
  const gate = gated.arm(/select "platform" from "accounts"/);

  try {
    stale.send({
      type: "login_state",
      accountId: targetId,
      state: { login: "failed", reason: "window_failed", attempt: LoginAttemptId.parse("stale") },
    });
    await gate.reached;
    fresh = (await helloAgent(second.server.port, computer.computerId, computer.token)).agent;
    fresh.send({ type: "login_state", accountId: targetId, state: { login: "valid", handle: "@fresh" } });
    const loggedIn = await nextOf(secondPush, "account_updated", (pushed) => pushed.account.id === targetId);
    expect(loggedIn.account.login, "新连接先登上").toBe("valid");
    await fresh.expect("config");

    gate.release();
    const before: string[] = [];
    for (;;) {
      const pushed = await firstPush.next();
      if (pushed.type === "login_failed") break;
      if (pushed.type === "account_updated") before.push(pushed.account.lastLoginFailure?.reason ?? "none");
    }
    expect(before, "旧连接的失败没落库，甲上没有推带痕迹的账号").toEqual([]);
    const listed = AccountListResponse.parse(await (await client.get("/api/accounts")).json()).accounts;
    const account = listed.find((item) => item.id === targetId);
    expect(account?.login, "账号还是新连接登上的样子").toBe("valid");
    expect(account?.lastLoginFailure, "旧连接的失败没把痕迹写回登上之后的账号").toBeNull();
  } finally {
    gate.release();
    stale.close();
    fresh?.close();
    firstPush.close();
    secondPush.close();
    await first.close();
    await second.close();
    await database.close();
  }
});
