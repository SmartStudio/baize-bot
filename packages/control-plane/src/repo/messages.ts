import {
  BotId,
  type BotRole,
  type GroupId,
  type Message,
  type MessageBody,
  type MessageId,
  type RunId,
  type UserId,
} from "@baize/shared";
import { and, asc, desc, eq, inArray, isNull, lt, max, ne, notExists, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bots, groupMembers, groups, messages, runs } from "../db/schema.js";
import { newId } from "../ids.js";
import { groupHasMembers } from "./live-groups.js";
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

/** 按归属人取一条消息，可见范围和按群 id 访问的接口一致：别人的群、空群里的都查不到。 */
export async function findOwnedMessage(db: Db, ownerId: UserId, messageId: MessageId): Promise<Message | null> {
  const [found] = await db
    .select({ row: messages })
    .from(messages)
    .innerJoin(groups, eq(groups.id, messages.groupId))
    .where(and(eq(messages.id, messageId), eq(groups.ownerId, ownerId), groupHasMembers(db)))
    .limit(1);
  return found === undefined ? null : toMessage(found.row);
}

export async function appendMessage(db: Db | Tx, groupId: string, body: MessageBody): Promise<Message> {
  const [row] = await db.insert(messages).values({ id: newId(), groupId, body, createdAt: new Date() }).returning();
  if (row === undefined) throw new Error("写消息没有返回行");
  return toMessage(row);
}

/**
 * 派活失败时往群里留提示用。群可能刚随 Bot 或账号级联删掉，先查后写在两个事务里拦不住中间的删除，
 * 所以在同一个事务里先对群行拿 KEY SHARE：删除等这条写完，或者先提交、这里查不到行就回 null，一个字都不写。
 */
export async function appendMessageIfGroupAlive(db: Db, groupId: string, body: MessageBody): Promise<Message | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId)).for("key share");
    return row === undefined ? null : appendMessage(tx, groupId, body);
  });
}

/** 改消息的每条 UPDATE 都把它放进 set：在同一句里加一，并发的两次改写拿到的号不会相同。 */
export const nextRevision = () => sql<number>`${messages.revision} + 1`;

/** 消息已经不在（随群级联删掉）回 null。 */
export async function messageSeq(db: Db, messageId: MessageId): Promise<number | null> {
  const [row] = await db.select({ seq: messages.seq }).from(messages).where(eq(messages.id, messageId)).limit(1);
  return row?.seq ?? null;
}

/** 正文里那支 `skill_offer`。落卡和点存两处都只认这一支，别的 kind 编译期就进不来。 */
export type SkillOfferBody = Extract<MessageBody, { kind: "skill_offer" }>;

type SkillSource = NonNullable<(typeof messages.$inferSelect)["skillOfferSource"]>;

/**
 * 落一条 skill_offer 卡。来源不走正文走单独一列，所以这一条不能借 `appendMessage`：
 * 那个函数只收 `MessageBody`，多一个恒为 undefined 的参数会让别的十几个调用点一起背上这个字段。
 */
export async function appendSkillOffer(
  db: Db | Tx,
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

export type BotText = { readonly messageId: MessageId; readonly groupId: string; readonly botId: BotId };

export type BotTextResult =
  | { readonly kind: "appended"; readonly created: Message | null; readonly message: Message }
  | { readonly kind: "taken" };

/**
 * 一段 bot_text 落库。第一段先用报文给的编号建一条空壳，created 就是它，调用方先推它，客户端才有一条可以往上追加的消息。
 * 同一个编号重复到达时靠主键冲突不再插入；编号由电脑那头给，撞上的可能是别的群里那条，接正文那条 UPDATE 按群过滤，对不上回 taken。
 * 累加在一条 UPDATE 里做完，不用在内存里攒正文，进程重启也不会把已落库的正文冲掉。
 * 限定 kind = 'bot'：正文没有 text 的（比如 tool_call）做 jsonb_set 会写出 NULL 正文，整行就废了。
 */
export async function appendBotText(db: Db | Tx, text: BotText, delta: string, done: boolean): Promise<BotTextResult> {
  const shell: MessageBody = { kind: "bot", botId: text.botId, text: "", streaming: true };
  const [inserted] = await db
    .insert(messages)
    .values({ id: text.messageId, groupId: text.groupId, body: shell, createdAt: new Date() })
    .onConflictDoNothing({ target: messages.id })
    .returning();
  const [row] = await db
    .update(messages)
    .set({
      body: sql`jsonb_set(
        jsonb_set(${messages.body}, '{text}', to_jsonb((${messages.body} ->> 'text') || ${delta}::text)),
        '{streaming}',
        ${done ? sql`'false'::jsonb` : sql`'true'::jsonb`}
      )`,
      revision: nextRevision(),
    })
    .where(
      and(
        eq(messages.id, text.messageId),
        eq(messages.groupId, text.groupId),
        sql`${messages.body} ->> 'kind' = 'bot'`,
      ),
    )
    .returning();
  if (row === undefined) return { kind: "taken" };
  return { kind: "appended", created: inserted === undefined ? null : toMessage(inserted), message: toMessage(row) };
}

/**
 * run 收尾时把这个 Bot 在这个群里还在流的文字收成定稿。文字行上没有 runId，只能按 Bot 和群找。
 * 同一个 Bot 在同一个群里可能还有别的 run 开着：本机掉线后派到远程电脑的，或另一台控制面上的。
 * 那时按 Bot 找会把它还在长的文字一起收掉，所以只要还有别的 run 开着就整条跳过，留给最后一条结束的 run 收。
 * 那条 run 收尾时按 Bot 找，会把这里留下的一并收掉。重复收尾不会再次命中。
 * 调用方的事务先拿 (群, Bot) 的收尾锁（lockSettlement），同 Bot 同群的另一条收尾和新 run 都排在它后面，
 * 这里的「没有别的 open run」在提交前不会被推翻。
 * 「收它没错」依赖一条文字只属于一个 run：正常运行器每个文字块生成新的 messageId，成立；
 * 控制面不校验 messageId 是否被另一条 run 复用过，复用时那条文字可能被提前收掉。
 */
export async function settleStreamingText(
  db: Db | Tx,
  groupId: GroupId,
  botId: BotId,
  runId: RunId,
): Promise<Message[]> {
  const otherOpenRun = db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.botId, botId), eq(runs.groupId, groupId), ne(runs.id, runId), isNull(runs.endedAt)));
  const rows = await db
    .update(messages)
    .set({ body: sql`jsonb_set(${messages.body}, '{streaming}', 'false'::jsonb)`, revision: nextRevision() })
    .where(
      and(
        eq(messages.groupId, groupId),
        sql`${messages.body} ->> 'kind' = 'bot'`,
        sql`${messages.body} ->> 'botId' = ${botId}`,
        sql`${messages.body} ->> 'streaming' = 'true'`,
        notExists(otherOpenRun),
      ),
    )
    .returning();
  return rows.map(toMessage);
}

export async function replaceMessageBody(
  db: Db | Tx,
  messageId: MessageId,
  groupId: string,
  body: MessageBody,
): Promise<Message | null> {
  const [row] = await db
    .update(messages)
    .set({ body, revision: nextRevision() })
    .where(and(eq(messages.id, messageId), eq(messages.groupId, groupId)))
    .returning();
  return row === undefined ? null : toMessage(row);
}

/** run 收尾后不再可能有工具结果，只改仍在 running 的工具行，重复收尾不会再次命中。 */
export async function failRunningToolCalls(db: Db | Tx, groupId: GroupId, runId: RunId): Promise<Message[]> {
  const rows = await db
    .update(messages)
    .set({ body: sql`jsonb_set(${messages.body}, '{status}', '"failed"'::jsonb)`, revision: nextRevision() })
    .where(
      and(
        eq(messages.groupId, groupId),
        sql`${messages.body} ->> 'kind' = 'tool_call'`,
        sql`${messages.body} ->> 'runId' = ${runId}`,
        sql`${messages.body} ->> 'status' = 'running'`,
      ),
    )
    .returning();
  return rows.map(toMessage);
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
  readonly role: BotRole;
  readonly name: string;
  readonly tags: string[];
  readonly description: string;
};

/** 群成员按展示顺序。派活、路由、上下文署名都用这一份。 */
export async function listGroupBots(db: Db, groupId: string): Promise<GroupBot[]> {
  const rows = await db
    .select({ id: bots.id, role: bots.role, name: bots.name, tags: bots.tags, description: bots.description })
    .from(groupMembers)
    .innerJoin(bots, eq(bots.id, groupMembers.botId))
    .where(eq(groupMembers.groupId, groupId))
    .orderBy(asc(groupMembers.position));
  return rows.map((row) => ({ ...row, id: BotId.parse(row.id) }));
}
