import {
  RoutineId,
  UserId,
  type BotId,
  type OnFailure as OnFailureSchema,
  type Routine,
  type RoutineRunStatus as RoutineRunStatusSchema,
  type TriggerInput,
} from "@baize/shared";
import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "../db/client.js";
import { bots, routineRuns, routines, runs, type StoredTrigger } from "../db/schema.js";
import { newId } from "../ids.js";
import { toRoutine } from "./rows.js";

type OnFailure = z.infer<typeof OnFailureSchema>;
type RoutineRunStatus = z.infer<typeof RoutineRunStatusSchema>;
export type RoutineRow = typeof routines.$inferSelect;

/** 每个例行任务留的运行记录条数。规格里的「运行记录（最近 20 条）」。 */
export const MAX_ROUTINE_RUNS = 20;

/** webhook 地址里的那一段。16 字节随机数，客户端选不了，只能带着这条例行任务已有的那个来保留它。 */
export function newWebhookToken(): string {
  return randomBytes(16).toString("hex");
}

export type OwnedRoutine = { readonly row: RoutineRow; readonly ownerId: UserId };

async function selectRoutine(db: Db, where: SQL | undefined): Promise<OwnedRoutine | null> {
  const [found] = await db
    .select({ row: routines, ownerId: bots.ownerId })
    .from(routines)
    .innerJoin(bots, eq(bots.id, routines.botId))
    .where(where)
    .limit(1);
  return found === undefined ? null : { row: found.row, ownerId: UserId.parse(found.ownerId) };
}

/** 例行任务按归属人过滤。别人的在这里查不到，路由层因此返回 404 而不是 403。 */
export function findOwnedRoutine(db: Db, ownerId: UserId, routineId: RoutineId): Promise<OwnedRoutine | null> {
  return selectRoutine(db, and(eq(routines.id, routineId), eq(bots.ownerId, ownerId)));
}

/**
 * 按 webhook token 找例行任务。`POST /api/hooks/:token` 不登录，进来只有这个 token，
 * 所以这一查不带归属人：token 本身就是凭据。GIN 索引让它一次命中而不是全表扫 jsonb。
 */
export function findRoutineByWebhookToken(db: Db, token: string): Promise<OwnedRoutine | null> {
  const probe = JSON.stringify([{ kind: "webhook", token }]);
  return selectRoutine(db, sql`${routines.triggers} @> ${probe}::jsonb`);
}

export type RoutineWithOwner = { readonly routine: Routine; readonly ownerId: UserId };

/** 整条例行任务带 runs。响应和 `routine_updated` 推送都要这一份，所以归属人一并带出来。 */
export async function loadRoutine(db: Db, routineId: RoutineId): Promise<RoutineWithOwner | null> {
  const owned = await selectRoutine(db, eq(routines.id, routineId));
  if (owned === null) return null;
  const byRoutine = await listRunsByRoutine(db, [routineId]);
  return { routine: toRoutine(owned.row, byRoutine.get(routineId) ?? []), ownerId: owned.ownerId };
}

export async function listRoutines(db: Db, botId: BotId): Promise<Routine[]> {
  const rows = await db.select().from(routines).where(eq(routines.botId, botId)).orderBy(asc(routines.createdAt));
  if (rows.length === 0) return [];
  const byRoutine = await listRunsByRoutine(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toRoutine(row, byRoutine.get(row.id) ?? []));
}

type RoutineRunRow = typeof routineRuns.$inferSelect;

/** 每条例行任务最近 20 条运行记录，新的在前。插入时已经裁到 20 条，这里照 started_at 排就够。 */
async function listRunsByRoutine(db: Db, routineIds: readonly string[]): Promise<Map<string, RoutineRunRow[]>> {
  const rows = await db
    .select()
    .from(routineRuns)
    .where(inArray(routineRuns.routineId, [...routineIds]))
    .orderBy(desc(routineRuns.startedAt), desc(routineRuns.id));
  const byRoutine = new Map<string, RoutineRunRow[]>();
  for (const row of rows) {
    const bucket = byRoutine.get(row.routineId);
    if (bucket === undefined) byRoutine.set(row.routineId, [row]);
    else bucket.push(row);
  }
  return byRoutine;
}

export type RoutineInput = {
  readonly name: string;
  readonly instruction: string;
  readonly triggers: readonly TriggerInput[];
  readonly onFailure: OnFailure;
  readonly enabled: boolean;
};

export async function createRoutine(db: Db, botId: BotId, input: RoutineInput): Promise<Routine> {
  const [row] = await db
    .insert(routines)
    .values({
      id: newId(),
      botId,
      name: input.name,
      instruction: input.instruction,
      triggers: mergeTriggers([], input.triggers),
      onFailure: input.onFailure,
      enabled: input.enabled,
    })
    .returning();
  if (row === undefined) throw new Error("建例行任务没有返回行");
  return toRoutine(row, []);
}

/** `UpdateRoutineRequest` 解出来的样子：没给的字段是 undefined，不是缺席。 */
export type RoutineUpdate = { readonly [K in keyof RoutineInput]?: RoutineInput[K] | undefined };

/**
 * 给到的字段整份替换，triggers 给了就是整份替换。没给的字段一个字都不动。
 *
 * triggers 整列覆盖，而调度游标就住在这一列里，所以归并前先把这一行锁住再读一遍：
 * 拿路由层那份快照去归并的话，读到写之间调度器推过的游标会被整列写回时按旧值盖掉，同一个 cron 时刻就会派两次活。
 */
export async function updateRoutine(db: Db, routineId: RoutineId, input: RoutineUpdate): Promise<Routine | null> {
  const patch: Partial<typeof routines.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.instruction !== undefined) patch.instruction = input.instruction;
  if (input.onFailure !== undefined) patch.onFailure = input.onFailure;
  if (input.enabled !== undefined) patch.enabled = input.enabled;

  const ok = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(routines).where(eq(routines.id, routineId)).limit(1).for("update");
    if (locked === undefined) return false;
    if (input.triggers !== undefined) patch.triggers = mergeTriggers(locked.triggers, input.triggers);
    if (Object.keys(patch).length === 0) return true;
    const updated = await tx
      .update(routines)
      .set(patch)
      .where(eq(routines.id, routineId))
      .returning({ id: routines.id });
    return updated.length > 0;
  });
  if (!ok) return null;

  const loaded = await loadRoutine(db, routineId);
  return loaded?.routine ?? null;
}

export async function deleteRoutine(db: Db, routineId: RoutineId): Promise<boolean> {
  const deleted = await db.delete(routines).where(eq(routines.id, routineId)).returning({ id: routines.id });
  return deleted.length > 0;
}

/**
 * 客户端送上来的触发器变成库里的样子。
 * cron 的 `lastFiredAt` 按表达式对上就留着：改个名字重发一遍整份触发器，调度游标不该跟着归零。
 * webhook 的 token 带着这条例行任务已有的那个就保留，不带或对不上就换新，一个 token 只认领一次。
 */
function mergeTriggers(existing: readonly StoredTrigger[], inputs: readonly TriggerInput[]): StoredTrigger[] {
  const firedByExpr = new Map(
    existing.flatMap((one) => (one.kind === "cron" ? [[one.expr, one.lastFiredAt] as const] : [])),
  );
  const unclaimed = new Set(existing.flatMap((one) => (one.kind === "webhook" ? [one.token] : [])));
  return inputs.map((input) => {
    if (input.kind === "cron")
      return { kind: "cron", expr: input.expr, lastFiredAt: firedByExpr.get(input.expr) ?? null };
    if (input.token !== undefined && unclaimed.delete(input.token)) return { kind: "webhook", token: input.token };
    return { kind: "webhook", token: newWebhookToken() };
  });
}

/** 带 cron 触发器的例行任务，停用的也在里面：停用的不跑，但游标照推，重新启用时不会补跑攒下的那些时刻。 */
export async function listCronRoutines(db: Db): Promise<OwnedRoutine[]> {
  const rows = await db
    .select({ row: routines, ownerId: bots.ownerId })
    .from(routines)
    .innerJoin(bots, eq(bots.id, routines.botId))
    .where(sql`${routines.triggers} @> '[{"kind":"cron"}]'::jsonb`);
  return rows.map((found) => ({ row: found.row, ownerId: UserId.parse(found.ownerId) }));
}

/**
 * 把第 `index` 个触发器的 `lastFiredAt` 从 `from` 推到 `to`，推不动返回 false。
 *
 * 旧值写在 WHERE 里，两个进程同时扫到同一个时刻时只有一个改得动，另一个看到的已经是新值。
 * kind 和 expr 一起写进去是因为下标认的是位置不是身份：扫到这一条和推游标之间隔着一次派活，
 * 其间一个 PATCH 整份换掉 triggers，同一个下标上可能已经是另一个触发器了。
 */
export async function advanceCronTrigger(
  db: Db,
  routineId: string,
  index: number,
  trigger: { readonly expr: string; readonly lastFiredAt: string | null },
  to: Date,
): Promise<boolean> {
  const at = sql`${routines.triggers} -> ${index}::int`;
  const from = trigger.lastFiredAt;
  const claimed = await db
    .update(routines)
    .set({
      triggers: sql`jsonb_set(${routines.triggers}, ${`{${index},lastFiredAt}`}::text[], to_jsonb(${to.toISOString()}::text))`,
    })
    .where(
      and(
        eq(routines.id, routineId),
        sql`${at} ->> 'kind' = 'cron'`,
        sql`${at} ->> 'expr' = ${trigger.expr}`,
        from === null ? sql`${at} ->> 'lastFiredAt' IS NULL` : sql`${at} ->> 'lastFiredAt' = ${from}`,
      ),
    )
    .returning({ id: routines.id });
  return claimed.length > 0;
}

export type StartedRoutineRun = { readonly id: string };

/** 触发那一刻就落一条 running，随后把多出 20 条的裁掉。 */
export async function startRoutineRun(db: Db, routineId: string, startedAt: Date): Promise<StartedRoutineRun> {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(routineRuns).values({ id: newId(), routineId, startedAt }).returning({
      id: routineRuns.id,
    });
    if (row === undefined) throw new Error("建运行记录没有返回行");
    // started_at 在同一毫秒里会撞，所以再拿 id 兜一道，裁掉的和列出来时排在后面的是同一批。
    await tx.execute(sql`
      DELETE FROM ${routineRuns}
      WHERE ${routineRuns.routineId} = ${routineId}
        AND ${routineRuns.id} NOT IN (
          SELECT ${routineRuns.id} FROM ${routineRuns}
          WHERE ${routineRuns.routineId} = ${routineId}
          ORDER BY ${routineRuns.startedAt} DESC, ${routineRuns.id} DESC
          LIMIT ${MAX_ROUTINE_RUNS}
        )
    `);
    return { id: row.id };
  });
}

export type RoutineRunRef = {
  readonly routineRunId: string;
  readonly routineId: string;
  readonly onFailure: OnFailure;
};

/** 这个 run 是哪条运行记录派出去的。回 null 就是普通的一次对话，不是例行任务。 */
export async function routineRunOfRun(db: Db, runId: string): Promise<RoutineRunRef | null> {
  const [row] = await db
    .select({ routineRunId: routineRuns.id, routineId: routines.id, onFailure: routines.onFailure })
    .from(runs)
    .innerJoin(routineRuns, eq(routineRuns.id, runs.routineRunId))
    .innerJoin(routines, eq(routines.id, routineRuns.routineId))
    .where(eq(runs.id, runId))
    .limit(1);
  return row ?? null;
}

/** 收尾。只改还在 running 的那一条，重复的报文和已经停下的记录都不再动。 */
export async function settleRoutineRun(
  db: Db,
  routineRunId: string,
  status: Exclude<RoutineRunStatus, "running">,
  note: string,
): Promise<string | null> {
  const [row] = await db
    .update(routineRuns)
    .set({ status, note })
    .where(and(eq(routineRuns.id, routineRunId), eq(routineRuns.status, "running")))
    .returning({ routineId: routineRuns.routineId });
  return row?.routineId ?? null;
}

/** 只补 note，状态一个字不改。`retry_next_time` 遇到审批走这里：记一笔，活照样算在跑。 */
export async function noteRoutineRun(db: Db, routineRunId: string, note: string): Promise<string | null> {
  const [row] = await db
    .update(routineRuns)
    .set({ note })
    .where(and(eq(routineRuns.id, routineRunId), eq(routineRuns.status, "running")))
    .returning({ routineId: routineRuns.routineId });
  return row?.routineId ?? null;
}

/**
 * 活跑完了。还在 running 的记成 ok，已经停下的保持原状，两种都在 note 后面缀上这次的花费。
 * 停下等点头的那条因此长成「1 条等你点头 · ¥0.80」。
 */
export async function chargeRoutineRun(db: Db, routineRunId: string, cost: string): Promise<string | null> {
  const [row] = await db
    .update(routineRuns)
    .set({
      status: sql`CASE WHEN ${routineRuns.status} = 'running' THEN 'ok' ELSE ${routineRuns.status} END`,
      note: sql`CASE WHEN ${routineRuns.note} = '' THEN ${cost} ELSE ${routineRuns.note} || ' · ' || ${cost} END`,
    })
    .where(eq(routineRuns.id, routineRunId))
    .returning({ routineId: routineRuns.routineId });
  return row?.routineId ?? null;
}
