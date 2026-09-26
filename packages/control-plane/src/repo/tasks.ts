import { GroupId, type BotId, type ChecklistItem, type TaskId, type TopicTask, type UserId } from "@baize/shared";
import { and, asc, eq, exists, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bots, groups, tasks } from "../db/schema.js";
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
  if (input.cadence !== undefined) patch.cadence = input.cadence;
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

export type Project = { readonly groupId: GroupId; readonly title: string; readonly cadence: string };

/** 项目就是多 Bot 群，单聊不算。派给主助理的 prompt 带这一份，set_cadence 也只认这里面的群。 */
function projectGroupsOf(db: Db, ownerId: UserId) {
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
  db: Db,
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
  return row === undefined ? null : toTask(row);
}
