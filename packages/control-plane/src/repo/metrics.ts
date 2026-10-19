import { AccountId, GroupId, MetricSource, UserId, type TaskMetric, type TopicTask } from "@baize/shared";
import { and, eq, exists, gte, inArray, isNull, lt, notExists, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { accounts, groups, metricSamples, tasks } from "../db/schema.js";
import { newId } from "../ids.js";
import { groupIsLive } from "./live-groups.js";
import type { Tx } from "./messages.js";
import { weekStart } from "./usage.js";

export type MetricSampleSource = "manual" | "github_stars" | "reported";

type MetricRow = {
  readonly groupId: string;
  readonly current: string;
  readonly sampledAt: string;
  readonly latestBeforeWeek: boolean;
  readonly beforeWeek: string | null;
  readonly firstThisWeek: string | null;
};

/**
 * 每个群的最新样本和本周变化。本周从周一 00:00 上海时区起（D18）：最新值减周一之前的最后一个样本；
 * 周一之前一个样本都没有就减本周第一个；最新样本本身在周一之前，本周就是没动，记 0。
 * 三个样本必须出自同一条语句：分开查各拿各的快照，夹在中间的写入能拼出一个从没存在过的变化。
 * 先后一律按 sampled_at、再按 id，最新和首个互为反序。
 */
export async function metricsOf(db: Db | Tx, groupIds: readonly string[], now: Date): Promise<Map<string, TaskMetric>> {
  if (groupIds.length === 0) return new Map();
  const start = weekStart(now);
  const ofGroups = inArray(metricSamples.groupId, [...groupIds]);
  const rows = await db.execute<MetricRow>(sql`
    with latest as (
      select distinct on (group_id) group_id, value, sampled_at from ${metricSamples}
      where ${ofGroups} order by group_id, sampled_at desc, id desc
    ), before_week as (
      select distinct on (group_id) group_id, value from ${metricSamples}
      where ${and(ofGroups, lt(metricSamples.sampledAt, start))} order by group_id, sampled_at desc, id desc
    ), first_this_week as (
      select distinct on (group_id) group_id, value from ${metricSamples}
      where ${and(ofGroups, gte(metricSamples.sampledAt, start))} order by group_id, sampled_at asc, id asc
    )
    select latest.group_id as "groupId",
      latest.value::text as "current",
      to_char(latest.sampled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "sampledAt",
      latest.sampled_at < ${start.toISOString()}::timestamptz as "latestBeforeWeek",
      before_week.value::text as "beforeWeek",
      first_this_week.value::text as "firstThisWeek"
    from latest
    left join before_week using (group_id)
    left join first_this_week using (group_id)
  `);

  const metrics = new Map<string, TaskMetric>();
  for (const row of rows) {
    const current = Number(row.current);
    const baseline = row.latestBeforeWeek ? row.current : (row.beforeWeek ?? row.firstThisWeek);
    metrics.set(row.groupId, {
      current,
      weekDelta: baseline === null ? 0 : current - Number(baseline),
      sampledAt: row.sampledAt,
    });
  }
  return metrics;
}

/** 任务卡从行上读不出指标，出边界前都过这一道，推出去的 task_updated 才不会把 Web 上的当前值冲成 null。 */
export async function withMetric(db: Db | Tx, task: TopicTask, now = new Date()): Promise<TopicTask> {
  const metric = (await metricsOf(db, [task.groupId], now)).get(task.groupId) ?? null;
  return { ...task, metric };
}

/** 外层查询里 groups 那一行的群，从 since 起已经有这个来源的样本。 */
const sampledSince = (db: Db | Tx, source: MetricSampleSource, since: Date) =>
  db
    .select({ one: sql`1` })
    .from(metricSamples)
    .where(
      and(eq(metricSamples.groupId, groups.id), eq(metricSamples.source, source), gte(metricSamples.sampledAt, since)),
    );

/** 轮询取样的那一格：采样时刻由轮询的时钟定，这一格里同一来源已经有样本就不再落。 */
export type PollSlot = { readonly sampledAt: Date; readonly windowStart: Date };

/** 插一行样本，群不是本人的项目群（多 Bot 群、成员没删光）或 extra 不成立就不插。 */
async function insertSample(
  db: Db | Tx,
  ownerId: UserId,
  groupId: GroupId,
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

/**
 * 记一个样本。只认本人的项目群，别的一律不落，返回 null 让路由回 404。
 * 判定和插入在同一条语句里，不先查后写。采样时间取库里的 clock_timestamp()，微秒精度，
 * 同一毫秒里先后两次记数也分得出先后；id 是随机的，只在时间完全相同时兜底。
 */
export function recordSample(
  db: Db | Tx,
  ownerId: UserId,
  groupId: GroupId,
  value: number,
  source: MetricSampleSource,
): Promise<GroupId | null> {
  return insertSample(db, ownerId, groupId, value, source, sql`clock_timestamp()`);
}

/**
 * 轮询记一个样本：这一格同一来源已经有样本、或者项目已经不是 active，返回 null。
 * 没有唯一约束兜底，靠按 (群, 来源, 格) 算键的事务级 advisory 锁让同一格的写排队：
 * 拿到锁之后的下一条语句换新快照，看得见先提交的那条。取锁和 NOT EXISTS 不能合成一条语句，
 * 同一条语句里的子查询用的还是等锁之前的快照。这个事务只拿这一把锁、只插新行，排在任何锁序的最末。
 * 项目在读平台期间被标成 done 的，这里再判一次，不落。
 */
export function recordPolledSample(
  db: Db,
  ownerId: UserId,
  groupId: GroupId,
  value: number,
  source: MetricSampleSource,
  slot: PollSlot,
): Promise<GroupId | null> {
  return db.transaction(async (tx) => {
    const key = `metric-slot:${groupId}:${source}:${slot.windowStart.toISOString()}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    const stillActive = exists(
      tx
        .select({ one: sql`1` })
        .from(tasks)
        .where(and(eq(tasks.groupId, groups.id), eq(tasks.status, "active"))),
    );
    return insertSample(
      tx,
      ownerId,
      groupId,
      value,
      source,
      sql`${slot.sampledAt.toISOString()}::timestamptz`,
      and(notExists(sampledSince(tx, source, slot.windowStart)), stillActive),
    );
  });
}

export type GithubStarsProject = {
  readonly groupId: GroupId;
  readonly ownerId: UserId;
  readonly accountId: AccountId;
  readonly repo: string;
};

/**
 * 这一格还没取过 GitHub 星数的项目。账号要是这个项目主人的、登录还有效的 GitHub 账号，
 * 过期的不拿去读平台，也就不落样本、不推东西；做完的项目不再读。
 */
export async function dueGithubStarsProjects(db: Db, windowStart: Date): Promise<GithubStarsProject[]> {
  const rows = await db
    .select({ groupId: groups.id, ownerId: groups.ownerId, source: tasks.metricSource })
    .from(tasks)
    .innerJoin(groups, eq(groups.id, tasks.groupId))
    .innerJoin(
      accounts,
      and(
        eq(accounts.id, sql`${tasks.metricSource}->>'accountId'`),
        eq(accounts.ownerId, groups.ownerId),
        eq(accounts.platform, "github"),
        eq(accounts.login, "valid"),
      ),
    )
    .where(
      and(
        sql`${tasks.metricSource}->>'kind' = 'github_stars'`,
        eq(tasks.status, "active"),
        isNull(groups.soloBotId),
        groupIsLive(db),
        notExists(sampledSince(db, "github_stars", windowStart)),
      ),
    );
  return rows.flatMap((row) => {
    const source = MetricSource.parse(row.source);
    if (source.kind !== "github_stars") return [];
    return [
      {
        groupId: GroupId.parse(row.groupId),
        ownerId: UserId.parse(row.ownerId),
        accountId: source.accountId,
        repo: source.repo,
      },
    ];
  });
}
