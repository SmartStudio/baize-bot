import {
  GroupId,
  type BotId,
  type ChecklistItem,
  type MetricSource,
  type ProjectGoal,
  type TaskId,
  type TopicTask,
  type UserId,
} from "@baize/shared";
import { and, asc, eq, exists, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Db } from "../db/client.js";
import { bots, groups, tasks } from "../db/schema.js";
import { groupIsLive } from "./live-groups.js";
import type { Tx } from "./messages.js";
import { withMetric } from "./metrics.js";
import { pauseGroupRoutines } from "./routines.js";
import { toTask } from "./rows.js";

// shared 只导出了 TaskStatus 的 schema，没有导出类型，从列上取回来。
type TaskRow = typeof tasks.$inferSelect;
type TaskStatus = TaskRow["status"];

export type UpdateTaskInput = {
  readonly title?: string | undefined;
  readonly summary?: string | undefined;
  readonly dueAt?: string | null | undefined;
  readonly checklist?: readonly ChecklistItem[] | undefined;
  readonly status?: TaskStatus | undefined;
  readonly cadence?: string | undefined;
  readonly goal?: ProjectGoal | null | undefined;
  readonly metricSource?: MetricSource | null | undefined;
};

/** 任务卡从这里出去都带上指标，行上没有那一份。 */
function taskOut(db: Db | Tx, row: TaskRow | undefined): Promise<TopicTask | null> {
  return row === undefined ? Promise.resolve(null) : withMetric(db, toTask(row));
}

// 成员删光的团队群当作不存在，它的任务卡也一样查不到、改不了。
const ownedLiveGroups = (db: Db, ownerId: UserId) =>
  db
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.ownerId, ownerId), groupIsLive(db)));

export type UpdatedTask = { readonly task: TopicTask; readonly pausedRoutineIds: string[] };

/**
 * 按归属人过滤。别人的任务在这里更新不到，路由层因此 404。
 * 标成 done 就是项目归档，群里的例行在同一个事务里一起停，停了的 id 回给路由层推送。
 */
export async function updateTask(
  db: Db,
  ownerId: UserId,
  taskId: TaskId,
  input: UpdateTaskInput,
): Promise<UpdatedTask | null> {
  const patch: PgUpdateSetSource<typeof tasks> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.summary !== undefined) patch.summary = input.summary;
  if (input.dueAt !== undefined) patch.dueAt = input.dueAt === null ? null : new Date(input.dueAt);
  // 清单是整份替换，不是逐项合并。
  if (input.checklist !== undefined) patch.checklist = stampedChecklist(input.checklist, tasks.checklist);
  if (input.status !== undefined) patch.status = input.status;
  if (input.cadence !== undefined) patch.cadence = input.cadence;
  // 目标三列整个替换，给 null 三列一起清空，不会剩下半个目标。
  const { goal } = input;
  if (goal !== undefined) {
    patch.goalTarget = goal === null ? null : goal.target;
    patch.goalUnit = goal === null ? null : goal.unit;
    patch.goalDueAt = goal === null || goal.dueAt === null ? null : new Date(goal.dueAt);
  }
  if (input.metricSource !== undefined) patch.metricSource = input.metricSource;
  if (Object.keys(patch).length === 0) {
    const task = await findTask(db, ownerId, taskId);
    return task === null ? null : { task, pausedRoutineIds: [] };
  }

  // drizzle 的 update 不能 join，归属只能靠这个子查询过滤。
  const owned = and(eq(tasks.id, taskId), inArray(tasks.groupId, ownedLiveGroups(db, ownerId)));
  return db.transaction(async (tx) => {
    // 先停例行再改任务卡：删 Bot 是先改例行、再级联碰任务卡，两边同序才不会互等。
    const pausedRoutineIds =
      input.status === "done"
        ? await pauseGroupRoutines(tx, tx.select({ groupId: tasks.groupId }).from(tasks).where(owned))
        : [];
    const [row] = await tx.update(tasks).set(patch).where(owned).returning();
    if (row === undefined) return null;
    const task = await taskOut(tx, row);
    return task === null ? null : { task, pausedRoutineIds };
  });
}

/** 群和主题任务一一对应，派活拿它取当前经手和要送进 prompt 的那张卡。 */
export async function findTaskByGroup(db: Db, groupId: string): Promise<TopicTask | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.groupId, groupId)).limit(1);
  return taskOut(db, row);
}

/**
 * 用户 @ 谁谁就成为当前经手：上一位的 handled 记录补上 to，新一位追加一条。
 * 已经是当前经手时什么都不做，重复 @ 同一个人不会在经手记录里堆重复的行。
 * handled 是读出来改完写回去，所以整段在事务里按行锁串行：不加锁的话两条并发消息会互相覆盖掉一条经手记录。
 * 新经手先拿 Bot 行的 key share 锁，再锁任务卡，和删 Bot「先删 Bot 行、再级联置空经手」同序。
 * 它已经被删就不换，原样返回任务卡；锁住了，删除等这里提交后再把经手置空。
 */
export async function setCurrentBot(db: Db | Tx, groupId: string, botId: BotId, at: Date): Promise<TopicTask | null> {
  return db.transaction(async (tx) => {
    const [alive] = await tx.select({ id: bots.id }).from(bots).where(eq(bots.id, botId)).for("key share");
    const [row] = await tx.select().from(tasks).where(eq(tasks.groupId, groupId)).limit(1).for("update");
    if (row === undefined) return null;
    if (alive === undefined || row.currentBotId === botId) return taskOut(tx, row);

    const stamp = at.toISOString();
    const handled = [...row.handled];
    // 只补最后一条还没交出去的，更早那些的 to 已经是它们各自交出去的时刻。
    for (let index = handled.length - 1; index >= 0; index -= 1) {
      const record = handled[index];
      if (record === undefined || record.to !== null) continue;
      handled[index] = { ...record, to: stamp };
      break;
    }
    handled.push({ botId, from: stamp, to: null });

    const [updated] = await tx
      .update(tasks)
      .set({ currentBotId: botId, handled })
      .where(eq(tasks.id, row.id))
      .returning();
    return taskOut(tx, updated);
  });
}

/**
 * 整份替换进来的清单，每项补上勾选时刻，在写库的那条语句里算，previous 是被替换掉的那份。
 * 按文字认旧项：同一段文字原来就勾着，沿用原来的时刻，迁移前勾的 null 也照留，重发同一份不会把它们算成刚勾的；
 * 原来没有或没勾的，现在勾上记库时钟；没勾的清成 null。
 */
export function stampedChecklist(next: readonly ChecklistItem[], previous: SQL | typeof tasks.checklist): SQL {
  return sql`coalesce((
    select jsonb_agg(
      fresh.item || jsonb_build_object('doneAt', case
        when (fresh.item ->> 'done')::boolean then coalesce(
          (select old.item -> 'doneAt' from jsonb_array_elements(${previous}) as old(item)
            where old.item ->> 'text' = fresh.item ->> 'text' and (old.item ->> 'done')::boolean limit 1),
          to_jsonb(to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
        else 'null'::jsonb end)
      order by fresh.ord)
    from jsonb_array_elements(${JSON.stringify(next)}::jsonb) with ordinality as fresh(item, ord)
  ), '[]'::jsonb)`;
}

/** 清单整份替换。同一份重发两遍结果不变。 */
export async function replaceChecklist(
  db: Db | Tx,
  groupId: string,
  checklist: readonly ChecklistItem[],
): Promise<TopicTask | null> {
  const [row] = await db
    .update(tasks)
    .set({ checklist: stampedChecklist(checklist, tasks.checklist) })
    .where(eq(tasks.groupId, groupId))
    .returning();
  return taskOut(db, row);
}

async function findTask(db: Db, ownerId: UserId, taskId: TaskId): Promise<TopicTask | null> {
  const ownedGroups = ownedLiveGroups(db, ownerId);
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), inArray(tasks.groupId, ownedGroups)))
    .limit(1);
  return taskOut(db, row);
}

export type Project = { readonly groupId: GroupId; readonly title: string; readonly cadence: string };

/** 项目就是多 Bot 群，单聊不算。派给主助理的 prompt 带这一份，set_cadence 也只认这里面的群。 */
function projectGroupsOf(db: Db | Tx, ownerId: UserId) {
  return db
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.ownerId, ownerId), isNull(groups.soloBotId)));
}

export async function listProjects(db: Db, ownerId: UserId): Promise<Project[]> {
  const rows = await db
    .select({ groupId: tasks.groupId, title: tasks.title, cadence: tasks.cadence })
    .from(tasks)
    .innerJoin(groups, eq(groups.id, tasks.groupId))
    .where(inArray(tasks.groupId, projectGroupsOf(db, ownerId)))
    .orderBy(asc(groups.createdAt), asc(groups.id));
  return rows.map((row) => ({ ...row, groupId: GroupId.parse(row.groupId) }));
}

/**
 * 主助理改项目节奏。一条 UPDATE 带齐两道条件：群是这个用户的项目群，发起的是他的主助理。
 * 任一不成立更新不到行，返回 null。
 */
export async function setProjectCadence(
  db: Db | Tx,
  ownerId: UserId,
  assistantId: BotId,
  projectGroupId: GroupId,
  cadence: string,
): Promise<TopicTask | null> {
  const isAssistant = db
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.id, assistantId), eq(bots.ownerId, ownerId), eq(bots.role, "assistant")));
  const [row] = await db
    .update(tasks)
    .set({ cadence })
    .where(
      and(eq(tasks.groupId, projectGroupId), inArray(tasks.groupId, projectGroupsOf(db, ownerId)), exists(isAssistant)),
    )
    .returning();
  return taskOut(db, row);
}
