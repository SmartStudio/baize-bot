import { BotId, GroupId, RunId, type MessageId, type UsageRecord, type UserId } from "@baize/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bots, runs } from "../db/schema.js";
import { newId } from "../ids.js";
import { toUsageRecord } from "./rows.js";

export type StartRunInput = {
  readonly botId: BotId;
  readonly groupId: GroupId;
  readonly triggerMessageId: MessageId;
};

export async function startRun(db: Db, input: StartRunInput): Promise<RunId> {
  const [row] = await db
    .insert(runs)
    .values({
      id: newId(),
      botId: input.botId,
      groupId: input.groupId,
      triggerMessageId: input.triggerMessageId,
      startedAt: new Date(),
    })
    .returning({ id: runs.id });
  if (row === undefined) throw new Error("建 run 没有返回行");
  return RunId.parse(row.id);
}

export type RunTotals = {
  readonly steps: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly amount: number;
};

/**
 * 只结束还没结束的那一行。重复的 run_done、不认识的 runId、以及对不上群的 runId 都返回 null，
 * 幂等靠这条 UPDATE 的 WHERE 本身，不靠先查后写。
 */
export async function finishRun(
  db: Db,
  runId: RunId,
  groupId: GroupId,
  totals: RunTotals,
): Promise<UsageRecord | null> {
  const [row] = await db
    .update(runs)
    .set({
      endedAt: new Date(),
      steps: totals.steps,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      amount: totals.amount.toFixed(6),
    })
    .where(and(eq(runs.id, runId), eq(runs.groupId, groupId), isNull(runs.endedAt)))
    .returning();
  return row === undefined ? null : toUsageRecord(row);
}

/** 这个 run 确实是这个 Bot 在这个群里的活。上行报文的 runId 是外部输入，外键管不了它指到哪个群。 */
export async function runBelongsTo(db: Db, runId: RunId, botId: BotId, groupId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.botId, botId), eq(runs.groupId, groupId)))
    .limit(1);
  return row !== undefined;
}

export type OpenRun = { readonly runId: RunId; readonly groupId: GroupId; readonly botId: BotId };

/** 该用户最近一条还没结束的 run。agent_error 报文里没有群号，只能落到它上面。 */
export async function latestOpenRun(db: Db, ownerId: UserId): Promise<OpenRun | null> {
  const [row] = await db
    .select({ runId: runs.id, groupId: runs.groupId, botId: runs.botId })
    .from(runs)
    .innerJoin(bots, eq(bots.id, runs.botId))
    .where(and(eq(bots.ownerId, ownerId), isNull(runs.endedAt)))
    .orderBy(desc(runs.startedAt))
    .limit(1);
  if (row === undefined) return null;
  return {
    runId: RunId.parse(row.runId),
    groupId: GroupId.parse(row.groupId),
    botId: BotId.parse(row.botId),
  };
}
