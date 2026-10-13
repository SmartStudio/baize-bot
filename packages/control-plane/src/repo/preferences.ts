import {
  BotId,
  Preference,
  PreferenceId,
  type GroupId,
  type Message,
  type MessageBody,
  type MessageId,
  type UserId,
  type Viewer,
} from "@baize/shared";
import { TransactionRollbackError, and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { botPreferences, bots, groups, messages } from "../db/schema.js";
import { newId } from "../ids.js";
import { messageVisibleTo, nextRevision, type Tx } from "./messages.js";
import { toMessage } from "./rows.js";

function toPreference(row: typeof botPreferences.$inferSelect): Preference {
  return Preference.parse({
    id: row.id,
    botId: row.botId,
    text: row.text,
    sourceMessageId: row.sourceMessageId,
    private: row.private,
    createdAt: row.createdAt.toISOString(),
  });
}

/** 按 id 改、删都套这层：别人的 Bot 不在子查询里，碰不到别人的行，路由层回 404。 */
function ownedPreference(db: Db, ownerId: UserId, preferenceId: PreferenceId) {
  const owned = db.select({ id: bots.id }).from(bots).where(eq(bots.ownerId, ownerId));
  return and(eq(botPreferences.id, preferenceId), inArray(botPreferences.botId, owned));
}

/** created_at 在同一事务里会撞，再拿 id 兜一道，顺序稳定可断言。 */
export async function listPreferences(db: Db, botId: BotId): Promise<Preference[]> {
  const rows = await db
    .select()
    .from(botPreferences)
    .where(eq(botPreferences.botId, botId))
    .orderBy(asc(botPreferences.createdAt), asc(botPreferences.id));
  return rows.map(toPreference);
}

/**
 * 随 config 下发的偏好：该用户全部 Bot 的，私人的也在里面。私人只管分享时默认不勾，Bot 写作时照样要套用。
 * 数组恒带，运行器靠整份对账。
 */
export async function listPreferencesForConfig(db: Db, ownerId: UserId): Promise<Preference[]> {
  const rows = await db
    .select({ row: botPreferences })
    .from(botPreferences)
    .innerJoin(bots, eq(bots.id, botPreferences.botId))
    .where(eq(bots.ownerId, ownerId))
    .orderBy(asc(botPreferences.botId), asc(botPreferences.createdAt), asc(botPreferences.id));
  return rows.map((found) => toPreference(found.row));
}

export type PreferenceInput = {
  readonly botId: BotId;
  readonly groupId: GroupId;
  readonly text: string;
  readonly private: boolean;
  readonly sourceMessageId: MessageId | null;
};

/** 来源消息是电脑报上来的外部输入，外键只保证它存在，不在这个群里的记成 null。 */
export async function addPreference(tx: Tx, input: PreferenceInput): Promise<Preference> {
  const [source] =
    input.sourceMessageId === null
      ? []
      : await tx
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.id, input.sourceMessageId), eq(messages.groupId, input.groupId)))
          .limit(1);
  const [row] = await tx
    .insert(botPreferences)
    .values({
      id: PreferenceId.parse(newId()),
      botId: input.botId,
      text: input.text,
      private: input.private,
      sourceMessageId: source?.id ?? null,
    })
    .returning();
  if (row === undefined) throw new Error("记偏好没有返回行");
  return toPreference(row);
}

export async function setPreferencePrivate(
  db: Db,
  ownerId: UserId,
  preferenceId: PreferenceId,
  value: boolean,
): Promise<Preference | null> {
  const [row] = await db
    .update(botPreferences)
    .set({ private: value })
    .where(ownedPreference(db, ownerId, preferenceId))
    .returning();
  return row === undefined ? null : toPreference(row);
}

/** 删到了回它属于哪个 Bot，推 preference_deleted 要带；别人的、已删的回 null。 */
export async function deletePreference(db: Db, ownerId: UserId, preferenceId: PreferenceId): Promise<BotId | null> {
  const [row] = await db
    .delete(botPreferences)
    .where(ownedPreference(db, ownerId, preferenceId))
    .returning({ botId: botPreferences.botId });
  return row === undefined ? null : BotId.parse(row.botId);
}

export type PreferenceOfferBody = Extract<MessageBody, { kind: "preference_offer" }>;

export type PreferenceOfferMessage = {
  readonly id: MessageId;
  readonly groupId: GroupId;
  readonly body: PreferenceOfferBody;
};

/**
 * 单聊里那张 preference_offer 卡，按归属人过滤。别人的、不存在的、正文不是这张卡的、所在群已不是卡上那个 Bot 的单聊，
 * 都返回 null，路由层一律 404。点卡时 run 多半早结束了，所以归属在这里重新认，不靠上行那一刻的校验。
 */
export async function findOwnedPreferenceOffer(
  db: Db,
  ownerId: UserId,
  messageId: MessageId,
  viewer: Viewer,
): Promise<PreferenceOfferMessage | null> {
  const [found] = await db
    .select({ row: messages, soloBotId: groups.soloBotId })
    .from(messages)
    .innerJoin(groups, eq(groups.id, messages.groupId))
    .where(and(eq(messages.id, messageId), eq(groups.ownerId, ownerId), messageVisibleTo(viewer)))
    .limit(1);
  if (found === undefined || found.row.body.kind !== "preference_offer") return null;
  if (found.soloBotId !== found.row.body.botId) return null;
  return { id: messageId, groupId: found.row.groupId as GroupId, body: found.row.body };
}

export type DecidePreferenceOfferResult =
  | { readonly kind: "ok"; readonly message: Message; readonly preference: Preference | null }
  | { readonly kind: "already_decided" }
  | { readonly kind: "bot_gone" };

/**
 * 用户在单聊里点了「记住」或「不用」。两边都靠带 `body->>'status' = 'offered'` 的条件 UPDATE 做幂等，不先查后写：
 * 并发的两次点只有一个改得动那条消息。记住时写偏好和改卡在同一个事务里，抢输的一边整条回滚，不会留下孤儿偏好。
 */
export async function decidePreferenceOffer(
  db: Db,
  ownerId: UserId,
  offer: PreferenceOfferMessage,
  decision: "save" | "dismiss",
): Promise<DecidePreferenceOfferResult> {
  if (decision === "dismiss") {
    const message = await settlePreferenceOffer(db, offer, { ...offer.body, status: "dismissed" });
    return message === null ? { kind: "already_decided" } : { kind: "ok", message, preference: null };
  }

  let failure: "already_decided" | "bot_gone" | null = null;
  try {
    return await db.transaction(async (tx): Promise<DecidePreferenceOfferResult> => {
      const [bot] = await tx
        .select({ id: bots.id })
        .from(bots)
        .where(and(eq(bots.id, offer.body.botId), eq(bots.ownerId, ownerId)))
        .for("key share");
      if (bot === undefined) {
        failure = "bot_gone";
        return tx.rollback();
      }
      const preference = await addPreference(tx, {
        botId: offer.body.botId,
        groupId: offer.groupId,
        text: offer.body.text,
        private: offer.body.private,
        sourceMessageId: offer.body.sourceMessageId,
      });
      const message = await settlePreferenceOffer(tx, offer, {
        ...offer.body,
        status: "saved",
        preferenceId: preference.id,
      });
      if (message === null) {
        failure = "already_decided";
        return tx.rollback();
      }
      return { kind: "ok", message, preference };
    });
  } catch (error) {
    if (error instanceof TransactionRollbackError && failure !== null) return { kind: failure };
    throw error;
  }
}

async function settlePreferenceOffer(
  db: Db | Tx,
  offer: PreferenceOfferMessage,
  body: PreferenceOfferBody,
): Promise<Message | null> {
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
