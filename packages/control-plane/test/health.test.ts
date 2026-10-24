import postgres from "postgres";
import { expect, it } from "vitest";
import { databaseUrl } from "../src/env.js";
import { helloAgent } from "./helpers/agent.js";
import { startTestServer } from "./helpers/client.js";
import { createTestDb } from "./helpers/db.js";
import { makeComputer, makeUser } from "./helpers/fixtures.js";
import { gatedDb } from "./helpers/gated-db.js";

const HEALTH_PROBE = /^SELECT 1$/;
const BATCH_SLEEP = /^update "computers" set "status".*"computers"\."id" in \(/;

async function withAdmin<T>(run: (admin: postgres.Sql) => Promise<T>): Promise<T> {
  const admin = postgres(databaseUrl(), { max: 1 });
  try {
    return await run(admin);
  } finally {
    await admin.end();
  }
}

function cutDatabase(name: string): Promise<unknown> {
  return withAdmin(async (admin) => {
    await admin`ALTER DATABASE ${admin(name)} WITH ALLOW_CONNECTIONS false`;
    await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${name}`;
  });
}

function restoreDatabase(name: string): Promise<unknown> {
  return withAdmin((admin) => admin`ALTER DATABASE ${admin(name)} WITH ALLOW_CONNECTIONS true`);
}

it("健康检查不用登录，库连得上回 200，库断了回 503，库回来又是 200", async () => {
  const database = await createTestDb();
  const server = await startTestServer(database.db);
  const client = server.client();
  try {
    const healthy = await client.get("/api/health");
    expect(healthy.status, "没登录也能探活").toBe(200);
    expect(await healthy.json()).toEqual({ ok: true });

    await cutDatabase(database.databaseName);
    const down = await client.get("/api/health");
    expect(down.status, "库断了就不健康").toBe(503);
    expect(await down.json()).toEqual({ ok: false, error: "连不上数据库" });

    await restoreDatabase(database.databaseName);
    expect((await client.get("/api/health")).status, "库回来连接池自己重连").toBe(200);
  } finally {
    await restoreDatabase(database.databaseName);
    await server.close();
    await database.close();
  }
});

it("库卡住不回话时健康检查 2 秒左右回 503，不跟着查询一起挂", async () => {
  const database = await createTestDb();
  const gated = gatedDb(database.sql);
  const server = await startTestServer(gated.db);
  const stuck = gated.arm(HEALTH_PROBE, "before");
  try {
    const started = performance.now();
    const response = await server.client().get("/api/health");
    const elapsed = performance.now() - started;
    await stuck.reached;
    expect(response.status, "查询还卡着，健康检查先给出不健康").toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "连不上数据库" });
    expect(elapsed, "等满 2 秒的超时再下结论").toBeGreaterThanOrEqual(1_900);
    expect(elapsed, "不等连接池自己的 30 秒").toBeLessThan(4_000);
  } finally {
    stuck.release();
    await server.close();
    await database.close();
  }
});

it("停机开始后健康检查回 503，编排器不再把流量导进来", async () => {
  const database = await createTestDb();
  const gated = gatedDb(database.sql);
  const server = await startTestServer(gated.db);
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  const sleep = gated.arm(BATCH_SLEEP, "before");
  const closed = server.close();
  try {
    await sleep.reached;
    const stopping = await server.client().get("/api/health");
    expect(stopping.status, "停机中库还连得上，也不算健康").toBe(503);
    expect(await stopping.json()).toEqual({ ok: false, error: "控制面正在停机" });
  } finally {
    sleep.release();
    await closed;
    agent.close();
    await database.close();
  }
});
