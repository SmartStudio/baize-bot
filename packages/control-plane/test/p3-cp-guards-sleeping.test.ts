import type { ComputerId, UserId } from "@baize/shared";
import { expect, it } from "vitest";
import { connect, type Sql } from "../src/db/client.js";
import { databaseUrl } from "../src/env.js";
import { ensureComputer, markComputersSleeping, markOnlineComputersSleeping } from "../src/repo/computers.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { makeComputer, makeUser, waitFor } from "./helpers/fixtures.js";
import { gatedDb } from "./helpers/gated-db.js";

/** 批量休眠的锁序用例要手工造交错，所以直接调 repo 函数：HTTP 层碰不到「两个实例各拿一半 owner 锁」。 */

const OWNER_LOCK_CLASS = 1652191095;
const OWNER_LOCK_SHARED = /^SELECT pg_advisory_xact_lock_shared\(/;

/** 和 createTestDb 的池分开，探测和模拟删号不占被测事务的连接。 */
function sideClient(database: TestDb, max: number): Sql {
  const url = new URL(databaseUrl());
  url.pathname = `/${database.databaseName}`;
  return connect(url.toString(), { max }).sql;
}

async function makeOnlineOwner(database: TestDb, kinds: readonly ("local" | "remote")[] = ["local"]) {
  const user = await makeUser(database.db);
  const computerIds: ComputerId[] = [];
  for (const kind of kinds) {
    const computerId =
      kind === "local"
        ? (await makeComputer(database.db, user.id)).computerId
        : (await ensureComputer(database.db, user.id, kind)).computer.id;
    computerIds.push(computerId);
  }
  return { ownerId: user.id, computerIds };
}

async function setOnline(database: TestDb, computerId: ComputerId): Promise<void> {
  await database.sql`UPDATE computers SET status = 'online' WHERE id = ${computerId}`;
}

async function statuses(database: TestDb): Promise<string[]> {
  const rows = await database.sql<{ status: string }[]>`SELECT status FROM computers ORDER BY id`;
  return rows.map((row) => row.status);
}

it("两个批量休眠以相反次序碰到同两个归属人：owner 锁按升序拿，共享请求不会排在等着的删号后面成环", async () => {
  const database = await createTestDb();
  const side = sideClient(database, 3);
  try {
    const a = await makeOnlineOwner(database);
    const b = await makeOnlineOwner(database);
    const [computerA, computerB] = [a.computerIds[0], b.computerIds[0]];
    if (computerA === undefined || computerB === undefined) throw new Error("没建出电脑");
    await setOnline(database, computerA);
    await setOnline(database, computerB);

    // 全表扫描按堆里的物理次序读快照：第一个批量先读到 A 再读到 B，改写 A 的行把它挪到堆尾之后，第二个读到 B 再读到 A。
    const first = gatedDb(database.sql);
    const second = gatedDb(database.sql);
    const firstHeld = first.arm(OWNER_LOCK_SHARED, "after");
    const sweepFirst = markOnlineComputersSleeping(first.db);
    await firstHeld.reached;
    await side`UPDATE computers SET last_seen_at = now() WHERE id = ${computerA}`;
    const secondHeld = second.arm(OWNER_LOCK_SHARED, "after");
    const sweepSecond = markOnlineComputersSleeping(second.db);
    await secondHeld.reached;

    // 删号要这个人的排他锁，排在共享锁后面，后到的共享请求也得排在它后面。
    let finishedDeletes = 0;
    const deleteOwner = (ownerId: UserId) =>
      side
        .begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(${OWNER_LOCK_CLASS}::int4, hashtext(${ownerId}::text))`;
        })
        .finally(() => (finishedDeletes += 1));
    const deleteA = deleteOwner(a.ownerId);
    const deleteB = deleteOwner(b.ownerId);
    await waitFor(async () => {
      const [waiting] = await side<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted AND classid = ${OWNER_LOCK_CLASS}::oid
          AND objid IN (hashtext(${a.ownerId})::oid, hashtext(${b.ownerId})::oid)`;
      return (waiting?.n ?? 0) + finishedDeletes === 2;
    }, "两个删号都排上队或已拿到锁");

    const sharedWaiting = async () => {
      const [waiting] = await side<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted AND mode = 'ShareLock' AND classid = ${OWNER_LOCK_CLASS}::oid
          AND objid IN (hashtext(${a.ownerId})::oid, hashtext(${b.ownerId})::oid)`;
      return waiting?.n ?? 0;
    };
    firstHeld.release();
    secondHeld.release();
    // 按相反次序拿共享锁时，两个批量各占一把、各等对方那把，排在它们前面的排他请求把这个环锁死。
    // Postgres 把这种只经过等待队列的环当软死锁，等满 deadlock_timeout 才重排队列放行，不报错，所以靠「共享请求从没排过队」钉住。
    const progress = { sweepsDone: false };
    const sweeps = Promise.allSettled([sweepFirst, sweepSecond]).then((settled) => {
      progress.sweepsDone = true;
      return settled;
    });
    let sharedRequestQueued = false;
    while (!progress.sweepsDone) {
      if ((await sharedWaiting()) > 0) sharedRequestQueued = true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(sharedRequestQueued, "两个批量休眠都从最小的归属人开始拿，共享请求不会排到别人的排他请求后面").toBe(false);
    const outcomes = [...(await sweeps), ...(await Promise.allSettled([deleteA, deleteB]))];
    expect(
      outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [String(outcome.reason)] : [])),
      "两个批量休眠和两个删号都要完成，不能有一方被判为死锁牺牲品",
    ).toEqual([]);
    expect(await statuses(database)).toEqual(["sleeping", "sleeping"]);
  } finally {
    await side.end();
    await database.close();
  }
});

it("同一归属人的两台电脑被两个批量休眠以相反次序扫到：电脑行按 id 升序锁，两边排队而不互等", async () => {
  const database = await createTestDb();
  const side = sideClient(database, 2);
  const blocker = sideClient(database, 1);
  try {
    const owner = await makeOnlineOwner(database, ["local", "remote"]);
    const [small, big] = owner.computerIds.toSorted();
    if (small === undefined || big === undefined) throw new Error("没建出两台电脑");
    // 按 id 命中的批量读索引，次序是 small, big；按 status 命中的批量全表扫描，次序是堆里的物理次序，这里排成 big, small。
    await setOnline(database, big);
    await setOnline(database, small);

    let releaseBlocker!: () => void;
    const holdBlocker = new Promise<void>((resolve) => (releaseBlocker = resolve));
    let blockerHolds!: () => void;
    const blockerHeld = new Promise<void>((resolve) => (blockerHolds = resolve));
    const blocking = blocker.begin(async (tx) => {
      await tx`SELECT id FROM computers WHERE id = ${small} FOR UPDATE`;
      blockerHolds();
      await holdBlocker;
    });
    await blockerHeld;

    const waitingOnRows = async () => {
      const [row] = await side<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = ${database.databaseName} AND wait_event_type = 'Lock' AND query ILIKE '%for no key update%'`;
      return row?.n ?? 0;
    };
    const byId = markComputersSleeping(database.db, [big, small]);
    await waitFor(async () => (await waitingOnRows()) === 1, "按 id 的批量卡在被占住的最小 id 上");
    const byStatus = markOnlineComputersSleeping(database.db);
    await waitFor(async () => (await waitingOnRows()) === 2, "按 status 的批量也卡在行锁上");

    releaseBlocker();
    const outcomes = await Promise.allSettled([blocking, byId, byStatus]);
    expect(
      outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [String(outcome.reason)] : [])),
      "两个批量休眠都要完成，不能有一方被判为死锁牺牲品",
    ).toEqual([]);
    expect(await statuses(database)).toEqual(["sleeping", "sleeping"]);
  } finally {
    await side.end();
    await blocker.end();
    await database.close();
  }
});

it("归属人多于一批：每个事务持有的 owner 锁不超过批大小，全部电脑仍被标成休眠", async () => {
  const database = await createTestDb();
  const side = sideClient(database, 1);
  try {
    for (let n = 0; n < 5; n += 1) {
      const owner = await makeOnlineOwner(database, ["local", "remote"]);
      for (const computerId of owner.computerIds) await setOnline(database, computerId);
    }
    const heldByOneTransaction = async () => {
      const [row] = await side<{ n: number }[]>`
        SELECT coalesce(max(held), 0)::int AS n FROM (
          SELECT count(*) AS held FROM pg_locks
          WHERE locktype = 'advisory' AND granted AND classid = ${OWNER_LOCK_CLASS}::oid
            AND database = (SELECT oid FROM pg_database WHERE datname = ${database.databaseName})
          GROUP BY pid) per_transaction`;
      return row?.n ?? 0;
    };

    const gate = gatedDb(database.sql);
    const BATCH_UPDATE = /^update "computers" set "status"/;
    let current = gate.arm(BATCH_UPDATE, "before");
    const sweeping = markOnlineComputersSleeping(gate.db, 2);
    const held: number[] = [];
    for (;;) {
      const reached = await Promise.race([current.reached.then(() => true), sweeping.then(() => false)]);
      if (!reached) break;
      held.push(await heldByOneTransaction());
      const next = gate.arm(BATCH_UPDATE, "before");
      current.release();
      current = next;
    }
    current.release();
    await sweeping;

    expect(held, "5 个归属人按每批 2 个分成 3 个事务，写电脑行时各自持有 2、2、1 把 owner 锁").toEqual([2, 2, 1]);
    expect(await statuses(database)).toEqual(Array<string>(10).fill("sleeping"));
  } finally {
    await side.end();
    await database.close();
  }
});
