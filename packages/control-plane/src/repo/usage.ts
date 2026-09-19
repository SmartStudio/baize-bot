import { BotId, GroupId, RunId, type OvernightResponse, type UsageResponse, type UserId } from "@baize/shared";
import { and, asc, desc, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  approvals,
  bots,
  groups,
  handoffs,
  messages,
  routineRuns,
  routines,
  runs,
  tasks,
  users,
} from "../db/schema.js";

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
      title: (run.isRoutine
        ? routineName === null
          ? "例行任务"
          : `例行 · ${routineName}`
        : trigger?.kind === "user"
          ? [...trigger.text].slice(0, 40).join("")
          : (taskTitle ?? "主题任务")
      ).slice(0, 80),
      startedAt: run.startedAt.toISOString(),
      endedAt: run.endedAt?.toISOString() ?? null,
      steps: run.steps,
      amount: Number(run.amount),
    })),
  };
}

export async function getOvernight(db: Db, ownerId: UserId, now = new Date()): Promise<OvernightResponse> {
  const [user] = await db.select({ since: users.lastSeenAt }).from(users).where(eq(users.id, ownerId));
  const since = user?.since ?? null;
  if (since === null || now.getTime() - since.getTime() < 30 * 60_000) {
    return { since: since?.toISOString() ?? null, items: [] };
  }

  const botId = sql<string>`${messages.body} ->> 'botId'`;
  const text = sql<string>`${messages.body} ->> 'text'`;
  const latest = db
    .selectDistinctOn([bots.id], {
      botId: bots.id,
      groupId: messages.groupId,
      text: text.as("message_text"),
      at: messages.createdAt,
    })
    .from(messages)
    .innerJoin(groups, eq(groups.id, messages.groupId))
    .innerJoin(bots, and(eq(bots.id, botId), eq(bots.ownerId, ownerId)))
    .where(
      and(
        eq(groups.ownerId, ownerId),
        gt(messages.createdAt, since),
        sql`${messages.body} ->> 'kind' = 'bot'`,
        sql`${messages.body} ->> 'streaming' = 'false'`,
        sql`btrim(${text}) <> ''`,
      ),
    )
    .orderBy(bots.id, desc(messages.createdAt), desc(messages.seq))
    .as("latest_bot_message");
  const rows = await db.select().from(latest).orderBy(desc(latest.at), desc(latest.botId)).limit(10);
  if (rows.length === 0) return { since: since.toISOString(), items: [] };

  const ids = rows.map((row) => row.botId);
  const [pendingApprovals, pendingHandoffs, openRuns] = await Promise.all([
    db
      .select({ botId: approvals.botId, groupId: approvals.groupId })
      .from(approvals)
      .where(and(inArray(approvals.botId, ids), eq(approvals.status, "pending"))),
    db
      .select({ botId: handoffs.fromBotId, groupId: handoffs.groupId })
      .from(handoffs)
      .where(and(inArray(handoffs.fromBotId, ids), eq(handoffs.status, "pending"))),
    db
      .select({ botId: runs.botId })
      .from(runs)
      .where(and(inArray(runs.botId, ids), eq(runs.ownerId, ownerId), isNull(runs.endedAt))),
  ]);
  const waiting = new Set([...pendingApprovals, ...pendingHandoffs].map((row) => `${row.botId}:${row.groupId}`));
  const working = new Set(openRuns.map((row) => row.botId));
  return {
    since: since.toISOString(),
    items: rows.map((row) => ({
      botId: BotId.parse(row.botId),
      groupId: GroupId.parse(row.groupId),
      text: [...row.text].slice(0, 200).join(""),
      status: waiting.has(`${row.botId}:${row.groupId}`) ? "waiting" : working.has(row.botId) ? "working" : "done",
      at: row.at.toISOString(),
    })),
  };
}
