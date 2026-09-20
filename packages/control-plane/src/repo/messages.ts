import { BotId, type GroupId, type Message, type MessageBody, type MessageId, type UserId } from "@baize/shared";
import { and, asc, desc, eq, inArray, lt, max, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bots, groupMembers, groups, messages } from "../db/schema.js";
import { newId } from "../ids.js";
import { toMessage } from "./rows.js";

export const DEFAULT_MESSAGE_LIMIT = 50;
export const MAX_MESSAGE_LIMIT = 200;

export type MessagePage = { readonly messages: Message[]; readonly hasMore: boolean };

/** `db.transaction` 回调里那个句柄。写一条消息在事务内外是同一件事，收哪个由调用方定。 */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** 群按归属人过滤。别人的群在这里查不到，路由层因此返回 404 而不是 403。 */
export async function findGroupId(db: Db, ownerId: UserId, groupId: GroupId): Promise<string | null> {
  const [row] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.id, groupId), eq(groups.ownerId, ownerId)))
    .limit(1);
  return row?.id ?? null;
}

export type ListMessagesResult =
  { readonly kind: "ok"; readonly page: MessagePage } | { readonly kind: "unknown_cursor" };

export async function listMessages(
  db: Db,
  groupId: string,
  options: { readonly before?: MessageId | undefined; readonly limit?: number | undefined },
): Promise<ListMessagesResult> {
  const limit = Math.min(options.limit ?? DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT);

  let beforeSeq: number | null = null;
  if (options.before !== undefined) {
    const [cursor] = await db
      .select({ seq: messages.seq })
      .from(messages)
      .where(and(eq(messages.id, options.before), eq(messages.groupId, groupId)))
      .limit(1);
    if (cursor === undefined) return { kind: "unknown_cursor" };
    beforeSeq = cursor.seq;
  }

  const where =
    beforeSeq === null
      ? eq(messages.groupId, groupId)
      : and(eq(messages.groupId, groupId), lt(messages.seq, beforeSeq));
  // 多取一条判断还有没有更早的，然后倒回时间正序。
  const rows = await db
    .select()
    .from(messages)
    .where(where)
    .orderBy(desc(messages.seq))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).toReversed().map(toMessage);
  return { kind: "ok", page: { messages: page, hasMore } };
}

export async function appendMessage(db: Db | Tx, groupId: string, body: MessageBody): Promise<Message> {
  const [row] = await db.insert(messages).values({ id: newId(), groupId, body, createdAt: new Date() }).returning();
  if (row === undefined) throw new Error("写消息没有返回行");
  return toMessage(row);
}

/** 正文里那支 `skill_offer`。落卡和点存两处都只认这一支，别的 kind 编译期就进不来。 */
export type SkillOfferBody = Extract<MessageBody, { kind: "skill_offer" }>;

type SkillSource = NonNullable<(typeof messages.$inferSelect)["skillOfferSource"]>;

/**
 * 落一条 skill_offer 卡。来源不走正文走单独一列，所以这一条不能借 `appendMessage`：
 * 那个函数只收 `MessageBody`，多一个恒为 undefined 的参数会让别的十几个调用点一起背上这个字段。
 */
export async function appendSkillOffer(
  db: Db,
  groupId: string,
  body: SkillOfferBody,
  source: SkillSource,
): Promise<Message> {
  const [row] = await db
    .insert(messages)
    .values({ id: newId(), groupId, body, skillOfferSource: source, createdAt: new Date() })
    .returning();
  if (row === undefined) throw new Error("写 skill_offer 卡没有返回行");
  return toMessage(row);
}

export type AppendResult =
  | { readonly kind: "created"; readonly message: Message }
  | { readonly kind: "existing"; readonly message: Message }
  | { readonly kind: "taken" };

/**
 * 用报文里给的编号写一条。同一个编号重复到达时不再插入，回库里已有的那条。
 * bot_text 的第一条 delta 和它的重发走的就是这里，靠主键冲突做幂等。
 * 编号由电脑那头给，撞上的可能是别的群里那条，所以回查按群过滤，不是这个群的回 taken。
 */
export async function appendMessageWithId(
  db: Db,
  messageId: MessageId,
  groupId: string,
  body: MessageBody,
): Promise<AppendResult> {
  const [inserted] = await db
    .insert(messages)
    .values({ id: messageId, groupId, body, createdAt: new Date() })
    .onConflictDoNothing({ target: messages.id })
    .returning();
  if (inserted !== undefined) return { kind: "created", message: toMessage(inserted) };

  const [existing] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.groupId, groupId)))
    .limit(1);
  if (existing === undefined) return { kind: "taken" };
  return { kind: "existing", message: toMessage(existing) };
}

/**
 * 把一段 delta 接到 Bot 消息正文后面。累加在一条 UPDATE 里做完，
 * 所以不用在内存里攒正文，进程重启也不会把已落库的正文冲掉。
 * 限定 kind = 'bot'：正文没有 text 的（比如 tool_call）做 jsonb_set 会写出 NULL 正文，整行就废了。
 */
export async function appendBotDelta(
  db: Db,
  messageId: MessageId,
  groupId: string,
  delta: string,
  done: boolean,
): Promise<Message | null> {
  const [row] = await db
    .update(messages)
    .set({
      body: sql`jsonb_set(
        jsonb_set(${messages.body}, '{text}', to_jsonb((${messages.body} ->> 'text') || ${delta}::text)),
        '{streaming}',
        ${done ? sql`'false'::jsonb` : sql`'true'::jsonb`}
      )`,
    })
    .where(and(eq(messages.id, messageId), eq(messages.groupId, groupId), sql`${messages.body} ->> 'kind' = 'bot'`))
    .returning();
  return row === undefined ? null : toMessage(row);
}

export async function replaceMessageBody(
  db: Db,
  messageId: MessageId,
  groupId: string,
  body: MessageBody,
): Promise<Message | null> {
  const [row] = await db
    .update(messages)
    .set({ body })
    .where(and(eq(messages.id, messageId), eq(messages.groupId, groupId)))
    .returning();
  return row === undefined ? null : toMessage(row);
}

/** 每个群的最近一条消息。侧栏和群列表都要它，一次查询查完所有群。 */
export async function latestMessagePerGroup(db: Db, groupIds: readonly string[]): Promise<Map<string, Message>> {
  const latest = db
    .select({ groupId: messages.groupId, maxSeq: max(messages.seq).as("max_seq") })
    .from(messages)
    .where(inArray(messages.groupId, [...groupIds]))
    .groupBy(messages.groupId)
    .as("latest");
  const rows = await db
    .select({ message: messages })
    .from(messages)
    .innerJoin(latest, and(eq(messages.groupId, latest.groupId), eq(messages.seq, latest.maxSeq)));
  return new Map(rows.map((r) => [r.message.groupId, toMessage(r.message)]));
}

export type GroupBot = {
  readonly id: BotId;
  readonly name: string;
  readonly tag: string;
  readonly description: string;
};

/** 群成员按展示顺序。派活、路由、上下文署名都用这一份。 */
export async function listGroupBots(db: Db, groupId: string): Promise<GroupBot[]> {
  const rows = await db
    .select({ id: bots.id, name: bots.name, tag: bots.tag, description: bots.description })
    .from(groupMembers)
    .innerJoin(bots, eq(bots.id, groupMembers.botId))
    .where(eq(groupMembers.groupId, groupId))
    .orderBy(asc(groupMembers.position));
  return rows.map((row) => ({ id: BotId.parse(row.id), name: row.name, tag: row.tag, description: row.description }));
}
