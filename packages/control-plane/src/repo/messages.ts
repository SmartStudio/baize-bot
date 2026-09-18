import type { GroupId, Message, MessageId, UserId } from "@baize/shared";
import { and, desc, eq, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { groups, messages } from "../db/schema.js";
import { newId } from "../ids.js";
import { toMessage } from "./rows.js";

export const DEFAULT_MESSAGE_LIMIT = 50;
export const MAX_MESSAGE_LIMIT = 200;

export type MessagePage = { readonly messages: Message[]; readonly hasMore: boolean };

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
  | { readonly kind: "ok"; readonly page: MessagePage }
  | { readonly kind: "unknown_cursor" };

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
  const page = rows.slice(0, limit).reverse().map(toMessage);
  return { kind: "ok", page: { messages: page, hasMore } };
}

export async function appendUserMessage(db: Db, groupId: string, text: string): Promise<Message> {
  const [row] = await db
    .insert(messages)
    .values({
      id: newId(),
      groupId,
      body: { kind: "user", text },
      createdAt: new Date(),
    })
    .returning();
  if (row === undefined) throw new Error("写消息没有返回行");
  return toMessage(row);
}
