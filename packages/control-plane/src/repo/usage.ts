import { BotId, GroupId, RunId, type MessageBody, type UsageResponse, type UserId, type Viewer } from "@baize/shared";
import { and, asc, desc, eq, gte, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bots, groups, messages, routineRuns, routines, runs, settings, tasks } from "../db/schema.js";
import { messageVisibleTo } from "./messages.js";
import { clip } from "./today.js";

const shanghai = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

function shanghaiDate(now: Date): { readonly year: number; readonly month: number; readonly day: number } {
  const parts = shanghai.formatToParts(now);
  const part = (name: string) => Number(parts.find((item) => item.type === name)?.value);
  return { year: part("year"), month: part("month"), day: part("day") };
}

export function weekStart(now: Date): Date {
  const { year, month, day } = shanghaiDate(now);
  const localDay = Date.UTC(year, month - 1, day);
  const daysSinceMonday = (new Date(localDay).getUTCDay() + 6) % 7;
  return new Date(localDay - daysSinceMonday * 86_400_000 - SHANGHAI_OFFSET_MS);
}

/** 上海时区当月 1 号 00:00。 */
export function monthStart(now: Date): Date {
  const { year, month } = shanghaiDate(now);
  return new Date(Date.UTC(year, month - 1, 1) - SHANGHAI_OFFSET_MS);
}

/** 上海时区的月份，形如 2026-10。 */
export function monthKey(now: Date): string {
  const { year, month } = shanghaiDate(now);
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** 本月花费。预算判定、80% 提醒和用量页的 total 是同一个数。 */
export async function monthTotal(db: Db, ownerId: UserId, now: Date): Promise<number> {
  const [row] = await db
    .select({ amount: sql<string>`coalesce(sum(${runs.amount}), 0)` })
    .from(runs)
    .where(and(eq(runs.ownerId, ownerId), gte(runs.startedAt, monthStart(now))));
  return Number(row?.amount ?? 0);
}

/** 本月花费到了预算。没设预算的从不算超。 */
export async function isOverBudget(db: Db, ownerId: UserId, now: Date): Promise<boolean> {
  const [row] = await db.select({ budget: settings.budget }).from(settings).where(eq(settings.userId, ownerId));
  const budget = row?.budget ?? null;
  return budget !== null && (await monthTotal(db, ownerId, now)) >= budget;
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

export async function getUsage(db: Db, ownerId: UserId, viewer: Viewer, now = new Date()): Promise<UsageResponse> {
  const start = monthStart(now);
  const inMonth = and(eq(runs.ownerId, ownerId), gte(runs.startedAt, start));
  const amount = sql<string>`coalesce(sum(${runs.amount}), 0)`;
  const [settingsRow] = await db.select({ budget: settings.budget }).from(settings).where(eq(settings.userId, ownerId));

  const botRows = await db
    .select({ botId: bots.id, amount, count: sql<number>`count(${runs.id})`.mapWith(Number) })
    .from(bots)
    .leftJoin(runs, and(eq(runs.botId, bots.id), inMonth))
    .where(eq(bots.ownerId, ownerId))
    .groupBy(bots.id)
    .orderBy(desc(amount), asc(bots.id));

  const projectRows = await db
    .select({ groupId: groups.id, amount, count: sql<number>`count(${runs.id})`.mapWith(Number) })
    .from(runs)
    .innerJoin(groups, and(eq(groups.id, runs.groupId), isNull(groups.soloBotId)))
    .where(inMonth)
    .groupBy(groups.id)
    .orderBy(desc(amount), asc(groups.id));

  const recentRows = await db
    .select({ run: runs, trigger: messages.body, routineName: routines.name, taskTitle: tasks.title })
    .from(runs)
    .leftJoin(messages, and(eq(messages.id, runs.triggerMessageId), messageVisibleTo(viewer)))
    .leftJoin(routineRuns, eq(routineRuns.id, runs.routineRunId))
    .leftJoin(routines, eq(routines.id, routineRuns.routineId))
    .leftJoin(tasks, eq(tasks.groupId, runs.groupId))
    .where(inMonth)
    .orderBy(desc(runs.startedAt), desc(runs.id))
    .limit(20);

  return {
    monthStartsAt: start.toISOString(),
    total: await monthTotal(db, ownerId, now),
    budget: settingsRow?.budget ?? null,
    bots: botRows.map((row) => ({ botId: BotId.parse(row.botId), amount: Number(row.amount), runs: row.count })),
    projects: projectRows.map((row) => ({
      groupId: GroupId.parse(row.groupId),
      amount: Number(row.amount),
      runs: row.count,
    })),
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
