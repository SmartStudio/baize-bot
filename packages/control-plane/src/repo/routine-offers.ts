import {
  RoutineId,
  type Message,
  type MessageBody,
  type MessageId,
  type Routine,
  type UserId,
  type Viewer,
} from "@baize/shared";
import { TransactionRollbackError, and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bots, groupMembers, groups, messages } from "../db/schema.js";
import { newId } from "../ids.js";
import { messageVisibleTo, nextRevision, type Tx } from "./messages.js";
import { insertRoutine } from "./routines.js";
import { toMessage } from "./rows.js";
import { shareBotRunsLock } from "./runs.js";

export type RoutineOfferBody = Extract<MessageBody, { kind: "routine_offer" }>;

export type RoutineOfferMessage = {
  readonly id: MessageId;
  readonly groupId: string;
  readonly body: RoutineOfferBody;
};

/** 按归属人取那张例行确认卡。别人的、不存在的、正文不是这张卡的都是 null，路由层一律 404。 */
export async function findOwnedRoutineOffer(
  db: Db,
  ownerId: UserId,
  messageId: MessageId,
  viewer: Viewer,
): Promise<RoutineOfferMessage | null> {
  const [found] = await db
    .select({ row: messages })
    .from(messages)
    .innerJoin(groups, eq(groups.id, messages.groupId))
    .where(and(eq(messages.id, messageId), eq(groups.ownerId, ownerId), messageVisibleTo(viewer)))
    .limit(1);
  if (found === undefined || found.row.body.kind !== "routine_offer") return null;
  return { id: messageId, groupId: found.row.groupId, body: found.row.body };
}

export type DecideRoutineOfferResult =
  | { readonly kind: "ok"; readonly message: Message; readonly routine: Routine | null }
  | { readonly kind: "already_decided" }
  | { readonly kind: "executor_outside" }
  | { readonly kind: "executor_gone" }
  | { readonly kind: "table_group" };

type Failure = Exclude<DecideRoutineOfferResult["kind"], "ok">;

/**
 * 用户点了「加上」或「不要」。两边都靠带 `body->>'status' = 'offered'` 的条件 UPDATE 做幂等：
 * 并发的两次加上只有一次改得动卡，另一次一行没改到就回滚，不建例行。
 * 加上先拿执行者的共享锁，再碰卡和执行者：删执行者拿同键排他锁，两边排队，删除扫例行时看得见这条已提交的。
 */
export async function decideRoutineOffer(
  db: Db,
  ownerId: UserId,
  offer: RoutineOfferMessage,
  decision: "add" | "dismiss",
): Promise<DecideRoutineOfferResult> {
  if (decision === "dismiss") {
    const message = await settleOffer(db, offer, { ...offer.body, status: "dismissed" });
    return message === null ? { kind: "already_decided" } : { kind: "ok", message, routine: null };
  }

  const routineId = RoutineId.parse(newId());
  let failure: Failure | null = null;
  try {
    return await db.transaction(async (tx): Promise<DecideRoutineOfferResult> => {
      await shareBotRunsLock(tx, offer.body.executorBotId);
      const message = await settleOffer(tx, offer, { ...offer.body, status: "added", routineId });
      if (message === null) {
        failure = "already_decided";
        return tx.rollback();
      }
      const placement = await executorPlacement(tx, ownerId, offer.body);
      if (placement !== "ok") {
        failure = placement;
        return tx.rollback();
      }
      const { body } = offer;
      const created = await insertRoutine(tx, {
        id: routineId,
        botId: body.executorBotId,
        name: body.name,
        instruction: body.instruction,
        triggers: [{ kind: "cron", expr: body.cron, lastFiredAt: null }],
        onFailure: "stop_and_tell",
        groupId: body.groupId,
        purpose: body.purpose,
        state: "on",
        boundary: body.boundary,
        onToday: body.onToday,
      });
      if (created.kind !== "ok") {
        failure = created.kind;
        return tx.rollback();
      }
      return { kind: "ok", message, routine: created.routine };
    });
  } catch (error) {
    if (error instanceof TransactionRollbackError && failure !== null) return { kind: failure };
    throw error;
  }
}

/** 卡落下之后执行者可能被删了，也可能被移出了目标项目群；这两件都要在点加上那一刻再认一次。 */
async function executorPlacement(
  tx: Tx,
  ownerId: UserId,
  body: RoutineOfferBody,
): Promise<"ok" | "executor_gone" | "executor_outside"> {
  const [bot] = await tx
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.id, body.executorBotId), eq(bots.ownerId, ownerId)))
    .limit(1);
  if (bot === undefined) return "executor_gone";
  if (body.groupId === null) return "ok";
  const [member] = await tx
    .select({ botId: groupMembers.botId })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(
      and(
        eq(groupMembers.groupId, body.groupId),
        eq(groupMembers.botId, body.executorBotId),
        eq(groups.ownerId, ownerId),
      ),
    )
    .limit(1);
  return member === undefined ? "executor_outside" : "ok";
}

async function settleOffer(db: Db | Tx, offer: RoutineOfferMessage, body: RoutineOfferBody): Promise<Message | null> {
  const [row] = await db
    .update(messages)
    .set({ body, revision: nextRevision() })
    .where(
      and(
        eq(messages.id, offer.id),
        eq(messages.groupId, offer.groupId),
        sql`${messages.body} ->> 'status' = 'offered'`,
      ),
    )
    .returning();
  return row === undefined ? null : toMessage(row);
}

/** 首页「等你确认」里还没点的例行卡，新的在前，最多 50 张。 */
export async function listPendingRoutineOffers(
  db: Db,
  ownerId: UserId,
  viewer: Viewer,
): Promise<(typeof messages.$inferSelect)[]> {
  const rows = await db
    .select({ row: messages })
    .from(messages)
    .innerJoin(groups, eq(groups.id, messages.groupId))
    .where(
      and(
        eq(groups.ownerId, ownerId),
        messageVisibleTo(viewer),
        sql`${messages.body} ->> 'kind' = 'routine_offer'`,
        sql`${messages.body} ->> 'status' = 'offered'`,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(50);
  return rows.map(({ row }) => row);
}
