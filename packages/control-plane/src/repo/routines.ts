import {
  BotId,
  GroupId,
  RoutineId,
  UserId,
  type OnFailure as OnFailureSchema,
  type ModelPurpose,
  type Routine,
  type RoutineBoundary,
  type RoutineRunStatus as RoutineRunStatusSchema,
  type RoutineState,
  type TriggerInput,
} from "@baize/shared";
import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, ne, notInArray, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "../db/client.js";
import type { Tx } from "./messages.js";
import {
  bots,
  groupMembers,
  groups,
  pokerTables,
  routineRuns,
  routines,
  runs,
  type StoredTrigger,
} from "../db/schema.js";
import { newId } from "../ids.js";
import { toRoutine } from "./rows.js";
import { exclusiveBotRunsLock, shareBotRunsLock } from "./runs.js";
import type { PushHub } from "../ws/hub.js";

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

async function selectRoutine(db: Db | Tx, where: SQL | undefined): Promise<OwnedRoutine | null> {
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

/**
 * 每次状态或 note 变了就把整条例行任务推一遍，客户端整条替换。没改动（null）就不推。
 * 运行记录变了就可能刚好凑满三次没人看，自己停下的那一下和这次收尾合成一次推送。
 */
export async function pushRoutineUpdated(
  deps: { readonly db: Db; readonly push: PushHub },
  routineId: string | null,
): Promise<void> {
  if (routineId === null) return;
  await autoPauseIfUnseen(deps.db, routineId);
  const loaded = await loadRoutine(deps.db, RoutineId.parse(routineId));
  if (loaded === null) return;
  deps.push.push(loaded.ownerId, { type: "routine_updated", routine: loaded.routine });
}

export async function listRoutines(db: Db, botId: BotId): Promise<Routine[]> {
  return withRuns(
    db,
    await db.select().from(routines).where(eq(routines.botId, botId)).orderBy(asc(routines.createdAt)),
  );
}

/** 这个人全部 Bot 的例行任务，按建的先后排。 */
export async function listOwnerRoutines(db: Db, ownerId: UserId): Promise<Routine[]> {
  const rows = await db
    .select({ row: routines })
    .from(routines)
    .innerJoin(bots, eq(bots.id, routines.botId))
    .where(eq(bots.ownerId, ownerId))
    .orderBy(asc(routines.createdAt), asc(routines.id));
  return withRuns(
    db,
    rows.map(({ row }) => row),
  );
}

async function withRuns(db: Db, rows: readonly RoutineRow[]): Promise<Routine[]> {
  if (rows.length === 0) return [];
  const byRoutine = await listRunsByRoutine(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toRoutine(row, byRoutine.get(row.id) ?? []));
}

type RoutineRunRow = typeof routineRuns.$inferSelect;

/**
 * 每条例行任务最近 20 条运行记录，新的在前。库里会多于 20 条（还在跑的和同刻查重要留的不裁，见 trimRoutineRuns），
 * 给出去的还是最近 20 条。
 */
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
    else if (bucket.length < MAX_ROUTINE_RUNS) bucket.push(row);
  }
  return byRoutine;
}

export type RoutineInput = {
  readonly name: string;
  readonly instruction: string;
  readonly triggers: readonly TriggerInput[];
  readonly onFailure: OnFailure;
  /** null 或不给是发进 Bot 的单聊。 */
  readonly groupId?: GroupId | null | undefined;
  readonly purpose?: ModelPurpose | undefined;
  readonly state: RoutineState;
  readonly boundary: RoutineBoundary;
  readonly onToday: boolean;
};

export type InsertRoutineResult = { readonly kind: "ok"; readonly routine: Routine } | { readonly kind: "table_group" };

export type CreateRoutineResult = InsertRoutineResult | { readonly kind: "bot_gone" };

/**
 * 建例行先拿执行者的共享锁，锁到之后用新语句确认它还在且是本人的，再插。
 * 删 Bot 拿的是同一把锁的排他：删除先赢，这里看见 Bot 没了回 bot_gone；建例行先赢，删除的转交扫描一定看得见这一行。
 * 路由层的归属预检挡不住这个窗口，预检过了之后到插入之间删除可以整个做完。
 */
export async function createRoutine(
  db: Db,
  ownerId: UserId,
  botId: BotId,
  input: RoutineInput,
): Promise<CreateRoutineResult> {
  return db.transaction(async (tx) => {
    await shareBotRunsLock(tx, botId);
    const [alive] = await tx
      .select({ id: bots.id })
      .from(bots)
      .where(and(eq(bots.id, botId), eq(bots.ownerId, ownerId)))
      .limit(1);
    if (alive === undefined) return { kind: "bot_gone" };
    return insertRoutine(tx, {
      id: newId(),
      botId,
      name: input.name,
      instruction: input.instruction,
      triggers: mergeTriggers([], input.triggers),
      onFailure: input.onFailure,
      groupId: input.groupId ?? null,
      purpose: input.purpose ?? "plan",
      state: input.state,
      boundary: input.boundary,
      onToday: input.onToday,
    });
  });
}

export const TABLE_GROUP_ERROR = "牌桌群里不能建例行任务";

/**
 * 手建和点「加上」确认卡共用的落库。牌桌群只认出牌按钮，例行发进去的那条消息没有人接得住，两条入口都在这里挡。
 * 牌桌是开桌时新建的群，已有的群不会后来变成牌桌，所以查一次就够，不用锁。
 */
export async function insertRoutine(tx: Tx, values: typeof routines.$inferInsert): Promise<InsertRoutineResult> {
  if (values.groupId !== null && values.groupId !== undefined) {
    const [table] = await tx
      .select({ groupId: pokerTables.groupId })
      .from(pokerTables)
      .where(eq(pokerTables.groupId, values.groupId))
      .limit(1);
    if (table !== undefined) return { kind: "table_group" };
  }
  const [row] = await tx.insert(routines).values(values).returning();
  if (row === undefined) throw new Error("建例行任务没有返回行");
  return { kind: "ok", routine: toRoutine(row, []) };
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
  if (input.purpose !== undefined) patch.purpose = input.purpose;
  if (input.state !== undefined) patch.state = input.state;
  if (input.boundary !== undefined) patch.boundary = input.boundary;
  if (input.onToday !== undefined) patch.onToday = input.onToday;

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

/**
 * 删例行级联删运行记录，运行记录又经外键把 run 的 routine_run_id 置空，所以它也要守「runs 在前、运行记录在后」：
 * 先把能建出指着这些记录的 run 的 Bot 全锁成排他（lockRoutineWriters），再锁例行行，再按 id 升序锁住这些记录名下的 run，
 * 最后才删。结账是先锁 run 再改记录，两边同序只会排队。
 * 只锁执行者不够：项目群里执行者 @ 了同群的另一位，那位的 run 带着同一条记录，它在预锁和 DELETE 之间出生，级联就和它的结账互等。
 */
export async function deleteRoutine(db: Db, routineId: RoutineId): Promise<boolean> {
  return db.transaction(async (tx) => {
    if ((await lockRoutineWriters(tx, routineId)) === null) return false;
    if ((await lockRoutines(tx, eq(routines.id, routineId))).length === 0) return false;
    const records = await tx
      .select({ id: routineRuns.id })
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routineId));
    await lockRunsOfRecords(
      tx,
      records.map((one) => one.id),
    );
    const deleted = await tx.delete(routines).where(eq(routines.id, routineId)).returning({ id: routines.id });
    return deleted.length > 0;
  });
}

/**
 * 锁住所有能以这条例行的名义建 run 的 Bot，按 id 升序拿排他锁，拿到之后到提交前没有人能建出指着它的运行记录的 run。
 * 能建的是它所在群的成员（startRun 查成员表，不是成员建不出），单聊就是执行者自己。
 * 这份名单只在删 Bot 里变：成员被删（它拿着自己的排他锁，和这里互斥）、例行转给主助理、主助理补进项目群。
 * 删 Bot 里能加进来的只有主助理，所以主助理从一开始就在名单里，第一轮锁完再重读，名单只会少不会多，
 * 不会出现「已持几把锁再去拿一把 id 更小的」。建队确认往项目群加成员不拿这些锁，是 README 里的已知项。例行没了回 null。
 */
async function lockRoutineWriters(tx: Tx, routineId: string): Promise<OwnedRoutine | null> {
  const locked = new Set<string>();
  for (;;) {
    const current = await selectRoutine(tx, eq(routines.id, routineId));
    if (current === null) return null;
    const missing = (await writersOf(tx, current)).filter((id) => !locked.has(id));
    if (missing.length === 0) return current;
    for (const id of missing) {
      await exclusiveBotRunsLock(tx, BotId.parse(id));
      locked.add(id);
    }
  }
}

async function writersOf(tx: Tx, routine: OwnedRoutine): Promise<string[]> {
  const members =
    routine.row.groupId === null
      ? []
      : await tx
          .select({ id: groupMembers.botId })
          .from(groupMembers)
          .where(eq(groupMembers.groupId, routine.row.groupId));
  const assistants = await tx
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.ownerId, routine.ownerId), eq(bots.role, "assistant")));
  return [
    ...new Set([routine.row.botId, ...members.map((one) => one.id), ...assistants.map((one) => one.id)]),
  ].toSorted();
}

/** 这些运行记录名下的 run 按 id 升序 FOR UPDATE，和结账的 lockRuns、删 Bot 的 lockRunsOfBot 同序。 */
async function lockRunsOfRecords(tx: Tx, routineRunIds: readonly string[]): Promise<void> {
  if (routineRunIds.length === 0) return;
  await tx
    .select({ id: runs.id })
    .from(runs)
    .where(inArray(runs.routineRunId, [...routineRunIds]))
    .orderBy(asc(runs.id))
    .for("update");
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

/** 连着这么多次结果没人看，例行自己停下。 */
export const UNSEEN_RUNS_TO_PAUSE = 3;
/** 超预算没派活时记的那条 stopped 的 note。它不是一次真跑，不算进三次没人看。 */
export const OVER_BUDGET_NOTE = "本月超预算，没跑";

/**
 * seen 和自停的共同锁边界：两边都先锁住相关例行行（多条按 id 升序），锁到之后才读或改运行记录。
 * READ COMMITTED 下锁到之后的下一条语句拿新快照，看得见先拿到锁的那一边已经提交的 seen_at。
 */
async function lockRoutines(tx: Tx, where: SQL | undefined): Promise<string[]> {
  const locked = await tx
    .select({ id: routines.id })
    .from(routines)
    .where(where)
    .orderBy(asc(routines.id))
    .for("update");
  return locked.map((row) => row.id);
}

/**
 * 最近三条已结束的运行都没人看过，就把它从 on 停成 auto_paused，真的改了回 true。
 * 和 seen 谁先锁到例行行谁赢：seen 先就看见已读不停，自停先就停下，seen 随后只盖章。
 * 改写仍只认 state = 'on'：手动停的、已经自己停了的都不碰，重复收尾也只改一次。
 */
export async function autoPauseIfUnseen(db: Db, routineId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    if ((await lockRoutines(tx, eq(routines.id, routineId))).length === 0) return false;
    const latest = await tx
      .select({ seenAt: routineRuns.seenAt })
      .from(routineRuns)
      .where(
        and(
          eq(routineRuns.routineId, routineId),
          ne(routineRuns.status, "running"),
          ne(routineRuns.note, OVER_BUDGET_NOTE),
        ),
      )
      .orderBy(desc(routineRuns.startedAt), desc(routineRuns.id))
      .limit(UNSEEN_RUNS_TO_PAUSE);
    if (latest.length < UNSEEN_RUNS_TO_PAUSE || latest.some((run) => run.seenAt !== null)) return false;
    const paused = await tx
      .update(routines)
      .set({ state: "auto_paused" })
      .where(and(eq(routines.id, routineId), eq(routines.state, "on")))
      .returning({ id: routines.id });
    return paused.length > 0;
  });
}

/**
 * 用户打开了这个群：群里已结束、还没看过的例行运行全记成看过，回盖了章的例行 id。别人的群回 null。
 * 「这个群里的」是落进这个群的例行：groupId 指着它的，加上它是单聊时那个 Bot 不带群号的。
 */
export async function markGroupRoutineRunsSeen(db: Db, ownerId: UserId, groupId: GroupId): Promise<string[] | null> {
  return db.transaction(async (tx) => {
    const [group] = await tx
      .select({ soloBotId: groups.soloBotId })
      .from(groups)
      .where(and(eq(groups.id, groupId), eq(groups.ownerId, ownerId)))
      .limit(1);
    if (group === undefined) return null;
    const inGroup = await lockRoutines(
      tx,
      group.soloBotId === null
        ? eq(routines.groupId, groupId)
        : or(eq(routines.groupId, groupId), and(isNull(routines.groupId), eq(routines.botId, group.soloBotId))),
    );
    if (inGroup.length === 0) return [];
    const stamped = await tx
      .update(routineRuns)
      .set({ seenAt: sql`now()` })
      .where(
        and(inArray(routineRuns.routineId, inGroup), isNull(routineRuns.seenAt), ne(routineRuns.status, "running")),
      )
      .returning({ routineId: routineRuns.routineId });
    return [...new Set(stamped.map((row) => row.routineId))];
  });
}

/**
 * 项目归档，群里没停的例行一起记成手动暂停，回改了的例行 id。群由调用方的子查询给出，查不到就一条不改。
 * 多行 UPDATE 按扫描顺序逐行上锁，和 seen 的 id 升序撞上就成环，所以先按 lockRoutines 的顺序锁好，再用新语句改。
 */
export async function pauseGroupRoutines(tx: Tx, group: SQLWrapper): Promise<string[]> {
  const ids = await lockRoutines(tx, and(inArray(routines.groupId, group), ne(routines.state, "paused")));
  if (ids.length === 0) return [];
  const paused = await tx
    .update(routines)
    .set({ state: "paused" })
    .where(and(inArray(routines.id, ids), ne(routines.state, "paused")))
    .returning({ id: routines.id });
  return paused.map((row) => row.id);
}

export type MovedRoutine = { readonly id: string; readonly groupId: string | null };

/** 执行者被删时，它还在跑的例行运行记录收成失败用的 note。 */
export const EXECUTOR_DELETED_NOTE = "执行者已删除，这次没跑完";

/**
 * 执行者要被删了，它的例行转给主助理，回转走的例行和它们留着的群号。
 * 指着它单聊群的例行改成不带群号：单聊随 Bot 级联删掉，留着群号就会跟着被删，不带群号的发进主助理的单聊。
 * 项目群的群号保留，主助理进不进那个群由调用方在删掉 Bot 行之后补（joinGroups）。
 * 先按 id 升序锁行再改，和归档、seen 同序。它还在跑的运行记录一并收成失败：
 * 删除把 run 的 bot_id 置空，旧执行者的收尾报文过不了归属校验，不在这里收就永远停在 running。
 */
export async function transferRoutines(tx: Tx, fromBotId: BotId, toBotId: BotId): Promise<MovedRoutine[]> {
  const ids = await lockRoutines(tx, eq(routines.botId, fromBotId));
  if (ids.length === 0) return [];
  const soloGroup = tx.select({ id: groups.id }).from(groups).where(eq(groups.soloBotId, fromBotId));
  const moved = await tx
    .update(routines)
    .set({
      botId: toBotId,
      groupId: sql`CASE WHEN ${routines.groupId} IN (${soloGroup}) THEN NULL ELSE ${routines.groupId} END`,
    })
    .where(inArray(routines.id, ids))
    .returning({ id: routines.id, groupId: routines.groupId });
  await tx
    .update(routineRuns)
    .set({ status: "failed", note: withStatusNote(EXECUTOR_DELETED_NOTE) })
    .where(and(inArray(routineRuns.routineId, ids), eq(routineRuns.status, "running")));
  return moved;
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

/**
 * cron：到点，例行不是 on 就不跑，同一刻只落一条记录。webhook：外部调用，不是 on 也不跑。
 * trial：用户点的试跑，停着也照跑。
 */
export type RunOrigin = "cron" | "webhook" | "trial";

export type OpenedRoutineRun = {
  readonly id: string;
  /** 锁到之后重读的例行，派发按它而不是调用方手里那份。 */
  readonly row: RoutineRow;
  /** 这次运行落进哪个群：例行带群号就是它，不带就是执行者的单聊。 */
  readonly groupId: GroupId;
};

/**
 * 触发那一刻落一条 running。调用方的事务里做，群里那两条消息和它一起提交；多出 20 条的裁剪不在这里，派发收尾之后另开事务（trimRoutineRuns）。
 * 先拿执行者的共享锁再用新语句重读：调用方手里的例行是扫到时的样子，删 Bot 可能已经把它转给主助理、连单聊一起删了。
 * 重读到的执行者换了人就对新执行者再锁一次再读，直到锁住的就是读到的那位。例行没了回 null，不落记录。
 * 自动触发（到点、webhook）锁住执行者之后再锁例行行：这是 seen、自停、转交、暂停共用的那道边界，
 * 锁到之后重读的状态是这些事提交后的样子，不是 on 就不跑：调度器扫到时是 on，前一个触发器的收尾让它刚自己停下，
 * 这一个就不能再跑。两个调度器各认领同一刻的一个 cron 时，先到的锁着例行行直到提交，后到的推游标那条 UPDATE 就排在它后面，
 * 轮到它时看见同一刻已经有记录就不再落第二条；记录在库里，控制面重启或两个进程各自认领都挡得住。
 * 试跑是用户点的，停着也照跑，也不锁例行行：它和 seen、自停谁先谁后无所谓。
 */
export async function openRoutineRun(
  tx: Tx,
  routineId: string,
  startedAt: Date,
  origin: RunOrigin,
): Promise<OpenedRoutineRun | null> {
  let current = await lockExecutor(tx, routineId, shareBotRunsLock);
  if (current === null) return null;
  if (origin !== "trial") {
    if ((await lockRoutines(tx, eq(routines.id, routineId))).length === 0) return null;
    current = await selectRoutine(tx, eq(routines.id, routineId));
    if (current === null || current.row.state !== "on") return null;
  }
  if (origin === "cron") {
    const [sameMoment] = await tx
      .select({ id: routineRuns.id })
      .from(routineRuns)
      .where(and(eq(routineRuns.routineId, routineId), eq(routineRuns.startedAt, startedAt)))
      .limit(1);
    if (sameMoment !== undefined) return null;
  }
  const groupId =
    current.row.groupId ??
    (await tx.select({ id: groups.id }).from(groups).where(eq(groups.soloBotId, current.row.botId)).limit(1))[0]?.id;
  if (groupId === undefined) return null;

  const [row] = await tx.insert(routineRuns).values({ id: newId(), routineId, startedAt }).returning({
    id: routineRuns.id,
  });
  if (row === undefined) throw new Error("建运行记录没有返回行");
  return { id: row.id, row: current.row, groupId: GroupId.parse(groupId) };
}

/**
 * 先拿执行者的锁再用新语句重读，直到锁住的就是读到的那位：调用方手里的例行是扫到时的样子，
 * 删 Bot 可能已经把它转给主助理。例行没了回 null。
 */
async function lockExecutor(
  tx: Tx,
  routineId: string,
  lock: (tx: Tx, botId: BotId) => Promise<void>,
): Promise<OwnedRoutine | null> {
  let locked: string | null = null;
  let current = await selectRoutine(tx, eq(routines.id, routineId));
  while (current !== null && current.row.botId !== locked) {
    locked = current.row.botId;
    await lock(tx, BotId.parse(locked));
    current = await selectRoutine(tx, eq(routines.id, routineId));
  }
  return current;
}

/**
 * 把前 20 条之外的运行记录裁掉，触发事务提交之后另开一个事务做。
 * 两种记录留着不裁：
 * 还在跑的，派活建 run 的事务可能还没提交，裁了它 run 就指着不存在的记录（23503），收尾也找不回它；
 * started_at 正好等于某个 cron 游标的，到点触发靠「同一刻已有记录」挡第二个触发器，另一个调度器推完游标才来查重，
 * 它查的就是这一刻。只认相等：游标之后的试跑和 webhook 记录照裁，否则周更、月更的例行配上 webhook，库里一整个周期都封不了顶。
 * 删记录经外键把 run 的 routine_run_id 置空，先按 id 升序锁住这些 run 再删：结账是先锁 run 再改记录，同序只会排队。
 * 锁 run 之前先把能建出这种 run 的 Bot 全锁成排他（lockRoutineWriters）：项目群里执行者 @ 了同群的另一位，
 * 那位的 run 指着被裁的记录，在预锁和 DELETE 之间出生就和它的结账互等。触发事务持着执行者的共享锁，升不成排他，所以裁剪不在它里面做。
 * 锁序和删例行一样：Bot 排他 → 例行行 → run → 运行记录。锁到例行行之后重读触发器，游标是这一刻的样子。
 */
export async function trimRoutineRuns(db: Db, routineId: string): Promise<void> {
  await db.transaction(async (tx) => {
    if ((await lockRoutineWriters(tx, routineId)) === null) return;
    if ((await lockRoutines(tx, eq(routines.id, routineId))).length === 0) return;
    const current = await selectRoutine(tx, eq(routines.id, routineId));
    if (current === null) return;
    const cursors = cursorMoments(current.row.triggers);
    const kept = tx
      .select({ id: routineRuns.id })
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routineId))
      .orderBy(desc(routineRuns.startedAt), desc(routineRuns.id))
      .limit(MAX_ROUTINE_RUNS);
    const retired = await tx
      .select({ id: routineRuns.id })
      .from(routineRuns)
      .where(
        and(
          eq(routineRuns.routineId, routineId),
          ne(routineRuns.status, "running"),
          cursors.length === 0 ? undefined : notInArray(routineRuns.startedAt, cursors),
          notInArray(routineRuns.id, kept),
        ),
      );
    if (retired.length === 0) return;
    const ids = retired.map((one) => one.id);
    await lockRunsOfRecords(tx, ids);
    await tx.delete(routineRuns).where(inArray(routineRuns.id, ids));
  });
}

/** 各 cron 触发器的游标。没对齐过的还没有游标，它认领的时刻一定晚于现在，现在库里没有要留的记录。 */
function cursorMoments(triggers: readonly StoredTrigger[]): Date[] {
  return triggers.flatMap((trigger) =>
    trigger.kind === "cron" && trigger.lastFiredAt !== null ? [new Date(trigger.lastFiredAt)] : [],
  );
}

export type RoutineRunRef = {
  readonly routineRunId: string;
  readonly routineId: string;
  readonly name: string;
  readonly onFailure: OnFailure;
};

/** 这个 run 是哪条运行记录派出去的。回 null 就是普通的一次对话，不是例行任务。 */
export async function routineRunOfRun(db: Db | Tx, runId: string): Promise<RoutineRunRef | null> {
  const [row] = await db
    .select({
      routineRunId: routineRuns.id,
      routineId: routines.id,
      name: routines.name,
      onFailure: routines.onFailure,
    })
    .from(runs)
    .innerJoin(routineRuns, eq(routineRuns.id, runs.routineRunId))
    .innerJoin(routines, eq(routines.id, routineRuns.routineId))
    .where(eq(runs.id, runId))
    .limit(1);
  return row ?? null;
}

/** 没派活的一次：落库就是 stopped，不经过 running，也没有 run 行记账。 */
export async function recordStoppedRoutineRun(db: Db, routineId: string, startedAt: Date, note: string): Promise<void> {
  await db.insert(routineRuns).values({ id: newId(), routineId, startedAt, status: "stopped", note });
}

// 开头那句状态短句：不以 ¥ 开头，自己不带「 · 」。
const STATUS_NOTE = "^[^¥][^·]*(?: · |$)";

/**
 * note 是「状态短句 · 各段花费」。换状态只换开头那句，链上前几段缀的花费都留着：
 * 「1 条等你点头 · ¥0.80」收成失效是「审批已失效 · ¥0.80」，同一句再记一次还是它自己。
 */
function withStatusNote(status: string): SQL {
  const costs = sql`regexp_replace(${routineRuns.note}, ${STATUS_NOTE}, '')`;
  return sql`CASE WHEN ${costs} = '' THEN ${status} ELSE ${status} || ' · ' || ${costs} END`;
}

/** 收尾。只改还在 running 的那一条，重复的报文和已经停下的记录都不再动。前几段缀上的花费留在后面。 */
export async function settleRoutineRun(
  db: Db | Tx,
  routineRunId: string,
  status: Exclude<RoutineRunStatus, "running">,
  note: string,
): Promise<string | null> {
  const [row] = await db
    .update(routineRuns)
    .set({ status, note: withStatusNote(note) })
    .where(and(eq(routineRuns.id, routineRunId), eq(routineRuns.status, "running")))
    .returning({ routineId: routineRuns.routineId });
  return row?.routineId ?? null;
}

/** 审批挂起后运行记可能已是 stopped；失效要把 running 和 stopped 都收成 failed。 */
export async function failRoutineRun(db: Db | Tx, routineRunId: string, note: string): Promise<string | null> {
  const [row] = await db
    .update(routineRuns)
    .set({ status: "failed", note: withStatusNote(note) })
    .where(and(eq(routineRuns.id, routineRunId), inArray(routineRuns.status, ["running", "stopped"])))
    .returning({ routineId: routineRuns.routineId });
  return row?.routineId ?? null;
}

/** 只补 note，状态一个字不改。`retry_next_time` 遇到审批走这里：记一笔，活照样算在跑。 */
export async function noteRoutineRun(db: Db | Tx, routineRunId: string, note: string): Promise<string | null> {
  const [row] = await db
    .update(routineRuns)
    .set({ note: withStatusNote(note) })
    .where(and(eq(routineRuns.id, routineRunId), eq(routineRuns.status, "running")))
    .returning({ routineId: routineRuns.routineId });
  return row?.routineId ?? null;
}

/**
 * 活跑完了：note 后面缀上这次的花费。停下等点头的那条因此长成「1 条等你点头 · ¥0.80」。
 * 后面还有换电脑的接续（continues）时状态不动，由接续那一轮收尾；否则还在 running 的记成 ok，已经停下的保持原状。
 */
export async function chargeRoutineRun(
  db: Db | Tx,
  routineRunId: string,
  cost: string,
  continues: boolean,
): Promise<void> {
  if (!continues) {
    await db
      .update(routineRuns)
      .set({ status: "ok" })
      .where(and(eq(routineRuns.id, routineRunId), eq(routineRuns.status, "running")));
  }
  await db
    .update(routineRuns)
    .set({
      note: sql`CASE WHEN ${routineRuns.note} = '' THEN ${cost} ELSE ${routineRuns.note} || ' · ' || ${cost} END`,
    })
    .where(eq(routineRuns.id, routineRunId));
}
