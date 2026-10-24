import {
  GroupId,
  MetricSource,
  UserId,
  metricKeyOf,
  type MetricReading,
  type TaskMetric,
  type TopicTask,
} from "@baize/shared";
import { and, eq, exists, gte, inArray, isNull, lt, notExists, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { accounts, groups, metricSamples, tasks } from "../db/schema.js";
import { newId } from "../ids.js";
import { isPolled, platformOfPolled, type PolledMetricKind, type PolledMetricSource } from "../metrics/readers.js";
import { groupIsLive } from "./live-groups.js";
import type { Tx } from "./messages.js";
import { weekStart } from "./usage.js";

export type MetricSampleSource = "manual" | "reported" | PolledMetricKind;

export type GroupMetrics = ReadonlyMap<string | null, TaskMetric>;

type MetricRow = {
  readonly groupId: string;
  readonly metric: string | null;
  readonly current: string;
  readonly sampledAt: string;
  readonly latestBeforeWeek: boolean;
  readonly beforeWeek: string | null;
  readonly firstThisWeek: string | null;
};

/**
 * 每个群每条序列的最新样本和本周变化。本周从周一 00:00 上海时区起（D18）：最新值减周一之前的最后一个样本；
 * 周一之前一个样本都没有就减本周第一个；最新样本本身在周一之前，本周就是没动，记 0。
 * 三个样本必须出自同一条语句：分开查各拿各的快照，夹在中间的写入能拼出一个从没存在过的变化。
 * 先后一律按 sampled_at、再按 id，最新和首个互为反序。
 */
export async function metricsOf(
  db: Db | Tx,
  groupIds: readonly string[],
  now: Date,
): Promise<Map<string, GroupMetrics>> {
  if (groupIds.length === 0) return new Map();
  const start = weekStart(now);
  const ofGroups = inArray(metricSamples.groupId, [...groupIds]);
  const rows = await db.execute<MetricRow>(sql`
    with latest as (
      select distinct on (group_id, metric) group_id, metric, value, sampled_at from ${metricSamples}
      where ${ofGroups} order by group_id, metric, sampled_at desc, id desc
    ), before_week as (
      select distinct on (group_id, metric) group_id, metric, value from ${metricSamples}
      where ${and(ofGroups, lt(metricSamples.sampledAt, start))} order by group_id, metric, sampled_at desc, id desc
    ), first_this_week as (
      select distinct on (group_id, metric) group_id, metric, value from ${metricSamples}
      where ${and(ofGroups, gte(metricSamples.sampledAt, start))} order by group_id, metric, sampled_at asc, id asc
    )
    select latest.group_id as "groupId",
      latest.metric as "metric",
      latest.value::text as "current",
      to_char(latest.sampled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "sampledAt",
      latest.sampled_at < ${start.toISOString()}::timestamptz as "latestBeforeWeek",
      before_week.value::text as "beforeWeek",
      first_this_week.value::text as "firstThisWeek"
    from latest
    left join before_week
      on before_week.group_id = latest.group_id and before_week.metric is not distinct from latest.metric
    left join first_this_week
      on first_this_week.group_id = latest.group_id and first_this_week.metric is not distinct from latest.metric
  `);

  const metrics = new Map<string, Map<string | null, TaskMetric>>();
  for (const row of rows) {
    const current = Number(row.current);
    const baseline = row.latestBeforeWeek ? row.current : (row.beforeWeek ?? row.firstThisWeek);
    const series = metrics.get(row.groupId) ?? new Map<string | null, TaskMetric>();
    series.set(row.metric, {
      current,
      weekDelta: baseline === null ? 0 : current - Number(baseline),
      sampledAt: row.sampledAt,
    });
    metrics.set(row.groupId, series);
  }
  return metrics;
}

export const goalMetricOf = (task: TopicTask, series: GroupMetrics | undefined): TaskMetric | null =>
  series?.get(task.goal?.metric ?? null) ?? null;

async function connectedAccounts(db: Db | Tx, tasksIn: readonly TopicTask[]): Promise<Map<string, Set<string>>> {
  const accountIds = [
    ...new Set(tasksIn.flatMap((task) => task.metricSources.filter(isPolled).map((source) => source.accountId))),
  ];
  const connected = new Map<string, Set<string>>();
  if (accountIds.length === 0) return connected;
  const rows = await db
    .select({ groupId: groups.id, accountId: accounts.id, platform: accounts.platform })
    .from(groups)
    .innerJoin(accounts, eq(accounts.ownerId, groups.ownerId))
    .where(
      and(
        inArray(
          groups.id,
          tasksIn.map((task) => task.groupId),
        ),
        inArray(accounts.id, accountIds),
        eq(accounts.via, "api"),
        eq(accounts.login, "valid"),
      ),
    );
  for (const row of rows) {
    const set = connected.get(row.groupId) ?? new Set<string>();
    set.add(`${row.accountId}:${row.platform}`);
    connected.set(row.groupId, set);
  }
  return connected;
}

export async function withMetrics(db: Db | Tx, tasksIn: readonly TopicTask[], now = new Date()): Promise<TopicTask[]> {
  const series = await metricsOf(
    db,
    tasksIn.map((task) => task.groupId),
    now,
  );
  const connected = await connectedAccounts(db, tasksIn);
  return tasksIn.map((task) => {
    const ofGroup = series.get(task.groupId);
    const accountsOfGroup = connected.get(task.groupId);
    const metrics = task.metricSources.map((source): MetricReading => {
      const key = metricKeyOf(source);
      return {
        key,
        metric: ofGroup?.get(key) ?? null,
        account: isPolled(source)
          ? accountsOfGroup?.has(`${source.accountId}:${platformOfPolled(source)}`)
            ? "connected"
            : "disconnected"
          : null,
      };
    });
    return { ...task, metric: goalMetricOf(task, ofGroup), metrics };
  });
}

export async function withMetric(db: Db | Tx, task: TopicTask, now = new Date()): Promise<TopicTask> {
  const [out] = await withMetrics(db, [task], now);
  if (out === undefined) throw new Error(`任务卡 ${task.id} 填读数时丢了`);
  return out;
}

const sampledSince = (db: Db | Tx, metric: string, source: MetricSampleSource, since: Date) =>
  db
    .select({ one: sql`1` })
    .from(metricSamples)
    .where(
      and(
        eq(metricSamples.groupId, groups.id),
        eq(metricSamples.metric, metric),
        eq(metricSamples.source, source),
        gte(metricSamples.sampledAt, since),
      ),
    );

export type PollSlot = { readonly sampledAt: Date; readonly windowStart: Date };

/** 插一行样本，群不是本人的项目群（多 Bot 群、成员没删光）或 extra 不成立就不插。 */
async function insertSample(
  db: Db | Tx,
  ownerId: UserId,
  groupId: GroupId,
  metric: string | null,
  value: number,
  source: MetricSampleSource,
  sampledAt: SQL,
  extra?: SQL,
): Promise<GroupId | null> {
  const [row] = await db
    .insert(metricSamples)
    .select(
      db
        .select({
          id: sql`${newId()}`.as("id"),
          groupId: groups.id,
          metric: sql`${metric}::text`.as("metric"),
          value: sql`${String(value)}::numeric`.as("value"),
          source: sql`${source}`.as("source"),
          sampledAt: sampledAt.as("sampled_at"),
        })
        .from(groups)
        .where(
          and(eq(groups.id, groupId), eq(groups.ownerId, ownerId), isNull(groups.soloBotId), groupIsLive(db), extra),
        ),
    )
    .returning({ groupId: metricSamples.groupId });
  return row === undefined ? null : GroupId.parse(row.groupId);
}

type PickMetric = (task: {
  readonly keys: readonly string[];
  readonly goal: string | null;
}) => string | null | undefined;

export type RecordedSample =
  | { readonly kind: "recorded"; readonly groupId: GroupId }
  | { readonly kind: "not_found" }
  | { readonly kind: "unknown_metric" };

/**
 * 读任务卡时拿行的 share 锁，改指标的 PATCH 要等这一笔落完，
 * 不会记到一个刚摘掉的指标上。采样时间取库里的 clock_timestamp()，微秒精度，
 * 同一毫秒里先后两次记数也分得出先后；id 是随机的，只在时间完全相同时兜底。
 */
export function recordSample(
  db: Db | Tx,
  ownerId: UserId,
  groupId: GroupId,
  value: number,
  source: "manual" | "reported",
  pick: PickMetric,
): Promise<RecordedSample> {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select({ sources: tasks.metricSources, goal: tasks.goalMetric })
      .from(tasks)
      .innerJoin(groups, eq(groups.id, tasks.groupId))
      .where(and(eq(groups.id, groupId), eq(groups.ownerId, ownerId), isNull(groups.soloBotId), groupIsLive(tx)))
      .for("share", { of: tasks });
    if (task === undefined) return { kind: "not_found" };
    const metric = pick({ keys: task.sources.map(metricKeyOf), goal: task.goal });
    if (metric === undefined) return { kind: "unknown_metric" };
    const recorded = await insertSample(tx, ownerId, groupId, metric, value, source, sql`clock_timestamp()`);
    return recorded === null ? { kind: "not_found" } : { kind: "recorded", groupId: recorded };
  });
}

/**
 * 没有唯一约束兜底，靠按 (群, 指标, 格) 算键的事务级 advisory 锁让同一格的写排队：
 * 拿到锁之后的下一条语句换新快照，看得见先提交的那条。取锁和 NOT EXISTS 不能合成一条语句，
 * 同一条语句里的子查询用的还是等锁之前的快照。这个事务只拿这一把锁、只插新行，排在任何锁序的最末。
 */
export function recordPolledSample(
  db: Db,
  ownerId: UserId,
  groupId: GroupId,
  source: PolledMetricSource,
  value: number,
  slot: PollSlot,
): Promise<GroupId | null> {
  const metric = metricKeyOf(source);
  return db.transaction(async (tx) => {
    const key = `metric-slot:${groupId}:${metric}:${slot.windowStart.toISOString()}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    const stillPolled = exists(
      tx
        .select({ one: sql`1` })
        .from(tasks)
        .where(
          and(
            eq(tasks.groupId, groups.id),
            eq(tasks.status, "active"),
            sql`${tasks.metricSources} @> ${JSON.stringify([source])}::jsonb`,
          ),
        ),
    );
    return insertSample(
      tx,
      ownerId,
      groupId,
      metric,
      value,
      source.kind,
      sql`${slot.sampledAt.toISOString()}::timestamptz`,
      and(notExists(sampledSince(tx, metric, source.kind, slot.windowStart)), stillPolled),
    );
  });
}

export type DueMetric = {
  readonly groupId: GroupId;
  readonly ownerId: UserId;
  readonly source: PolledMetricSource;
};

export async function duePolledMetrics(db: Db, windowStart: Date): Promise<DueMetric[]> {
  const projects = await db
    .select({ groupId: groups.id, ownerId: groups.ownerId, sources: tasks.metricSources })
    .from(tasks)
    .innerJoin(groups, eq(groups.id, tasks.groupId))
    .where(
      and(
        sql`jsonb_array_length(${tasks.metricSources}) > 0`,
        eq(tasks.status, "active"),
        isNull(groups.soloBotId),
        groupIsLive(db),
      ),
    );
  const candidates = projects.flatMap((project) =>
    project.sources
      .map((raw) => MetricSource.parse(raw))
      .filter(isPolled)
      .map((source) => ({ groupId: GroupId.parse(project.groupId), ownerId: UserId.parse(project.ownerId), source })),
  );
  if (candidates.length === 0) return [];

  const usable = await db
    .select({ id: accounts.id, ownerId: accounts.ownerId, platform: accounts.platform })
    .from(accounts)
    .where(
      and(
        inArray(accounts.id, [...new Set(candidates.map(({ source }) => source.accountId))]),
        eq(accounts.via, "api"),
        eq(accounts.login, "valid"),
      ),
    );
  const accountOk = new Set(usable.map((account) => `${account.id}:${account.ownerId}:${account.platform}`));
  const sampled = await db
    .select({ groupId: metricSamples.groupId, metric: metricSamples.metric, source: metricSamples.source })
    .from(metricSamples)
    .where(
      and(
        inArray(metricSamples.groupId, [...new Set(candidates.map(({ groupId }) => groupId))]),
        gte(metricSamples.sampledAt, windowStart),
      ),
    );
  const done = new Set(sampled.map((row) => `${row.groupId}:${row.source}:${row.metric}`));
  return candidates.filter(
    ({ groupId, ownerId, source }) =>
      accountOk.has(`${source.accountId}:${ownerId}:${platformOfPolled(source)}`) &&
      !done.has(`${groupId}:${source.kind}:${metricKeyOf(source)}`),
  );
}
