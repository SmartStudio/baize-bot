import {
  BotId,
  GroupId,
  type Bot,
  type ChecklistItem,
  type Group,
  type Message,
  type TopicTask,
  type UserId,
} from "@baize/shared";
import { and, asc, count, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bots, groupMembers, groups, tasks, userCounters } from "../db/schema.js";
import { newId } from "../ids.js";
import { taskNumber } from "../naming.js";
import { pendingApprovalCounts } from "./approvals.js";
import { pendingHandoffCounts } from "./handoffs.js";
import { latestMessagePerGroup, type Tx } from "./messages.js";
import { toBot, toGroup, toTask } from "./rows.js";

export type CreateGroupInput = {
  readonly title: string;
  readonly botIds: readonly BotId[];
  readonly summary?: string | undefined;
  readonly dueAt?: string | null | undefined;
};

export type CreateGroupResult =
  | { readonly kind: "ok"; readonly group: Group; readonly task: TopicTask }
  | { readonly kind: "unknown_bot" }
  | { readonly kind: "duplicate_bot" };

/** Bot 的单 Bot 群。例行任务的一次运行等同于归属人在这个群里发了一条消息。 */
/** 群的首席，没设或群不存在都是 null。派活按它算 prompt 里的成员角色。 */
export async function findChiefBotId(db: Db, groupId: GroupId): Promise<BotId | null> {
  const [row] = await db.select({ chiefBotId: groups.chiefBotId }).from(groups).where(eq(groups.id, groupId)).limit(1);
  return row?.chiefBotId === undefined || row.chiefBotId === null ? null : BotId.parse(row.chiefBotId);
}

export async function setChiefBotId(db: Db, groupId: GroupId, targetBotId: BotId | null): Promise<boolean> {
  const [changed] = await db
    .update(groups)
    .set({ chiefBotId: targetBotId })
    .where(and(eq(groups.id, groupId), sql`${groups.chiefBotId} is distinct from ${targetBotId}`))
    .returning({ id: groups.id });
  return changed !== undefined;
}

/** 单聊群里的那个 Bot；多 Bot 群是 null。群是不是单聊只看这一列，不看此刻剩几个成员。 */
export async function findSoloBotId(db: Db, groupId: GroupId): Promise<BotId | null> {
  const [row] = await db.select({ soloBotId: groups.soloBotId }).from(groups).where(eq(groups.id, groupId)).limit(1);
  return row?.soloBotId === undefined || row.soloBotId === null ? null : BotId.parse(row.soloBotId);
}

export async function findSoloGroup(db: Db, botId: BotId): Promise<GroupId | null> {
  const [row] = await db.select({ id: groups.id }).from(groups).where(eq(groups.soloBotId, botId)).limit(1);
  return row === undefined ? null : GroupId.parse(row.id);
}

/** 建多 Bot 群，同时建它的主题任务。单 Bot 群不走这里，建 Bot 时自动建。 */
export async function createGroup(db: Db, ownerId: UserId, input: CreateGroupInput): Promise<CreateGroupResult> {
  if (new Set(input.botIds).size !== input.botIds.length) return { kind: "duplicate_bot" };

  // 别人的 Bot 和不存在的 Bot 在这里是同一种结果，路由层因此都回 404，不泄露有没有这个 Bot。
  const owned = await db
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.ownerId, ownerId), inArray(bots.id, [...input.botIds])));
  if (owned.length !== input.botIds.length) return { kind: "unknown_bot" };

  return db.transaction(async (tx) => ({
    kind: "ok" as const,
    ...(await openGroup(tx, ownerId, {
      id: GroupId.parse(newId()),
      title: input.title,
      botIds: input.botIds,
      summary: input.summary ?? "",
      dueAt: input.dueAt ?? null,
      chiefBotId: null,
      cadence: "",
      checklist: [],
    })),
  }));
}

export type OpenGroupSpec = {
  /** 调用方先定好群号：建项目时方案卡要在建群之前就写上它，抢卡那条 UPDATE 才能一次写完。 */
  readonly id: GroupId;
  readonly title: string;
  readonly botIds: readonly BotId[];
  readonly summary: string;
  readonly dueAt: string | null;
  readonly chiefBotId: BotId | null;
  readonly cadence: string;
  readonly checklist: readonly ChecklistItem[];
};

/** 在调用方的事务里建多 Bot 群和它的主题任务。成员归属由调用方保证。 */
export async function openGroup(
  tx: Tx,
  ownerId: UserId,
  spec: OpenGroupSpec,
): Promise<{ readonly group: Group; readonly task: TopicTask }> {
  // 一次 UPDATE ... RETURNING 占住编号，并发建群不会拿到同一个号。
  // 不推进 nextHueIndex：建群不分配色相，推进了下一个自动分配的 Bot 会跳色。
  const [counter] = await tx
    .update(userCounters)
    .set({ nextTaskNumber: sql`${userCounters.nextTaskNumber} + 1` })
    .where(eq(userCounters.userId, ownerId))
    .returning({ nextTaskNumber: userCounters.nextTaskNumber });
  if (counter === undefined) throw new Error(`用户 ${ownerId} 没有发号器行`);

  const [groupRow] = await tx.insert(groups).values({ id: spec.id, ownerId, chiefBotId: spec.chiefBotId }).returning();
  if (groupRow === undefined) throw new Error("建群没有返回行");

  await tx
    .insert(groupMembers)
    .values(spec.botIds.map((botId, position) => ({ groupId: groupRow.id, botId, position })));

  const [taskRow] = await tx
    .insert(tasks)
    .values({
      id: newId(),
      groupId: groupRow.id,
      number: taskNumber(counter.nextTaskNumber - 1),
      title: spec.title,
      summary: spec.summary,
      dueAt: spec.dueAt === null ? null : new Date(spec.dueAt),
      cadence: spec.cadence,
      checklist: [...spec.checklist],
    })
    .returning();
  if (taskRow === undefined) throw new Error("建主题任务没有返回行");

  return { group: toGroup(groupRow, [...spec.botIds], taskRow.id), task: toTask(taskRow) };
}

export type GroupListEntry = {
  readonly group: Group;
  readonly task: TopicTask;
  readonly lastMessage: Message | null;
  readonly pendingApprovals: number;
  readonly pendingHandoffs: number;
};

export async function listGroups(db: Db, ownerId: UserId): Promise<GroupListEntry[]> {
  // 「多 Bot 群」就是成员数大于一，所以按成员数筛。用 solo_bot_id IS NULL 代替是靠不变量绕过规则本身。
  const multiBot = db
    .select({ groupId: groupMembers.groupId })
    .from(groupMembers)
    .groupBy(groupMembers.groupId)
    .having(gt(count(), 1))
    .as("multi_bot");

  const rows = await db
    .select({ group: groups, task: tasks })
    .from(groups)
    .innerJoin(multiBot, eq(multiBot.groupId, groups.id))
    .innerJoin(tasks, eq(tasks.groupId, groups.id))
    .where(eq(groups.ownerId, ownerId))
    .orderBy(groups.createdAt, groups.id);
  if (rows.length === 0) return [];

  const groupIds = rows.map((row) => row.group.id);
  const memberRows = await db
    .select({ groupId: groupMembers.groupId, botId: groupMembers.botId })
    .from(groupMembers)
    .where(inArray(groupMembers.groupId, groupIds))
    .orderBy(groupMembers.groupId, groupMembers.position);
  const membersOf = new Map<string, string[]>();
  for (const row of memberRows) {
    const existing = membersOf.get(row.groupId);
    if (existing === undefined) membersOf.set(row.groupId, [row.botId]);
    else existing.push(row.botId);
  }

  const lastMessages = await latestMessagePerGroup(db, groupIds);
  const pending = await pendingApprovalCounts(db, groupIds);
  const handedOff = await pendingHandoffCounts(db, groupIds);
  return rows.map((row) => ({
    group: toGroup(row.group, membersOf.get(row.group.id) ?? [], row.task.id),
    task: toTask(row.task),
    lastMessage: lastMessages.get(row.group.id) ?? null,
    pendingApprovals: pending.get(row.group.id) ?? 0,
    pendingHandoffs: handedOff.get(row.group.id) ?? 0,
  }));
}

export type GroupDetail = { readonly group: Group; readonly task: TopicTask; readonly bots: Bot[] };

/** 群按归属人过滤。别人的群在这里查不到，路由层因此返回 404 而不是 403。单 Bot 群也照常返回，成员删光的团队群当作不存在。 */
export async function findGroup(db: Db, ownerId: UserId, groupId: GroupId): Promise<GroupDetail | null> {
  const [row] = await db
    .select({ group: groups, task: tasks })
    .from(groups)
    .innerJoin(tasks, eq(tasks.groupId, groups.id))
    .where(and(eq(groups.id, groupId), eq(groups.ownerId, ownerId)))
    .limit(1);
  if (row === undefined) return null;

  const memberRows = await db
    .select({ bot: bots })
    .from(groupMembers)
    .innerJoin(bots, eq(bots.id, groupMembers.botId))
    .where(eq(groupMembers.groupId, row.group.id))
    .orderBy(asc(groupMembers.position));
  const members = memberRows.map((member) => toBot(member.bot));
  if (members.length === 0) return null;

  return {
    group: toGroup(
      row.group,
      members.map((bot) => bot.id),
      row.task.id,
    ),
    task: toTask(row.task),
    bots: members,
  };
}
