import type { BotId, GroupId, Message, MessageId, RunId } from "@baize/shared";
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { messages, runs } from "../db/schema.js";
import type { Tx } from "./messages.js";
import { toMessage } from "./rows.js";

/** 把这次 prompt 上下文里没定稿的行记到 run 上。等 confirmContext 之后它才是下一次派活接着送的名单。 */
export async function recordUnsettled(db: Db, runId: RunId, messageIds: readonly MessageId[]): Promise<void> {
  await db
    .update(runs)
    .set({ unsettledContext: [...messageIds] })
    .where(eq(runs.id, runId));
}

/** 这次 run 的 run_done 被正常收下，它那份名单生效。 */
export async function confirmContext(db: Db | Tx, runId: RunId): Promise<void> {
  await db.update(runs).set({ contextConfirmedAt: new Date() }).where(eq(runs.id, runId));
}

/**
 * 这个 Bot 在这个群最近一次确认送达的 run 记下的没定稿的行，按消息顺序。
 * 没送到、被收尾、还在跑的 run 都跳过，取再往前确认过的那一次；一次都没确认过就是空。
 */
export async function unsettledAtLastRun(db: Db, groupId: GroupId, botId: BotId): Promise<Message[]> {
  const [last] = await db
    .select({ ids: runs.unsettledContext })
    .from(runs)
    .where(and(eq(runs.groupId, groupId), eq(runs.botId, botId), isNotNull(runs.contextConfirmedAt)))
    .orderBy(desc(runs.startedAt))
    .limit(1);
  const ids = last?.ids ?? [];
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.groupId, groupId), inArray(messages.id, ids)))
    .orderBy(asc(messages.seq));
  return rows.map(toMessage);
}
