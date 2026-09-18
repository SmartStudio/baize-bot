import type { BotId, ChecklistItem, TaskId, TopicTask, UserId } from "@baize/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { groups, tasks } from "../db/schema.js";
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
};

/** 按归属人过滤。别人的任务在这里更新不到，路由层因此 404。 */
export async function updateTask(
  db: Db,
  ownerId: UserId,
  taskId: TaskId,
  input: UpdateTaskInput,
): Promise<TopicTask | null> {
  const patch: Partial<typeof tasks.$inferInsert> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.summary !== undefined) patch.summary = input.summary;
  if (input.dueAt !== undefined) patch.dueAt = input.dueAt === null ? null : new Date(input.dueAt);
  // 清单是整份替换，不是逐项合并。
  if (input.checklist !== undefined) patch.checklist = [...input.checklist];
  if (input.status !== undefined) patch.status = input.status;
  if (Object.keys(patch).length === 0) return findTask(db, ownerId, taskId);

  // drizzle 的 update 不能 join，归属只能靠这个子查询过滤。
  const ownedGroups = db.select({ id: groups.id }).from(groups).where(eq(groups.ownerId, ownerId));
  const [row] = await db
    .update(tasks)
    .set(patch)
    .where(and(eq(tasks.id, taskId), inArray(tasks.groupId, ownedGroups)))
    .returning();
  return row === undefined ? null : toTask(row);
}

/** 群和主题任务一一对应，派活拿它取当前经手和要送进 prompt 的那张卡。 */
export async function findTaskByGroup(db: Db, groupId: string): Promise<TopicTask | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.groupId, groupId)).limit(1);
  return row === undefined ? null : toTask(row);
}

/**
 * 用户 @ 谁谁就成为当前经手：上一位的 handled 记录补上 to，新一位追加一条。
 * 已经是当前经手时什么都不做，重复 @ 同一个人不会在经手记录里堆重复的行。
 * handled 是读出来改完写回去，所以整段在事务里按行锁串行：不加锁的话两条并发消息会互相覆盖掉一条经手记录。
 */
export async function setCurrentBot(db: Db, groupId: string, botId: BotId, at: Date): Promise<TopicTask | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(tasks).where(eq(tasks.groupId, groupId)).limit(1).for("update");
    if (row === undefined) return null;
    if (row.currentBotId === botId) return toTask(row);

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
    return updated === undefined ? null : toTask(updated);
  });
}

/** 清单整份替换。同一份重发两遍结果不变。 */
export async function replaceChecklist(
  db: Db,
  groupId: string,
  checklist: readonly ChecklistItem[],
): Promise<TopicTask | null> {
  const [row] = await db
    .update(tasks)
    .set({ checklist: [...checklist] })
    .where(eq(tasks.groupId, groupId))
    .returning();
  return row === undefined ? null : toTask(row);
}

async function findTask(db: Db, ownerId: UserId, taskId: TaskId): Promise<TopicTask | null> {
  const ownedGroups = db.select({ id: groups.id }).from(groups).where(eq(groups.ownerId, ownerId));
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), inArray(tasks.groupId, ownedGroups)))
    .limit(1);
  return row === undefined ? null : toTask(row);
}
