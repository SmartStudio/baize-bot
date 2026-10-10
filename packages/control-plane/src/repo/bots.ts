import {
  GroupId,
  type Approval,
  type Bot,
  type BotHue,
  type BotId,
  type BotProfileResponse,
  type Group,
  type Message,
  type TopicTask,
  type UserId,
} from "@baize/shared";
import { and, count, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  approvals,
  botPreferences,
  bots,
  groupMembers,
  groups,
  handoffs,
  skills,
  tasks,
  userCounters,
  users,
} from "../db/schema.js";
import { newId } from "../ids.js";
import { pendingApprovalCounts } from "./approvals.js";
import { pendingHandoffCounts } from "./handoffs.js";
import { joinGroups } from "./groups.js";
import { appendMessage, latestMessagePerGroup, type Tx } from "./messages.js";
import { transferRoutines } from "./routines.js";
import { generateBotName, hueAt, taskNumber, untakenBotName } from "../naming.js";
import { toApproval, toBot, toGroup, toTask } from "./rows.js";
import { lockOwner, lockRunsOfBot } from "./runs.js";

export type CreateBotInput = {
  readonly name?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly description?: string | undefined;
  readonly hue?: BotHue | undefined;
};

export type UpdateBotInput = CreateBotInput & { readonly notify?: boolean | undefined };

export type BotListEntry = {
  readonly bot: Bot;
  readonly groupId: GroupId;
  readonly lastMessage: Message | null;
  readonly pendingApprovals: number;
  readonly pendingHandoffs: number;
};

/** 主助理的名字和注册后它说的第一句。人设文案还没定稿，定了直接换这两个常量。 */
export const ASSISTANT_NAME = "主助理";
export const ASSISTANT_GREETING = "想让我帮你做成什么事？说一句就行";
/** 原型里主助理的头像恒为天蓝，不占色相轮转，下一个自动分配的队员不会跳色。 */
const ASSISTANT_HUE: BotHue = "sky";

type BotRow = typeof bots.$inferSelect;

/**
 * 一次 UPDATE ... RETURNING 同时占住编号和色相，并发建 Bot 不会拿到同一个号。
 * 不推进色相时返回的 nextHueIndex 不用。
 */
async function claimCounter(tx: Tx, ownerId: UserId, advanceHue: boolean) {
  const [counter] = await tx
    .update(userCounters)
    .set({
      nextTaskNumber: sql`${userCounters.nextTaskNumber} + 1`,
      nextHueIndex: sql`${userCounters.nextHueIndex} + ${advanceHue ? 1 : 0}`,
    })
    .where(eq(userCounters.userId, ownerId))
    .returning({ nextTaskNumber: userCounters.nextTaskNumber, nextHueIndex: userCounters.nextHueIndex });
  if (counter === undefined) throw new Error(`用户 ${ownerId} 没有发号器行`);
  return counter;
}

/** 给刚插进去的 Bot 建单聊群、入群、主题任务卡。 */
type SoloOpened = { readonly bot: Bot; readonly group: Group; readonly task: TopicTask };

async function openSoloGroup(tx: Tx, botRow: BotRow, nextTaskNumber: number): Promise<SoloOpened> {
  const [groupRow] = await tx
    .insert(groups)
    .values({ id: newId(), ownerId: botRow.ownerId, soloBotId: botRow.id })
    .returning();
  if (groupRow === undefined) throw new Error("建群没有返回行");

  await tx.insert(groupMembers).values({ groupId: groupRow.id, botId: botRow.id, position: 0 });

  const [taskRow] = await tx
    .insert(tasks)
    .values({ id: newId(), groupId: groupRow.id, number: taskNumber(nextTaskNumber - 1), title: botRow.name })
    .returning();
  if (taskRow === undefined) throw new Error("建主题任务没有返回行");

  return { bot: toBot(botRow), group: toGroup(groupRow, [botRow.id], taskRow.id), task: toTask(taskRow) };
}

/**
 * 先拿归属人的共享锁再建：删号正在进行就等它提交，醒来后这个人已经不在，回 null，路由层按未登录回；
 * 不等的话删号枚举 Bot 时它还不存在，建出来的 Bot 和它的 run 会留成归属人置空的孤儿。
 */
export async function createBot(
  db: Db,
  ownerId: UserId,
  input: CreateBotInput,
): Promise<{ bot: Bot; group: Group } | null> {
  return db.transaction(async (tx) => {
    await lockOwner(tx, ownerId, "shared");
    const [owner] = await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerId));
    return owner === undefined ? null : insertMemberBot(tx, ownerId, input);
  });
}

/**
 * 这个用户名下还没有 Bot 叫的名字，候选怎么排见 untakenBotName。只在拿到发号器行锁之后用：
 * 同一用户建 Bot 的事务都先抢那一行，锁到手时前一个事务已经提交，这里读得到它建的名字，并发的两次挑不到同一个。
 */
async function untakenName(tx: Tx, ownerId: UserId, base: string): Promise<string> {
  const rows = await tx.select({ name: bots.name }).from(bots).where(eq(bots.ownerId, ownerId));
  return untakenBotName(base, new Set(rows.map((row) => row.name)));
}

/**
 * 建一个队员连同它的单聊。单聊不能省：`listBots` 按单聊 join，没有单聊的 Bot 进不了 config。
 * naming 为 untaken 时名字和这个用户已有的 Bot 撞了就自动避开（见 untakenName），建出来的名字以返回的 bot 为准。
 */
export async function insertMemberBot(
  tx: Tx,
  ownerId: UserId,
  input: CreateBotInput,
  naming: "as_given" | "untaken" = "as_given",
): Promise<{ bot: Bot; group: Group }> {
  // 用户自己挑了色就不推进轮转，免得下一个自动分配的跳色。
  const counter = await claimCounter(tx, ownerId, input.hue === undefined);
  const name = input.name ?? generateBotName();
  const [botRow] = await tx
    .insert(bots)
    .values({
      id: newId(),
      ownerId,
      name: naming === "untaken" ? await untakenName(tx, ownerId, name) : name,
      tags: [...(input.tags ?? [])],
      description: input.description ?? "",
      hue: input.hue ?? hueAt(counter.nextHueIndex - 1),
    })
    .returning();
  if (botRow === undefined) throw new Error("建 Bot 没有返回行");
  return openSoloGroup(tx, botRow, counter.nextTaskNumber);
}

/**
 * 保证这个用户有主助理，这一次建出来的返回它，本来就有的返回 null。注册、登录、seed 都调。
 * 不先查：bot 行直接撞部分唯一索引 `bots_owner_id_assistant_idx`，并发的两次里输的那次没有返回行，
 * 到这里就停，不占编号、不建群、不再说第一句。
 */
export async function ensureAssistant(
  tx: Tx,
  ownerId: UserId,
): Promise<(SoloOpened & { readonly greeting: Message }) | null> {
  const [botRow] = await tx
    .insert(bots)
    .values({ id: newId(), ownerId, role: "assistant", name: ASSISTANT_NAME, hue: ASSISTANT_HUE })
    .onConflictDoNothing({ target: bots.ownerId, where: sql`${bots.role} = 'assistant'` })
    .returning();
  if (botRow === undefined) return null;

  const counter = await claimCounter(tx, ownerId, false);
  const created = await openSoloGroup(tx, botRow, counter.nextTaskNumber);
  const greeting = await appendMessage(tx, created.group.id, {
    kind: "bot",
    botId: created.bot.id,
    text: ASSISTANT_GREETING,
    streaming: false,
  });
  return { ...created, greeting };
}

/** 这个用户的主助理和它的单聊群。P1-13 之前注册、还没登录过的老用户没有，返回 null。 */
export async function findAssistant(db: Db | Tx, ownerId: UserId): Promise<{ bot: Bot; groupId: GroupId } | null> {
  const [row] = await db
    .select({ bot: bots, groupId: groups.id })
    .from(bots)
    .innerJoin(groups, eq(groups.soloBotId, bots.id))
    .where(and(eq(bots.ownerId, ownerId), eq(bots.role, "assistant")))
    .limit(1);
  return row === undefined ? null : { bot: toBot(row.bot), groupId: GroupId.parse(row.groupId) };
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
    groupId: GroupId.parse(row.groupId),
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
  if (input.tags !== undefined) patch.tags = [...input.tags];
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

export type DeleteBotResult =
  | {
      readonly kind: "deleted";
      readonly expired: Approval[];
      readonly movedRoutineIds: string[];
      /** 成员或首席因这次删除变了的项目群，调用方提交后按它推 group_updated。 */
      readonly changedGroupIds: string[];
    }
  | { readonly kind: "assistant" }
  | { readonly kind: "not_found" };

/**
 * 删 Bot。单 Bot 群、主题任务、消息由外键级联一起走，重复删或删别人的是 not_found。主助理删不掉，每个用户恰好一个。
 * 它挂着的审批先在同一个事务里收成 expired 再删，回给调用方推终态：运行器删 Bot 时不再报 approval_abandoned。
 * 它执行的例行不跟着删，转给主助理，转走的 id 回给调用方推 routine_updated。项目群里的例行照旧发进原群，主助理不在那个群就补进去。
 * 用 UPDATE ... WHERE status = 'pending' 而不是先查，和同时点下的批准抢行锁，谁先落谁算。
 * UPDATE 自己带归属和角色条件，别人的 Bot 和主助理连审批行锁都不碰。
 * 它当首席的群级联把首席置空，补进主助理的群多了一位，这两种群的号回给调用方，提交后推整份群快照。
 */
export async function deleteBot(db: Db, ownerId: UserId, botId: BotId): Promise<DeleteBotResult> {
  return db.transaction(async (tx): Promise<DeleteBotResult> => {
    const deletable = and(eq(bots.id, botId), eq(bots.ownerId, ownerId), eq(bots.role, "member"));
    const owned = tx.select({ id: bots.id }).from(bots).where(deletable);
    // 锁序和 run 名下的写一致：runs 在前，见 lockRunsOfBot。别人的 Bot 和主助理不拿锁。
    const [target] = await owned;
    if (target !== undefined) {
      await lockRunsOfBot(tx, botId);
      // 别的 Bot 确认它交出来的活，是先改交接卡、再换任务卡的经手。级联的先后由外键触发器的名字排，
      // 新建的库里是先置空经手、后删交接卡，两边各拿一半就是死锁。先把要级联删的交接卡锁上，顺序就和确认一致。
      await tx
        .select({ id: handoffs.id })
        .from(handoffs)
        .where(or(eq(handoffs.fromBotId, botId), eq(handoffs.toBotId, botId)))
        .for("update");
    }
    const assistant = target === undefined ? null : await findAssistant(tx, ownerId);
    const moved = assistant === null ? [] : await transferRoutines(tx, botId, assistant.bot.id);
    const expired = await tx
      .update(approvals)
      .set({ status: "expired" })
      .where(and(inArray(approvals.botId, owned), eq(approvals.status, "pending")))
      .returning();
    const chaired =
      target === undefined ? [] : await tx.select({ id: groups.id }).from(groups).where(eq(groups.chiefBotId, botId));
    const deleted = await tx.delete(bots).where(deletable).returning({ id: bots.id });
    if (deleted.length > 0) {
      // 删掉 Bot 行之后才碰群和成员，锁序是 Bot 行在前；被删的这位腾出的位置正好给主助理。
      const joined =
        assistant === null
          ? []
          : await joinGroups(
              tx,
              assistant.bot.id,
              moved.flatMap((one) => one.groupId ?? []),
            );
      return {
        kind: "deleted",
        expired: expired.map(toApproval),
        movedRoutineIds: moved.map((one) => one.id),
        changedGroupIds: [...new Set([...chaired.map((one) => one.id), ...joined])],
      };
    }
    // 没删到才分辨是哪一种，只为回对那句话。
    return (await findAssistant(tx, ownerId))?.bot.id === botId ? { kind: "assistant" } : { kind: "not_found" };
  });
}

/**
 * Bot 页头部「记住 N 条 · 会 N 件事 · 在 N 个项目」。项目就是它在里面的多 Bot 群，单聊不算。
 * 别人的、不存在的 Bot 回 null。三个数各查各的，互不相乘。
 */
export async function botProfile(db: Db, ownerId: UserId, botId: BotId): Promise<BotProfileResponse | null> {
  if ((await findBot(db, ownerId, botId)) === null) return null;
  const [[preferences], [taught], [projects]] = await Promise.all([
    db.select({ n: count() }).from(botPreferences).where(eq(botPreferences.botId, botId)),
    db.select({ n: count() }).from(skills).where(eq(skills.botId, botId)),
    db
      .select({ n: count() })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .where(and(eq(groupMembers.botId, botId), isNull(groups.soloBotId))),
  ]);
  return { preferences: preferences?.n ?? 0, skills: taught?.n ?? 0, projects: projects?.n ?? 0 };
}
