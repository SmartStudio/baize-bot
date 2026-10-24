import { GroupId, HandoffId, UserId, type BotId, type Handoff, type Message } from "@baize/shared";
import { and, asc, count, eq, inArray, isNull, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bots, groups, handoffs, messages } from "../db/schema.js";
import { newId } from "../ids.js";
import { appendMessage, messageVisibleTo, type Tx } from "./messages.js";
import { appendReminders } from "./reminders.js";
import { toHandoff, toMessage } from "./rows.js";
import type { PushHub } from "../ws/hub.js";

/** 过了这么久还没人确认就提醒一次。和审批同一个口径。 */
export const STALE_HANDOFF_MS = 24 * 60 * 60 * 1000;

export type CreateHandoffInput = {
  readonly groupId: string;
  readonly fromBotId: BotId;
  readonly toBotId: BotId;
  readonly done: string;
  readonly notDone: string;
  readonly next: string;
  readonly checklistIndex: number | null;
};

export type CreatedHandoff = { readonly handoff: Handoff; readonly message: Message };

/** 建一份待确认的交接报文和群里那张卡。两者在一个事务里生，所以群里不会出现没有报文的孤儿卡。 */
export async function createHandoff(db: Db | Tx, input: CreateHandoffInput): Promise<CreatedHandoff> {
  const handoffId = HandoffId.parse(newId());
  return db.transaction(async (tx) => {
    // 卡先落地，handoffs.message_id 是非空外键。
    const message = await appendMessage(tx, input.groupId, { kind: "handoff", handoffId });
    const [row] = await tx
      .insert(handoffs)
      .values({ id: handoffId, ...input, messageId: message.id, queued: true })
      .returning();
    if (row === undefined) throw new Error("写交接报文没有返回行");
    return { handoff: toHandoff(row), message };
  });
}

/**
 * 只认这个群里、交给这个 Bot 的、还没确认的那一行。
 * 不是它的交接、对不上群的 handoffId、重复的确认，在这里全是 null：
 * 归属校验和幂等都靠这条 UPDATE 的 WHERE 本身，不靠先查后写。
 */
export async function acceptHandoff(
  db: Db | Tx,
  input: {
    readonly handoffId: HandoffId;
    readonly groupId: string;
    readonly toBotId: BotId;
    readonly at: Date;
  },
): Promise<Handoff | null> {
  const [row] = await db
    .update(handoffs)
    .set({ status: "accepted", acceptedAt: input.at })
    .where(
      and(
        eq(handoffs.id, input.handoffId),
        eq(handoffs.groupId, input.groupId),
        eq(handoffs.toBotId, input.toBotId),
        eq(handoffs.status, "pending"),
      ),
    )
    .returning();
  return row === undefined ? null : toHandoff(row);
}

export async function claimQueuedHandoff(tx: Tx, handoffId: HandoffId): Promise<boolean> {
  const [row] = await tx
    .update(handoffs)
    .set({ queued: false })
    .where(and(eq(handoffs.id, handoffId), eq(handoffs.queued, true), eq(handoffs.status, "pending")))
    .returning({ id: handoffs.id });
  return row !== undefined;
}

export async function dropQueuedHandoffs(db: Db, groupId: GroupId): Promise<void> {
  await db
    .update(handoffs)
    .set({ queued: false })
    .where(and(eq(handoffs.groupId, groupId), eq(handoffs.queued, true)));
}

export type QueuedHandoff = { readonly handoff: Handoff; readonly fromName: string; readonly message: Message };

export async function listQueuedHandoffs(db: Db, groupId: GroupId): Promise<QueuedHandoff[]> {
  const rows = await db
    .select({ handoff: handoffs, message: messages, fromName: bots.name })
    .from(handoffs)
    .innerJoin(messages, eq(messages.id, handoffs.messageId))
    .innerJoin(bots, eq(bots.id, handoffs.fromBotId))
    .where(
      and(
        eq(handoffs.groupId, groupId),
        eq(handoffs.queued, true),
        eq(handoffs.status, "pending"),
        messageVisibleTo({ kind: "user" }),
      ),
    )
    .orderBy(asc(messages.seq));
  return rows.map((row) => ({
    handoff: toHandoff(row.handoff),
    fromName: row.fromName,
    message: toMessage(row.message),
  }));
}

export async function groupsWithQueuedHandoffs(
  db: Db,
  scope: { readonly ownerId?: UserId; readonly groupId?: GroupId },
): Promise<{ readonly groupId: GroupId; readonly ownerId: UserId }[]> {
  const rows = await db
    .selectDistinct({ groupId: handoffs.groupId, ownerId: groups.ownerId })
    .from(handoffs)
    .innerJoin(groups, eq(groups.id, handoffs.groupId))
    .where(
      and(
        eq(handoffs.queued, true),
        eq(handoffs.status, "pending"),
        isNull(groups.archivedAt),
        scope.ownerId === undefined ? undefined : eq(groups.ownerId, scope.ownerId),
        scope.groupId === undefined ? undefined : eq(handoffs.groupId, scope.groupId),
      ),
    );
  return rows.map((row) => ({ groupId: GroupId.parse(row.groupId), ownerId: UserId.parse(row.ownerId) }));
}

/** 一页消息引用到的交接报文。客户端画卡要的状态跟着这一页一起回，不用再发一次请求。 */
export async function listHandoffs(db: Db, handoffIds: readonly HandoffId[]): Promise<Handoff[]> {
  if (handoffIds.length === 0) return [];
  const rows = await db
    .select()
    .from(handoffs)
    .where(inArray(handoffs.id, [...handoffIds]));
  return rows.map(toHandoff);
}

/** 每个群还有几份等 Bot 确认。侧栏角标用，一次查询查完所有群。 */
export async function pendingHandoffCounts(db: Db, groupIds: readonly string[]): Promise<Map<string, number>> {
  if (groupIds.length === 0) return new Map();
  const rows = await db
    .select({ groupId: handoffs.groupId, pending: count() })
    .from(handoffs)
    .where(and(inArray(handoffs.groupId, [...groupIds]), eq(handoffs.status, "pending")))
    .groupBy(handoffs.groupId);
  return new Map(rows.map((row) => [row.groupId, row.pending]));
}

/**
 * 放了一天还没人确认的交接各补一条提醒。不退回给上一位，也不升级，活还挂在交出去的那个身上。
 * 提醒只发一次，靠的是先占住 reminded_at，和审批共用 appendReminders。
 */
export async function remindStaleHandoffs(db: Db, push: PushHub, now: Date): Promise<number> {
  return appendReminders(db, push, async (tx) => {
    const stale = await tx
      .update(handoffs)
      .set({ remindedAt: now })
      .where(
        and(
          eq(handoffs.status, "pending"),
          isNull(handoffs.remindedAt),
          lte(handoffs.createdAt, new Date(now.getTime() - STALE_HANDOFF_MS)),
        ),
      )
      .returning();
    if (stale.length === 0) return [];

    const names = await namesOf(
      tx,
      stale.map((row) => row.toBotId),
    );
    return stale.map((row) => ({
      groupId: row.groupId,
      text: `交给${names.get(row.toBotId) ?? "它"}的这件事等了一天还没接手，下一步是「${row.next}」。`,
    }));
  });
}

async function namesOf(db: Tx, botIds: readonly string[]): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: bots.id, name: bots.name })
    .from(bots)
    .where(inArray(bots.id, [...botIds]));
  return new Map(rows.map((row) => [row.id, row.name]));
}
