import { AccountId, LoginAttemptId } from "@baize/shared";
import { inArray } from "drizzle-orm";
import { expect, it } from "vitest";
import { accounts } from "../src/db/schema.js";
import { newId } from "../src/ids.js";
import { markLoginValid } from "../src/repo/accounts.js";
import { rotateGatewayKey } from "../src/repo/computers.js";
import { expectHello, helloAgent, type AgentClient } from "./helpers/agent.js";
import { startTestServer } from "./helpers/client.js";
import { createTestDb } from "./helpers/db.js";
import { makeComputer, makeUser, PASSWORD } from "./helpers/fixtures.js";
import { gatedDb } from "./helpers/gated-db.js";
import { queueHello } from "./helpers/queued-hello.js";
import { connectPush } from "./helpers/ws.js";

async function twoAccounts() {
  const database = await createTestDb();
  const gated = gatedDb(database.sql);
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const firstId = AccountId.parse(newId());
  const secondId = AccountId.parse(newId());
  await database.db.insert(accounts).values([
    {
      id: firstId,
      ownerId: user.id,
      computerId: computer.computerId,
      platform: "xiaohongshu",
      handle: "甲",
      login: "valid",
    },
    {
      id: secondId,
      ownerId: user.id,
      computerId: computer.computerId,
      platform: "xiaohongshu",
      handle: "乙",
      login: "valid",
    },
  ]);
  const generations = async () => {
    const rows = await database.db
      .select({ id: accounts.id, generation: accounts.loginGeneration })
      .from(accounts)
      .where(inArray(accounts.id, [firstId, secondId]));
    return Object.fromEntries(rows.map((row) => [row.id, row.generation]));
  };
  // 有界轮询，最多 10 秒：另一头在 advisory lock 上等着时返回。
  const advisoryWaiter = async () => {
    for (let tries = 0; tries < 500; tries += 1) {
      const [row] = await database.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = ${database.databaseName} AND wait_event_type = 'Lock' AND wait_event = 'advisory'`;
      if ((row?.count ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  return { database, gated, user, computer, firstId, secondId, generations, advisoryWaiter };
}

/**
 * 同一台电脑同平台的甲、乙两个账号反向合并：两边都先锁住自己报上来的行再去锁对方的，没有统一锁序的话
 * 这里是 PostgreSQL 的 40P01，一次登录结果就丢了。电脑级的 advisory lock 让同一台电脑的登录结果一次只进一个。
 * 这条直接调仓库函数让两次合并真的在数据库里并发，钉的是数据库层这道锁；hub 的链在它上面一层，这里不经过。
 */
it("同一台电脑甲、乙反向合并并发进数据库：不死锁，两次登录都记下", async () => {
  const s = await twoAccounts();
  const connection = {
    computerId: s.computer.computerId,
    gatewayKey: await rotateGatewayKey(s.database.db, s.computer.computerId),
  };
  const firstGate = s.gated.arm(/"accounts"\."id" <>/);
  let secondRelease: (() => void) | null = null;
  try {
    const first = markLoginValid(s.gated.db, s.user.id, connection, s.firstId, "乙");
    await firstGate.reached;
    const secondGate = s.gated.arm(/"accounts"\."id" <>/);
    secondRelease = secondGate.release;
    const second = markLoginValid(s.gated.db, s.user.id, connection, s.secondId, "甲");
    // 第二个要么也锁住了自己的行走到屏障，要么被电脑级的锁排在了第一个后面。
    await Promise.race([secondGate.reached, s.advisoryWaiter()]);
    firstGate.release();
    await secondGate.reached;
    secondGate.release();
    expect((await first)?.account.login, "第一次合并落成 valid").toBe("valid");
    expect((await second)?.account.login, "第二次合并落成 valid").toBe("valid");
    expect(await s.generations(), "两次登录成功都记进了各自的代次，没有一次被 deadlock 吃掉").toEqual({
      [s.firstId]: 2,
      [s.secondId]: 2,
    });
  } finally {
    firstGate.release();
    secondRelease?.();
    await s.database.close();
  }
}, 15_000);

/**
 * 同一场景走连接：旧连接报甲的名字是乙，走到找 known 行那条查询时来了新连接，新连接接着报乙的名字是甲。
 * 同一台电脑的处理是一条链，新连接的 hello 和它的那条合并都排在旧连接的合并后面，两次合并先后进库，谁都不丢。
 */
it("同一台电脑换连接时甲、乙反向合并：旧连接的合并先落，新连接的排在后面，两次登录都记下", async () => {
  const s = await twoAccounts();
  const server = await startTestServer(s.gated.db);
  const client = server.client();
  expect((await client.login(s.user.email, PASSWORD)).status).toBe(200);
  const push = await connectPush(server.server.port, client.cookie ?? "");
  const stale = (await helloAgent(server.server.port, s.computer.computerId, s.computer.token)).agent;
  let fresh: AgentClient | null = null;
  const firstGate = s.gated.arm(/"accounts"\."id" <>/);

  try {
    stale.send({ type: "login_state", accountId: s.firstId, state: { login: "valid", handle: "乙" } });
    await firstGate.reached;
    fresh = await queueHello(server.server.port, s.computer.computerId, s.computer.token);
    fresh.send({ type: "login_state", accountId: s.secondId, state: { login: "valid", handle: "甲" } });
    firstGate.release();
    expect(await stale.closed(), "旧连接的合并做完才轮到新连接").toBe(4000);
    await expectHello(fresh);

    // 新连接的 failed 当哨兵：它排在新连接的合并之后。
    fresh.send({
      type: "login_state",
      accountId: s.secondId,
      state: { login: "failed", reason: "window_failed", attempt: LoginAttemptId.parse("sentinel") },
    });
    for (;;) {
      const event = await push.next();
      if (event.type === "login_failed") break;
    }
    expect(await s.generations(), "两次登录成功都记进了各自的代次").toEqual({ [s.firstId]: 2, [s.secondId]: 2 });
  } finally {
    firstGate.release();
    stale.close();
    fresh?.close();
    push.close();
    await server.close();
    await s.database.close();
  }
}, 15_000);
