import { BotId, ComputerId, GroupId, RunId, type MessageId, type UsageRecord, type UserId } from "@baize/shared";
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bots, groupMembers, groups, runs } from "../db/schema.js";
import { newId } from "../ids.js";
import type { Tx } from "./messages.js";
import { toUsageRecord } from "./rows.js";

export type StartRunInput = {
  readonly ownerId: UserId;
  readonly computerId: ComputerId;
  readonly botId: BotId;
  readonly groupId: GroupId;
  readonly triggerMessageId: MessageId;
  /** 例行任务派出来的活带着它。run 行一生出来就认领了那条运行记录，收尾报文因此不会扑空。 */
  readonly routineRunId?: string | undefined;
};

/**
 * 收尾和建 run 共用的 advisory 锁，键是 (群, Bot)。两参数形式，第一参数是这块的命名空间；
 * 仓库里别处的 advisory 锁都是单参数的 bigint 键，两种形式在 pg_locks 里不是一个键空间，撞不上。
 * 哈希撞了只是多串行一点，不会错。
 *
 * 为什么要它：收尾时把同一个 Bot 在同一个群里的流式文字一并定稿，前提是「没有别的 open run」，
 * 而 READ COMMITTED 下两条 run 同时收尾各自看见对方还开着，都会跳过定稿；
 * 收尾途中新建出来的 run 也会让这次判断失真。同一把锁让这几件事排队：后来的等先来的提交，
 * 之后的语句拿新快照，看得见先来的那一下。锁序固定为 advisory → runs → messages，写帧不拿它。
 * 每个收尾事务只收一条 run，只拿一把键，没有多键排序的问题。
 */
const SETTLEMENT_LOCK = 0x627a7265;

/** 在当前事务里拿 (群, Bot) 的收尾锁，提交或回滚时放。 */
export async function lockSettlement(tx: Tx, groupId: GroupId, botId: BotId): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${SETTLEMENT_LOCK}::int4, hashtext(${groupId}::text || '/' || ${botId}::text))`,
  );
}

/** 按 run 行上的群和 Bot 拿同一把收尾锁。群或 Bot 已经被删、列置空了，就没有可定稿的东西，不拿。 */
export async function lockSettlementOfRun(tx: Tx, runId: RunId): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${SETTLEMENT_LOCK}::int4, hashtext(${runs.groupId} || '/' || ${runs.botId}))
        FROM ${runs} WHERE ${runs.id} = ${runId} AND ${runs.groupId} IS NOT NULL AND ${runs.botId} IS NOT NULL`,
  );
}

/**
 * 删 Bot 和给它建 run 互斥的 advisory 锁，键是 Bot。和收尾锁同为两参数形式，命名空间不同。
 * 删除拿排他、建 run 拿共享：删除拿到时这个 Bot 已有的 run 都已提交、看得见，之后在任何群里都建不出新 run，
 * 包括删除开始之后才建的群。按成员表逐群拿收尾锁做不到这一点，成员表是删除开始那一刻的快照。
 */
const BOT_RUNS_LOCK = 0x627a6274;

/**
 * 账号级的边界，键是用户。删号拿排他，建 Bot、建群、开项目、建 run 拿共享，都在事务第一句、碰任何行之前。
 * 删号枚举 Bot 拿 Bot 锁那一步是开始那一刻的快照，之后才建的 Bot 不在里头，它的 run 会成为归属人置空的孤儿；
 * 建 Bot 和建 run 先过这把锁，删号拿到排他时过锁建出的 Bot 都已提交、枚举得到，之后到提交前过锁的入口建不出 Bot 和 run。
 * 补建主助理不过它，枚举之后插出的主助理随 users 级联删掉，建不出 run 靠 startRun 自己过这把锁。
 * 建群和开项目也过它，是为了不和删号的级联反序：它们先锁 Bot 行再占发号器，删号先删 users 行再级联到 Bot 和发号器。
 * 锁序硬约束：同一个事务要这把锁和 Bot 锁时，这把永远在前。删号是账号排他在前、Bot 排他在后，反过来拿就各拿一半成环。
 * 不用 users 行锁：run 名下的写要插带归属人外键的行（草稿、项目卡），插入隐式拿 users 的 KEY SHARE，和删号的 DELETE 各拿一半就成环。
 */
const OWNER_LOCK = 0x627a6f77;

export async function lockOwner(tx: Tx, ownerId: UserId, mode: "exclusive" | "shared"): Promise<void> {
  await tx.execute(
    mode === "exclusive"
      ? sql`SELECT pg_advisory_xact_lock(${OWNER_LOCK}::int4, hashtext(${ownerId}::text))`
      : sql`SELECT pg_advisory_xact_lock_shared(${OWNER_LOCK}::int4, hashtext(${ownerId}::text))`,
  );
}

/**
 * 删 Bot 的事务开头调用，先于删 Bot 碰的任何一行。两件事：
 * 拿这个 Bot 的排他锁，删除提交前它不会再生新 run；
 * 再把外键级联要改的 open run（它自己的，和它单 Bot 群里的）先锁成 FOR UPDATE。
 * run 名下的写都是先拿 run 的共享锁、再碰任务、群、交接这些行，删除的级联反过来先碰那些行、最后才改 runs，
 * 两边各拿一半就成了死锁环。这里让删除也是 runs 在前，在途的写要么先提交，要么等删除提交后查不到自己的 run。
 */
export async function lockRunsOfBot(tx: Tx, botId: BotId): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${BOT_RUNS_LOCK}::int4, hashtext(${botId}::text))`);
  const soloGroup = tx.select({ id: groups.id }).from(groups).where(eq(groups.soloBotId, botId));
  await tx
    .select({ id: runs.id })
    .from(runs)
    .where(and(or(eq(runs.botId, botId), inArray(runs.groupId, soloGroup)), isNull(runs.endedAt)))
    .for("update");
}

/**
 * 建 run 先拿归属人的共享锁，再拿 Bot 的共享锁，再拿收尾锁：同一个 Bot 在同一个群里正在收尾时，新 run 等它提交再出生，不会让定稿的判断失真。
 * 等到的若是删 Bot 或删号的提交，Bot 已经不在这个群里，锁之后这条查成员的新语句看得见，回 null，不建 run。
 * 归属人的锁管的是 Bot 锁管不到的 Bot：删号枚举 Bot 之后才进库的（hello 补建的主助理、项目群的助理），它的 Bot 锁不在删号手里。
 */
export async function startRun(db: Db, input: StartRunInput): Promise<RunId | null> {
  return db.transaction(async (tx) => {
    await lockOwner(tx, input.ownerId, "shared");
    await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${BOT_RUNS_LOCK}::int4, hashtext(${input.botId}::text))`);
    await lockSettlement(tx, input.groupId, input.botId);
    const [member] = await tx
      .select({ botId: groupMembers.botId })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, input.groupId), eq(groupMembers.botId, input.botId)));
    if (member === undefined) return null;
    const [row] = await tx
      .insert(runs)
      .values({
        id: newId(),
        ownerId: input.ownerId,
        computerId: input.computerId,
        botId: input.botId,
        groupId: input.groupId,
        triggerMessageId: input.triggerMessageId,
        routineRunId: input.routineRunId ?? null,
        isRoutine: input.routineRunId !== undefined,
        startedAt: new Date(),
      })
      .returning({ id: runs.id });
    if (row === undefined) throw new Error("建 run 没有返回行");
    return RunId.parse(row.id);
  });
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
 * `run_done` 结束的行账还没结，charged_at 留空等 claimCharge；abandonRun 结束的行没有账，同一句就写上。
 */
export async function finishRun(
  db: Db | Tx,
  runId: RunId,
  groupId: GroupId | null,
  totals: RunTotals,
  ending: "run_done" | "abandoned",
): Promise<UsageRecord | null> {
  const now = new Date();
  const [row] = await db
    .update(runs)
    .set({
      endedAt: now,
      chargedAt: ending === "abandoned" ? now : null,
      steps: totals.steps,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      amount: totals.amount.toFixed(6),
    })
    .where(
      and(
        eq(runs.id, runId),
        groupId === null ? isNull(runs.groupId) : eq(runs.groupId, groupId),
        isNull(runs.endedAt),
      ),
    )
    .returning();
  return row === undefined ? null : toUsageRecord(row);
}

/**
 * 认领结账：已结束、还没结过账的行才给，RETURNING 的是结束时写下的用量，费用卡按它出。
 * 已结过账的、还没结束的、abandonRun 收掉的都回 null。两条 run_done 先后撞上同一行时第二条拿不到行，
 * 幂等靠 WHERE charged_at IS NULL，不先查后写。调用方在事务里拿，账没写完事务回滚，认领一起回滚。
 */
export async function claimCharge(tx: Tx, runId: RunId): Promise<UsageRecord | null> {
  const [row] = await tx
    .update(runs)
    .set({ chargedAt: new Date() })
    .where(and(eq(runs.id, runId), isNotNull(runs.endedAt), isNull(runs.chargedAt)))
    .returning();
  return row === undefined ? null : toUsageRecord(row);
}

/** run 名下一次写所认的那条 run：resolveRun 校验过的群和 Bot。 */
export type RunScope = { readonly runId: RunId; readonly botId: BotId; readonly groupId: GroupId };

/**
 * run 名下的追加写在自己的事务里先过这一道：run 还没结束、而且还是这个 Bot 在这个群里的活，才拿到它的共享锁，
 * 否则返回 false，调用方整条不写。Bot 被删时外键把 bot_id 置空，在途的帧因此也被挡下。
 * 光在写的 WHERE 里带 `ended_at IS NULL` 闭合不了并发：READ COMMITTED 下 INSERT 的子查询看不见收尾还没提交的结束，
 * 插进来的那条又在收尾那条 UPDATE 的快照之外。共享锁和 finishRun 的 UPDATE 互斥：
 * 这里先拿到锁，收尾就等这次写提交，后面收消息的语句看得见它；收尾先拿到，这里等它提交后重查，查不到行。
 */
export async function lockOpenRun(tx: Tx, run: RunScope): Promise<boolean> {
  const [row] = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, run.runId), eq(runs.botId, run.botId), eq(runs.groupId, run.groupId), isNull(runs.endedAt)))
    .for("share");
  return row !== undefined;
}

/** 一次 run 名下的写：开事务、过 lockOpenRun 再写。run 已经结束或不再归这个 Bot 和群，返回 null，什么都没写。 */
export async function whileRunOpen<T>(db: Db, run: RunScope, write: (tx: Tx) => Promise<T>): Promise<T | null> {
  return db.transaction(async (tx) => ((await lockOpenRun(tx, run)) ? write(tx) : null));
}

/** 这个 run 确实是这个 Bot 在这个群里的活。上行报文的 runId 是外部输入，外键管不了它指到哪个群。 */
export async function runBelongsTo(
  db: Db,
  runId: RunId,
  botId: BotId,
  groupId: string,
  computerId: ComputerId,
): Promise<boolean> {
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.botId, botId), eq(runs.groupId, groupId), eq(runs.computerId, computerId)))
    .limit(1);
  return row !== undefined;
}

export type OpenRun = { readonly runId: RunId; readonly groupId: GroupId; readonly botId: BotId };

export async function openRunsForComputer(
  db: Db,
  computerId: ComputerId,
): Promise<readonly { readonly runId: RunId; readonly groupId: GroupId | null }[]> {
  const rows = await db
    .select({ runId: runs.id, groupId: runs.groupId })
    .from(runs)
    .where(and(eq(runs.computerId, computerId), isNull(runs.endedAt)));
  return rows.map((row) => ({
    runId: RunId.parse(row.runId),
    groupId: row.groupId === null ? null : GroupId.parse(row.groupId),
  }));
}

/**
 * 这台电脑名下结束了、没结账的 run：结账事务没提交过，或是先记着、还没进费用卡的 pass。
 * 群或 Bot 删掉了的行没有费用卡可落，不在里面。
 */
export async function unchargedRunsForComputer(db: Db, computerId: ComputerId): Promise<readonly RunScope[]> {
  const rows = await db
    .select({ runId: runs.id, botId: runs.botId, groupId: runs.groupId })
    .from(runs)
    .where(
      and(
        eq(runs.computerId, computerId),
        isNotNull(runs.endedAt),
        isNull(runs.chargedAt),
        isNotNull(runs.botId),
        isNotNull(runs.groupId),
      ),
    )
    .orderBy(runs.endedAt);
  return rows.map((row) => ({
    runId: RunId.parse(row.runId),
    botId: BotId.parse(row.botId),
    groupId: GroupId.parse(row.groupId),
  }));
}

/** 该电脑最近一条还没结束的 run。agent_error 报文里没有群号，只能落到它上面。 */
export async function latestOpenRun(db: Db, computerId: ComputerId): Promise<OpenRun | null> {
  const [row] = await db
    .select({ runId: runs.id, groupId: runs.groupId, botId: runs.botId })
    .from(runs)
    .innerJoin(bots, eq(bots.id, runs.botId))
    .where(and(eq(runs.computerId, computerId), isNull(runs.endedAt)))
    .orderBy(desc(runs.startedAt))
    .limit(1);
  if (row === undefined) return null;
  return {
    runId: RunId.parse(row.runId),
    groupId: GroupId.parse(row.groupId),
    botId: BotId.parse(row.botId),
  };
}
