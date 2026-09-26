import { AccountId, LoginAttemptId } from "@baize/shared";
import { inArray } from "drizzle-orm";
import { expect, it } from "vitest";
import { accounts } from "../src/db/schema.js";
import { newId } from "../src/ids.js";
import { helloAgent } from "./helpers/agent.js";
import { startTestServer } from "./helpers/client.js";
import { createTestDb } from "./helpers/db.js";
import { makeComputer, makeUser, PASSWORD } from "./helpers/fixtures.js";
import { gatedDb } from "./helpers/gated-db.js";
import { connectPush } from "./helpers/ws.js";

/**
 * 两个控制面共用一库，同一台电脑同平台的甲、乙两个账号反向合并：甲报名字乙、乙报名字甲。
 * 屏障落在找 known 行那条查询上，两边都锁住了自己报上来的行才放行，各自再去锁对方。
 * 没有统一锁序的话这里是 PostgreSQL 的 40P01，一次登录结果就丢了。
 */
it("两个控制面同时把甲、乙反向合并：不死锁，两次登录都记下", async () => {
  const database = await createTestDb();
  const firstDb = gatedDb(database.sql);
  const secondDb = gatedDb(database.sql);
  const firstServer = await startTestServer(firstDb.db);
  const secondServer = await startTestServer(secondDb.db);
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
  const firstClient = firstServer.client();
  const secondClient = secondServer.client();
  expect((await firstClient.login(user.email, PASSWORD)).status).toBe(200);
  expect((await secondClient.login(user.email, PASSWORD)).status).toBe(200);
  const firstPush = await connectPush(firstServer.server.port, firstClient.cookie ?? "");
  const secondPush = await connectPush(secondServer.server.port, secondClient.cookie ?? "");
  const firstAgent = (await helloAgent(firstServer.server.port, computer.computerId, computer.token)).agent;
  const secondAgent = (await helloAgent(secondServer.server.port, computer.computerId, computer.token)).agent;
  const firstGate = firstDb.arm(/"accounts"\."id" <>/);
  const secondGate = secondDb.arm(/"accounts"\."id" <>/);
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

  try {
    firstAgent.send({ type: "login_state", accountId: firstId, state: { login: "valid", handle: "乙" } });
    await firstGate.reached;
    secondAgent.send({ type: "login_state", accountId: secondId, state: { login: "valid", handle: "甲" } });
    // 第二个要么也锁住了自己的行走到屏障，要么被电脑级的锁排在了第一个后面。
    await Promise.race([secondGate.reached, advisoryWaiter()]);
    firstGate.release();
    await secondGate.reached;
    secondGate.release();

    firstAgent.send({
      type: "login_state",
      accountId: firstId,
      state: { login: "failed", reason: "window_failed", attempt: LoginAttemptId.parse("sentinel-1") },
    });
    secondAgent.send({
      type: "login_state",
      accountId: secondId,
      state: { login: "failed", reason: "window_failed", attempt: LoginAttemptId.parse("sentinel-2") },
    });
    for (const push of [firstPush, secondPush]) {
      for (;;) {
        const event = await push.next();
        if (event.type === "login_failed") break;
      }
    }
    const rows = await database.db
      .select({ id: accounts.id, generation: accounts.loginGeneration })
      .from(accounts)
      .where(inArray(accounts.id, [firstId, secondId]));
    expect(
      Object.fromEntries(rows.map((row) => [row.id, row.generation])),
      "两次登录成功都记进了各自的代次，没有一次被 deadlock 吃掉",
    ).toEqual({ [firstId]: 2, [secondId]: 2 });
  } finally {
    firstGate.release();
    secondGate.release();
    firstAgent.close();
    secondAgent.close();
    firstPush.close();
    secondPush.close();
    await firstServer.close();
    await secondServer.close();
    await database.close();
  }
}, 15_000);
