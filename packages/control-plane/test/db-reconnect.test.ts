import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterEach, expect, it } from "vitest";
import { connect, type Sql } from "../src/db/client.js";
import { databaseUrl } from "../src/env.js";

const NOT_ACCEPTING_CONNECTIONS = "55000";
const SETTLE_LIMIT_MS = 5_000;

const cleanups: (() => Promise<void>)[] = [];

// 每个收尾各自兜住：前一个抛了，后面的照样跑，不留下 ALLOW_CONNECTIONS false 的库。
afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).toReversed()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "db-reconnect 收尾有多处失败");
});

async function withAdmin<T>(run: (admin: postgres.Sql) => Promise<T>): Promise<T> {
  const admin = postgres(databaseUrl(), { max: 1 });
  try {
    return await run(admin);
  } finally {
    await admin.end();
  }
}

async function scratchDatabase(): Promise<{ name: string; url: string }> {
  const name = `baize_test_${randomBytes(6).toString("hex")}`;
  await withAdmin((admin) => admin`CREATE DATABASE ${admin(name)}`);
  cleanups.push(() =>
    withAdmin(async (admin) => {
      await admin`ALTER DATABASE ${admin(name)} WITH ALLOW_CONNECTIONS true`;
      await admin`DROP DATABASE ${admin(name)} WITH (FORCE)`;
    }),
  );
  const url = new URL(databaseUrl());
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

function singleConnection(url: string): Sql {
  const { sql } = connect(url, { max: 1 });
  cleanups.push(() => sql.end({ timeout: 0 }));
  return sql;
}

type Settled =
  { readonly status: "ok"; readonly value: unknown } | { readonly status: "error"; readonly code: unknown };

function settle(query: Promise<unknown>): Promise<Settled> {
  return query.then(
    (value) => ({ status: "ok", value }),
    (error: unknown) => ({ status: "error", code: (error as { code?: unknown }).code }),
  );
}

function within(settled: Promise<Settled>, ms: number): Promise<Settled | "still_pending"> {
  return Promise.race([
    settled,
    new Promise<"still_pending">((resolve) => setTimeout(() => resolve("still_pending"), ms).unref()),
  ]);
}

async function sleepInFlight(name: string, sql: Sql): Promise<{ readonly sleeping: Promise<Settled> }> {
  const sleeping = settle(sql`SELECT pg_sleep(30)`);
  await expect
    .poll(
      () =>
        withAdmin(async (admin) => {
          const [row] = await admin<{ count: number }[]>`
            SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE datname = ${name} AND state = 'active' AND query LIKE '%pg_sleep%'`;
          return row?.count;
        }),
      { timeout: 5_000 },
    )
    .toBe(1);
  return { sleeping };
}

function setAllowConnections(name: string, allow: boolean): Promise<unknown> {
  return withAdmin((admin) =>
    allow
      ? admin`ALTER DATABASE ${admin(name)} WITH ALLOW_CONNECTIONS true`
      : admin`ALTER DATABASE ${admin(name)} WITH ALLOW_CONNECTIONS false`,
  );
}

function terminateBackends(name: string): Promise<unknown> {
  return withAdmin((admin) => admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${name}`);
}

it("在途查询时连接被掐、库又拒新连接：下一条查询当场被拒不挂住，库恢复后照常执行", async () => {
  const { name, url } = await scratchDatabase();
  const sql = singleConnection(url);
  const { sleeping } = await sleepInFlight(name, sql);

  await setAllowConnections(name, false);
  await terminateBackends(name);
  expect((await sleeping).status, "在途的那条随连接一起失败").toBe("error");

  const refused = await within(settle(sql`SELECT 1 AS one`), SETTLE_LIMIT_MS);
  expect(refused, "库拒连时新查询要在有限时间内被拒，不能一直挂到库恢复").toEqual({
    status: "error",
    code: NOT_ACCEPTING_CONNECTIONS,
  });

  await setAllowConnections(name, true);
  expect(
    await within(settle(sql`SELECT 1 AS one`), SETTLE_LIMIT_MS),
    "库恢复后新查询照常执行，不收到拒连时留下的旧错误",
  ).toEqual({ status: "ok", value: [{ one: 1 }] });
});

it("在途查询时连接被掐、库马上就能连：下一条查询照常执行，不收到掐断时的旧错误", async () => {
  const { name, url } = await scratchDatabase();
  const sql = singleConnection(url);
  const { sleeping } = await sleepInFlight(name, sql);

  await terminateBackends(name);
  expect((await sleeping).status, "在途的那条随连接一起失败").toBe("error");

  expect(await within(settle(sql`SELECT 1 AS one`), SETTLE_LIMIT_MS), "重连后新查询拿到自己的结果").toEqual({
    status: "ok",
    value: [{ one: 1 }],
  });
});
