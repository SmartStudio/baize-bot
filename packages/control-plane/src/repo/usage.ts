import { BotId, GroupId, RunId, type MessageBody, type UsageResponse, type UserId } from "@baize/shared";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bots, messages, routineRuns, routines, runs, tasks } from "../db/schema.js";
import { clip } from "./today.js";

const shanghai = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function weekStart(now: Date): Date {
  const parts = shanghai.formatToParts(now);
  const part = (name: string) => Number(parts.find((item) => item.type === name)?.value);
  const localDay = Date.UTC(part("year"), part("month") - 1, part("day"));
  const daysSinceMonday = (new Date(localDay).getUTCDay() + 6) % 7;
  return new Date(localDay - daysSinceMonday * 86_400_000 - 8 * 3_600_000);
}

/** 用户派的活取那句话的前 40 字，例行任务派的取「例行 · 名字」，其余取群的主题任务标题。用量页和项目页共用。 */
export function runTitle(input: {
  readonly isRoutine: boolean;
  readonly routineName: string | null;
  readonly trigger: MessageBody | null;
  readonly taskTitle: string | null;
}): string {
  const { isRoutine, routineName, trigger, taskTitle } = input;
  return clip(
    isRoutine
      ? routineName === null
        ? "例行任务"
        : `例行 · ${routineName}`
      : trigger?.kind === "user"
        ? [...trigger.text].slice(0, 40).join("")
        : (taskTitle ?? "主题任务"),
    80,
  );
}

export async function getUsage(db: Db, ownerId: UserId, now = new Date()): Promise<UsageResponse> {
  const start = weekStart(now);
  const [sumRow] = await db
    .select({ amount: sql<string>`coalesce(sum(${runs.amount}), 0)` })
    .from(runs)
    .where(and(eq(runs.ownerId, ownerId), gte(runs.startedAt, start)));

  const botRows = await db
    .select({
      botId: bots.id,
      amount: sql<string>`coalesce(sum(${runs.amount}), 0)`,
      count: sql<number>`count(${runs.id})`.mapWith(Number),
    })
    .from(bots)
    .leftJoin(runs, and(eq(runs.botId, bots.id), eq(runs.ownerId, ownerId), gte(runs.startedAt, start)))
    .where(eq(bots.ownerId, ownerId))
    .groupBy(bots.id)
    .orderBy(desc(sql`coalesce(sum(${runs.amount}), 0)`), asc(bots.id));

  const recentRows = await db
    .select({ run: runs, trigger: messages.body, routineName: routines.name, taskTitle: tasks.title })
    .from(runs)
    .leftJoin(messages, eq(messages.id, runs.triggerMessageId))
    .leftJoin(routineRuns, eq(routineRuns.id, runs.routineRunId))
    .leftJoin(routines, eq(routines.id, routineRuns.routineId))
    .leftJoin(tasks, eq(tasks.groupId, runs.groupId))
    .where(eq(runs.ownerId, ownerId))
    .orderBy(desc(runs.startedAt), desc(runs.id))
    .limit(20);

  return {
    weekStartsAt: start.toISOString(),
    total: Number(sumRow?.amount ?? 0),
    bots: botRows.map((row) => ({ botId: BotId.parse(row.botId), amount: Number(row.amount), runs: row.count })),
    recent: recentRows.map(({ run, trigger, routineName, taskTitle }) => ({
      runId: RunId.parse(run.id),
      botId: run.botId === null ? null : BotId.parse(run.botId),
      groupId: run.groupId === null ? null : GroupId.parse(run.groupId),
      title: runTitle({ isRoutine: run.isRoutine, routineName, trigger, taskTitle }),
      startedAt: run.startedAt.toISOString(),
      endedAt: run.endedAt?.toISOString() ?? null,
      steps: run.steps,
      amount: Number(run.amount),
    })),
  };
}
