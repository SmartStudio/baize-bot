import type { Approval, Bot, BotHue, BotId, Group, Message, UserId } from "@baize/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { approvals, bots, groupMembers, groups, tasks, userCounters } from "../db/schema.js";
import { newId } from "../ids.js";
import { pendingApprovalCounts } from "./approvals.js";
import { pendingHandoffCounts } from "./handoffs.js";
import { latestMessagePerGroup } from "./messages.js";
import { generateBotName, hueAt, taskNumber } from "../naming.js";
import { toApproval, toBot, toGroup } from "./rows.js";

export type CreateBotInput = {
  readonly name?: string | undefined;
  readonly tag?: string | undefined;
  readonly description?: string | undefined;
  readonly hue?: BotHue | undefined;
};

export type UpdateBotInput = CreateBotInput & { readonly notify?: boolean | undefined };

export type BotListEntry = {
  readonly bot: Bot;
  readonly groupId: string;
  readonly lastMessage: Message | null;
  readonly pendingApprovals: number;
  readonly pendingHandoffs: number;
};

export async function createBot(db: Db, ownerId: UserId, input: CreateBotInput): Promise<{ bot: Bot; group: Group }> {
  return db.transaction(async (tx) => {
    // 一次 UPDATE ... RETURNING 同时占住编号和色相，并发建 Bot 不会拿到同一个号。
    // 用户自己挑了色就不推进轮转，免得下一个自动分配的跳色。
    const [counter] = await tx
      .update(userCounters)
      .set({
        nextTaskNumber: sql`${userCounters.nextTaskNumber} + 1`,
        nextHueIndex: sql`${userCounters.nextHueIndex} + ${input.hue === undefined ? 1 : 0}`,
      })
      .where(eq(userCounters.userId, ownerId))
      .returning({
        nextTaskNumber: userCounters.nextTaskNumber,
        nextHueIndex: userCounters.nextHueIndex,
      });
    if (counter === undefined) throw new Error(`用户 ${ownerId} 没有发号器行`);

    const name = input.name ?? generateBotName();
    const [botRow] = await tx
      .insert(bots)
      .values({
        id: newId(),
        ownerId,
        name,
        tag: input.tag ?? "",
        description: input.description ?? "",
        hue: input.hue ?? hueAt(counter.nextHueIndex - 1),
      })
      .returning();
    if (botRow === undefined) throw new Error("建 Bot 没有返回行");

    const [groupRow] = await tx.insert(groups).values({ id: newId(), ownerId, soloBotId: botRow.id }).returning();
    if (groupRow === undefined) throw new Error("建群没有返回行");

    await tx.insert(groupMembers).values({ groupId: groupRow.id, botId: botRow.id, position: 0 });

    const [taskRow] = await tx
      .insert(tasks)
      .values({
        id: newId(),
        groupId: groupRow.id,
        number: taskNumber(counter.nextTaskNumber - 1),
        title: name,
      })
      .returning();
    if (taskRow === undefined) throw new Error("建主题任务没有返回行");

    return { bot: toBot(botRow), group: toGroup(groupRow, [botRow.id], taskRow.id) };
  });
}

export async function listBots(db: Db, ownerId: UserId): Promise<BotListEntry[]> {
  const rows = await db
    .select({ bot: bots, groupId: groups.id })
    .from(bots)
    .innerJoin(groups, eq(groups.soloBotId, bots.id))
    .where(eq(bots.ownerId, ownerId))
    .orderBy(bots.createdAt, bots.id);
  if (rows.length === 0) return [];

  const groupIds = rows.map((r) => r.groupId);
  const lastMessages = await latestMessagePerGroup(db, groupIds);
  const pending = await pendingApprovalCounts(db, groupIds);
  const handedOff = await pendingHandoffCounts(db, groupIds);
  return rows.map((row) => ({
    bot: toBot(row.bot),
    groupId: row.groupId,
    lastMessage: lastMessages.get(row.groupId) ?? null,
    pendingApprovals: pending.get(row.groupId) ?? 0,
    pendingHandoffs: handedOff.get(row.groupId) ?? 0,
  }));
}

export async function findBot(db: Db, ownerId: UserId, botId: BotId): Promise<Bot | null> {
  const [row] = await db
    .select()
    .from(bots)
    .where(and(eq(bots.id, botId), eq(bots.ownerId, ownerId)))
    .limit(1);
  return row === undefined ? null : toBot(row);
}

export async function updateBot(db: Db, ownerId: UserId, botId: BotId, input: UpdateBotInput): Promise<Bot | null> {
  const patch: Partial<typeof bots.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.tag !== undefined) patch.tag = input.tag;
  if (input.description !== undefined) patch.description = input.description;
  if (input.hue !== undefined) patch.hue = input.hue;
  if (input.notify !== undefined) patch.notify = input.notify;
  if (Object.keys(patch).length === 0) return findBot(db, ownerId, botId);

  const [row] = await db
    .update(bots)
    .set(patch)
    .where(and(eq(bots.id, botId), eq(bots.ownerId, ownerId)))
    .returning();
  return row === undefined ? null : toBot(row);
}

/** 暂停和继续只改这一列。别人的 Bot 改不到，返回 null。 */
export async function setRunState(
  db: Db,
  ownerId: UserId,
  botId: BotId,
  runState: Bot["runState"],
): Promise<Bot | null> {
  const [row] = await db
    .update(bots)
    .set({ runState })
    .where(and(eq(bots.id, botId), eq(bots.ownerId, ownerId)))
    .returning();
  return row === undefined ? null : toBot(row);
}

/**
 * 删 Bot。单 Bot 群、主题任务、消息由外键级联一起走，重复删或删别人的返回 null。
 * 它挂着的审批先在同一个事务里收成 expired 再删，回给调用方推终态：运行器删 Bot 时不再报 approval_abandoned。
 * 用 UPDATE ... WHERE status = 'pending' 而不是先查，和同时点下的批准抢行锁，谁先落谁算。
 * UPDATE 自己带归属条件，别人的 Bot 连审批行锁都不碰。
 */
export async function deleteBot(db: Db, ownerId: UserId, botId: BotId): Promise<Approval[] | null> {
  return db.transaction(async (tx) => {
    const owned = tx
      .select({ id: bots.id })
      .from(bots)
      .where(and(eq(bots.id, botId), eq(bots.ownerId, ownerId)));
    const expired = await tx
      .update(approvals)
      .set({ status: "expired" })
      .where(and(inArray(approvals.botId, owned), eq(approvals.status, "pending")))
      .returning();
    const deleted = await tx
      .delete(bots)
      .where(and(eq(bots.id, botId), eq(bots.ownerId, ownerId)))
      .returning({ id: bots.id });
    return deleted.length === 0 ? null : expired.map(toApproval);
  });
}
