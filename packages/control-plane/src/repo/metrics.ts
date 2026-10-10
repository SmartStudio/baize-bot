import { GroupId, type TaskMetric, type TopicTask, type UserId } from "@baize/shared";
import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { groups, metricSamples } from "../db/schema.js";
import { newId } from "../ids.js";
import { groupHasMembers } from "./live-groups.js";
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

/**
 * 记一个样本。只认本人的项目群（多 Bot 群、成员没删光），别的一律不落，返回 null 让路由回 404。
 * 判定和插入在同一条语句里，不先查后写。采样时间取库里的 clock_timestamp()，微秒精度，
 * 同一毫秒里先后两次记数也分得出先后；id 是随机的，只在时间完全相同时兜底。
 */
export async function recordSample(
  db: Db,
  ownerId: UserId,
  groupId: GroupId,
  value: number,
  source: MetricSampleSource,
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
          sampledAt: sql`clock_timestamp()`.as("sampled_at"),
        })
        .from(groups)
        .where(and(eq(groups.id, groupId), eq(groups.ownerId, ownerId), isNull(groups.soloBotId), groupHasMembers(db))),
    )
    .returning({ groupId: metricSamples.groupId });
  return row === undefined ? null : GroupId.parse(row.groupId);
}
