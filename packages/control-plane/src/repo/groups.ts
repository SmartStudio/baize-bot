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
import { and, asc, count, eq, gt, inArray, isNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bots, groupMembers, groups, tasks, userCounters } from "../db/schema.js";
import { newId } from "../ids.js";
import { taskNumber } from "../naming.js";
import { pendingApprovalCounts } from "./approvals.js";
import { pendingHandoffCounts } from "./handoffs.js";
import { latestMessagePerGroup, type Tx } from "./messages.js";
import { metricsOf, withMetric } from "./metrics.js";
import { toBot, toGroup, toTask } from "./rows.js";
import { lockOwner } from "./runs.js";
import { stampedChecklist } from "./tasks.js";

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

export async function setChiefBotId(db: Db | Tx, groupId: GroupId, targetBotId: BotId | null): Promise<boolean> {
  const [changed] = await db
    .update(groups)
    .set({ chiefBotId: targetBotId })
    .where(and(eq(groups.id, groupId), sql`${groups.chiefBotId} is distinct from ${targetBotId}`))
    .returning({ id: groups.id });
  return changed !== undefined;
}

/** 群这一行还在不在。单聊随 Bot 级联删掉，成员全没的多 Bot 群这行还在，两者对外都不可见，能不能往里写消息却不一样。 */
export async function groupExists(db: Db, groupId: GroupId): Promise<boolean> {
  const [row] = await db.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId)).limit(1);
  return row !== undefined;
}

/** 单聊群里的那个 Bot；多 Bot 群是 null。群是不是单聊只看这一列，不看此刻剩几个成员。 */
export async function findSoloBotId(db: Db, groupId: GroupId): Promise<BotId | null> {
  const [row] = await db.select({ soloBotId: groups.soloBotId }).from(groups).where(eq(groups.id, groupId)).limit(1);
  return row?.soloBotId === undefined || row.soloBotId === null ? null : BotId.parse(row.soloBotId);
}

/** 建多 Bot 群，同时建它的主题任务。单 Bot 群不走这里，建 Bot 时自动建。 */
export async function createGroup(db: Db, ownerId: UserId, input: CreateGroupInput): Promise<CreateGroupResult> {
  if (new Set(input.botIds).size !== input.botIds.length) return { kind: "duplicate_bot" };

  return db.transaction(async (tx): Promise<CreateGroupResult> => {
    // 先过归属人的共享锁：删号先删 users 行再级联到 Bot 行和发号器，这里先锁 Bot 行再占发号器，和它反序；
    // 有这把锁，删号要么等建群提交再把新群级联掉，要么先提交、下面查不到 Bot 就回 404。
    await lockOwner(tx, ownerId, "shared");
    // 别人的 Bot 和不存在的 Bot 在这里是同一种结果，路由层因此都回 404，不泄露有没有这个 Bot。
    // 查归属在事务里并锁住这几行：同时删其中一位时，删除等建群提交，或者先提交、这里就查不到它，不会插成员时撞外键。
    const owned = await tx
      .select({ id: bots.id })
      .from(bots)
      .where(and(eq(bots.ownerId, ownerId), inArray(bots.id, [...input.botIds])))
      .for("key share");
    if (owned.length !== input.botIds.length) return { kind: "unknown_bot" };
    return {
      kind: "ok",
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
    };
  });
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
      checklist: stampedChecklist(spec.checklist, sql`'[]'::jsonb`),
    })
    .returning();
  if (taskRow === undefined) throw new Error("建主题任务没有返回行");

  return { group: toGroup(groupRow, [...spec.botIds], taskRow.id), task: toTask(taskRow) };
}

/** 一个群最多几个 Bot，和建群请求的上限一致。 */
export const GROUP_BOT_LIMIT = 6;

/** 项目群就是这个用户还有成员、没解散的多 Bot 群，单聊不算。别人的、不存在的、成员删光的、解散的都是 null，和 findGroup 一个口径。 */
export async function findProjectGroupId(db: Db | Tx, ownerId: UserId, groupId: GroupId): Promise<GroupId | null> {
  const [row] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.id, groupId), eq(groups.ownerId, ownerId), isNull(groups.soloBotId), hasMembers(groups.id)))
    .limit(1);
  return row === undefined ? null : GroupId.parse(row.id);
}

/** 群还有成员、也没解散。成员删光的和解散的多 Bot 群行都还留着，对外却当作不存在：findProjectGroupId 和首页待办一个口径。 */
export function hasMembers(groupId: SQL | AnyColumn): SQL {
  return sql`exists (select 1 from ${groupMembers} join ${groups} as live on live.id = ${groupMembers.groupId}
    where ${groupMembers.groupId} = ${groupId} and live.archived_at is null)`;
}

/**
 * 锁住项目群那一行再读成员，往群里加人的事务都先抢这把锁，并发的两次加人各自数到的人数不会都是旧的。
 * 不是这个用户的项目群、或者成员删空了，都回 null：删空的群 findGroup 也当它不存在。nextPosition 是下一个人该排的位置。
 */
export async function lockProjectMembers(
  tx: Tx,
  ownerId: UserId,
  groupId: GroupId,
): Promise<{ readonly botIds: readonly BotId[]; readonly nextPosition: number } | null> {
  const [locked] = await tx
    .select({ id: groups.id })
    .from(groups)
    .where(
      and(eq(groups.id, groupId), eq(groups.ownerId, ownerId), isNull(groups.soloBotId), isNull(groups.archivedAt)),
    )
    .for("update");
  if (locked === undefined) return null;
  const rows = await tx
    .select({ botId: groupMembers.botId, position: groupMembers.position })
    .from(groupMembers)
    .where(eq(groupMembers.groupId, groupId))
    .orderBy(asc(groupMembers.position));
  if (rows.length === 0) return null;
  return {
    botIds: rows.map((row) => BotId.parse(row.botId)),
    nextPosition: rows.reduce((max, row) => Math.max(max, row.position + 1), 0),
  };
}

/** 接在群尾加人。调用方先 lockProjectMembers，保证这些 Bot 是自己的、还不在群里、加完不过上限。 */
export async function appendGroupMembers(
  tx: Tx,
  groupId: GroupId,
  botIds: readonly BotId[],
  nextPosition: number,
): Promise<void> {
  if (botIds.length === 0) return;
  await tx
    .insert(groupMembers)
    .values(botIds.map((botId, offset) => ({ groupId, botId, position: nextPosition + offset })));
}

/**
 * 把 Bot 补进这几个多 Bot 群，已在群里的不动，排在现有成员后面。单聊不补。回真的多了一位的群号。
 * 按群号升序插，主键冲突即已在，所以同一个群给几次都只多一位。
 */
export async function joinGroups(tx: Tx, botId: BotId, groupIds: readonly string[]): Promise<string[]> {
  const targets = [...new Set(groupIds)].toSorted();
  if (targets.length === 0) return [];
  const joined = await tx.execute(sql`
    INSERT INTO ${groupMembers} (group_id, bot_id, position)
    SELECT ${groups.id}, ${botId},
      (SELECT coalesce(max(m.position) + 1, 0) FROM ${groupMembers} AS m WHERE m.group_id = ${groups.id})
    FROM ${groups}
    WHERE ${inArray(groups.id, targets)} AND ${groups.soloBotId} IS NULL
    ORDER BY ${groups.id}
    ON CONFLICT DO NOTHING
    RETURNING group_id
  `);
  return [...joined].map((row) => String(row.group_id));
}

/** 同一个位置上换人：旧成员那行改成新成员，position 不动。旧成员不在群里回 false，新成员已在群里会撞主键。 */
export async function swapGroupMember(tx: Tx, groupId: GroupId, fromBotId: BotId, toBotId: BotId): Promise<boolean> {
  const swapped = await tx
    .update(groupMembers)
    // 选的电脑跟着 (Bot, 群) 走，换上来的 Bot 不继承前一个的。
    .set({ botId: toBotId, computerKind: null })
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.botId, fromBotId)))
    .returning({ botId: groupMembers.botId });
  return swapped.length > 0;
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
    .where(and(eq(groups.ownerId, ownerId), isNull(groups.archivedAt)))
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

  const lastMessages = await latestMessagePerGroup(db, groupIds, { kind: "user" });
  const pending = await pendingApprovalCounts(db, groupIds);
  const handedOff = await pendingHandoffCounts(db, groupIds);
  const metrics = await metricsOf(db, groupIds, new Date());
  return rows.map((row) => ({
    group: toGroup(row.group, membersOf.get(row.group.id) ?? [], row.task.id),
    task: { ...toTask(row.task), metric: metrics.get(row.group.id) ?? null },
    lastMessage: lastMessages.get(row.group.id) ?? null,
    pendingApprovals: pending.get(row.group.id) ?? 0,
    pendingHandoffs: handedOff.get(row.group.id) ?? 0,
  }));
}

export type GroupDetail = { readonly group: Group; readonly task: TopicTask; readonly bots: Bot[] };

/** 群按归属人过滤。别人的群在这里查不到，路由层因此返回 404 而不是 403。单 Bot 群也照常返回，成员删光的和解散的团队群当作不存在。 */
export async function findGroup(db: Db | Tx, ownerId: UserId, groupId: GroupId): Promise<GroupDetail | null> {
  const [row] = await db
    .select({ group: groups, task: tasks })
    .from(groups)
    .innerJoin(tasks, eq(tasks.groupId, groups.id))
    .where(and(eq(groups.id, groupId), eq(groups.ownerId, ownerId), isNull(groups.archivedAt)))
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
    task: await withMetric(db, toTask(row.task)),
    bots: members,
  };
}
