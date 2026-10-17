import {
  BotId,
  GroupId,
  MessageId,
  RoutineId,
  RunId,
  UserId,
  type ComputerId,
  type ComputerKind,
  type Message,
  type ServerPush,
  type SwitchComputerResponse,
} from "@baize/shared";
import { and, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { computers, groupMembers, routineRuns, routines, runs } from "../db/schema.js";
import { findOwnedMessage, type Tx } from "../repo/messages.js";
import { routineRunOfRun, settleRoutineRun, type RoutineRunRef } from "../repo/routines.js";
import { chooseComputer } from "./computer-choice.js";
import type { ComputerAvailability } from "./computer-availability.js";
import { SELECTION_FAILURE, type SelectionFailure } from "./computer-selection.js";
import type { ContinuationRoutine, ContinuationSpeaker } from "./group-turn.js";

export type SwitchOutcome = SwitchComputerResponse;

type SwitchRefusal = Extract<SwitchOutcome, { result: "refused" }>["reason"];

const COMPUTER_NAME: Record<ComputerKind, string> = { remote: "云电脑", local: "主人的电脑" };

/** 拒绝的文案原样给模型当工具错误，所以按目标那台说。 */
export const SWITCH_REFUSED: Record<SwitchRefusal, (kind: ComputerKind) => string> = {
  not_current_run: () => "这一轮已经结束，换不了电脑。",
  already_continued: () => "这一轮已经换过一次电脑，不能再换，请在当前这台上做完或告诉主人。",
  routine_failed: () => "这次例行任务已经记成失败，换不了电脑，请在当前这台上收尾或告诉主人。",
  same_computer: (kind) => `你这一轮就在${COMPUTER_NAME[kind]}上，不用换。`,
  no_such_computer: (kind) => `没有${COMPUTER_NAME[kind]}这台电脑，换不了。`,
  target_offline: (kind) => `${COMPUTER_NAME[kind]}现在不在线，换不过去，这一轮继续在当前这台上做。`,
};

export function continuationText(to: ComputerKind): string {
  return `刚才你请求换电脑，现在已经换到${COMPUTER_NAME[to]}上了。接着刚才没做完的事做，之前对话里的内容都在，不要重新问主人，也不要把前面做过的再做一遍。`;
}

function refused(reason: SwitchRefusal, kind: ComputerKind): SwitchOutcome {
  return { result: "refused", reason, text: SWITCH_REFUSED[reason](kind) };
}

export type ChoiceDeps = { readonly availability: () => Promise<readonly ComputerAvailability[]> };

/**
 * Bot 在这一轮里请求换电脑。只认这台电脑上、这条道上、还没结束的普通 run；牌桌 run 和别人的 run 都当不是当前这一轮。
 * 选择的改动和 run 行上的标记在同一个事务里落；pushes 要等调用方提交后再推。
 * 模型重试同一次请求时标记已经立着，UPDATE 不到行也仍回 switching。接续只起一条：起的那一下认领这个标记（takeContinuation）。
 *
 * 标记立着就是「还欠一条没起的接续」。例行派起的 run 欠着接续时，运行记录不由它收尾，由这条链最后一个 run 收尾；
 * 链在起接续之前断了，收尾也在这个文件里，和清标记同一条 UPDATE 认领。
 */
export async function requestSwitch(
  tx: Tx,
  input: {
    readonly ownerId: UserId;
    readonly computerId: ComputerId;
    readonly lane: { readonly botId: BotId; readonly groupId: GroupId };
    readonly runId: RunId;
    readonly kind: ComputerKind;
  },
  deps: ChoiceDeps,
): Promise<{ readonly outcome: SwitchOutcome; readonly pushes: readonly ServerPush[] }> {
  const [run] = await tx.select().from(runs).where(eq(runs.id, input.runId)).for("no key update");
  if (
    run === undefined ||
    run.ownerId !== input.ownerId ||
    run.botId !== input.lane.botId ||
    run.groupId !== input.lane.groupId ||
    run.computerId !== input.computerId ||
    run.tableRole !== null ||
    run.endedAt !== null
  )
    return { outcome: refused("not_current_run", input.kind), pushes: [] };
  if (run.continuesRunId !== null) return { outcome: refused("already_continued", input.kind), pushes: [] };
  // 不带 runId 的报错、审批过期会把还开着的例行记成 failed，它们和这里锁同一行。记了 failed 就不起接续，
  // 免得子段做成了、记录却停在 failed、也不弹结果。
  if (run.routineRunId !== null && (await routineRunStatus(tx, run.routineRunId)) === "failed")
    return { outcome: refused("routine_failed", input.kind), pushes: [] };
  const [here] = await tx.select({ kind: computers.kind }).from(computers).where(eq(computers.id, input.computerId));
  if (here?.kind === input.kind) return { outcome: refused("same_computer", input.kind), pushes: [] };
  const chosen = await chooseComputer(
    tx,
    { ownerId: input.ownerId, groupId: input.lane.groupId, botId: input.lane.botId, kind: input.kind, by: "bot" },
    deps,
  );
  if (chosen.kind === "refused") return { outcome: refused(chosen.reason, input.kind), pushes: [] };
  if (chosen.kind === "not_found") return { outcome: refused("not_current_run", input.kind), pushes: [] };
  await tx
    .update(runs)
    .set({ continueRequested: true })
    .where(and(eq(runs.id, input.runId), isNull(runs.endedAt), eq(runs.continueRequested, false)));
  return { outcome: { result: "switching" }, pushes: chosen.kind === "changed" ? chosen.pushes : [] };
}

async function routineRunStatus(tx: Tx, routineRunId: string) {
  const [row] = await tx
    .select({ status: routineRuns.status })
    .from(routineRuns)
    .where(eq(routineRuns.id, routineRunId));
  return row?.status;
}

/**
 * 起接续时在落行的事务里认领标记，回被接续那一轮的运行记录，接续沿用它。
 * 认领不到就是已经起过，或者主人插话、派不出去先清掉了，不建第二条。
 */
export async function takeContinuation(
  tx: Tx,
  fromRunId: RunId,
): Promise<{ readonly routineRunId: string | null; readonly isRoutine: boolean } | null> {
  const [row] = await tx
    .update(runs)
    .set({ continueRequested: false })
    .where(and(eq(runs.id, fromRunId), eq(runs.continueRequested, true)))
    .returning({ routineRunId: runs.routineRunId, isRoutine: runs.isRoutine });
  return row ?? null;
}

/**
 * 这一轮之后还有接续：标记立着（还没起），或者已经有 run 接着它（补结账晚于接续起来）。
 * 结账和放弃都在锁住这条 run 的事务里读，认领标记的 UPDATE 要等这把行锁，读到的结论在提交前不会变。
 */
export async function continuesAfter(db: Db | Tx, runId: RunId): Promise<boolean> {
  const [row] = await db
    .select({
      // 子查询里比的是参数不是外层列：drizzle 在 select 字段里把 ${runs.id} 渲染成不带表名的 "id"，会绑到 later 上。
      continues: sql<boolean>`${runs.continueRequested} OR EXISTS (SELECT 1 FROM ${runs} WHERE ${runs.continuesRunId} = ${runId})`,
    })
    .from(runs)
    .where(eq(runs.id, runId));
  return row?.continues ?? false;
}

export type ChainBreak = { readonly status: "stopped" | "failed"; readonly note: string };

export const MEMBER_GONE_BREAK: ChainBreak = {
  status: "stopped",
  note: "换电脑后执行它的 Bot 不在这个群里了，没接着做",
};
export const DISPATCH_FAILED_BREAK: ChainBreak = { status: "failed", note: "派活出错，换电脑后没接着做" };
export const TRIGGER_GONE_BREAK: ChainBreak = { status: "failed", note: "换电脑后读不到派起它的那条消息，没接着做" };

export function unplacedBreak(reason: SelectionFailure): ChainBreak {
  return { status: "failed", note: `${SELECTION_FAILURE[reason].why}，换电脑后没接着做` };
}

/**
 * 接续没起成，链在这里断：认领标记，旧 run 是例行派起的就按 end 收尾。
 * 认领不到就是接续已经起了，或者别处先收了尾，什么都不做。回收了尾的那条运行记录。
 */
export async function breakContinuation(db: Db, fromRunId: RunId, end: ChainBreak): Promise<RoutineRunRef | null> {
  return db.transaction(async (tx) => {
    const taken = await takeContinuation(tx, fromRunId);
    if (taken === null || taken.routineRunId === null) return null;
    const ref = await routineRunOfRun(tx, fromRunId);
    if (ref === null || (await settleRoutineRun(tx, ref.routineRunId, end.status, end.note)) === null) return null;
    return ref;
  });
}

/** 删 Bot 取消它所有的道时一起清，和 cancel 同一个事务。 */
export async function clearBotContinuations(tx: Tx, botId: BotId): Promise<void> {
  await tx
    .update(runs)
    .set({ continueRequested: false })
    .where(and(eq(runs.botId, botId), eq(runs.continueRequested, true)));
}

export const INTERJECTED_NOTE = "换电脑后你在群里插了话，没接着做";

/**
 * 这个群里所有还没起接续的换电脑标记。用户在群里又说了话，之前那段活不再自动接着做。
 * 旧 run 已经结束的，例行运行记录在这里收成 stopped；还没结束的照常由它自己结账收尾。回要推的例行 id。
 */
export async function clearGroupContinuations(db: Db, groupId: GroupId): Promise<string[]> {
  return db.transaction(async (tx) => {
    const cleared = await tx
      .update(runs)
      .set({ continueRequested: false })
      .where(and(eq(runs.groupId, groupId), eq(runs.continueRequested, true)))
      .returning({ routineRunId: runs.routineRunId, endedAt: runs.endedAt });
    const routineIds: string[] = [];
    for (const { routineRunId, endedAt } of cleared) {
      if (routineRunId === null || endedAt === null) continue;
      const routineId = await settleRoutineRun(tx, routineRunId, "stopped", INTERJECTED_NOTE);
      if (routineId !== null) routineIds.push(routineId);
    }
    return routineIds;
  });
}

export type PendingContinuation = {
  readonly runId: RunId;
  readonly ownerId: UserId;
  readonly botId: BotId;
  readonly groupId: GroupId;
  /** 按这个 Bot 的视角读不到了是 null：不该有，有了也要断链收尾，不能让记录一直 running。 */
  readonly trigger: Message | null;
  readonly choice: ComputerKind | null;
  readonly routine: ContinuationRoutine | null;
};

/** 旧 run 请求过换电脑、已经结束、还没有接续时，接续这一位要说的话。选择又被清掉了就不起。 */
export function continuationSpeaker(pending: PendingContinuation, trigger: Message): ContinuationSpeaker | null {
  if (pending.choice === null) return null;
  return {
    botId: pending.botId,
    trigger,
    reason: "continuation",
    continuation: { fromRunId: pending.runId, text: continuationText(pending.choice), routine: pending.routine },
  };
}

/** 还欠着接续的 run：标记立着、已经结束。只取 id，补扫逐条再读，一条读出错不挡后面的。 */
export async function pendingContinuationIds(db: Db, ownerId?: UserId): Promise<readonly RunId[]> {
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(pendingWhere(ownerId === undefined ? undefined : eq(runs.ownerId, ownerId)))
    .orderBy(runs.endedAt, runs.id);
  return rows.map((row) => RunId.parse(row.id));
}

/** 触发消息按这个 Bot 的视角读：它这一轮就是被这条消息派起来的。 */
export async function pendingContinuation(db: Db, runId: RunId): Promise<PendingContinuation | null> {
  const [row] = await db
    .select()
    .from(runs)
    .where(pendingWhere(eq(runs.id, runId)));
  if (row === undefined) return null;
  const ownerId = UserId.parse(row.ownerId);
  const botId = BotId.parse(row.botId);
  const groupId = GroupId.parse(row.groupId);
  return {
    runId,
    ownerId,
    botId,
    groupId,
    trigger: await findOwnedMessage(db, ownerId, MessageId.parse(row.triggerMessageId), { kind: "bot", botId }),
    choice: await choiceOf(db, groupId, botId),
    routine: row.routineRunId === null ? null : await routineOf(db, row.routineRunId),
  };
}

function pendingWhere(filter: SQL | undefined): SQL | undefined {
  return and(
    eq(runs.continueRequested, true),
    isNotNull(runs.endedAt),
    isNotNull(runs.ownerId),
    isNotNull(runs.botId),
    isNotNull(runs.groupId),
    isNotNull(runs.triggerMessageId),
    filter,
  );
}

async function choiceOf(db: Db | Tx, groupId: GroupId, botId: BotId): Promise<ComputerKind | null> {
  const [member] = await db
    .select({ kind: groupMembers.computerKind })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.botId, botId)));
  return member?.kind ?? null;
}

/** 例行派起的 run 换电脑后，接续仍按那条例行的边界和用途跑，不然读写边界在换机那一刻就丢了。 */
async function routineOf(db: Db, routineRunId: string): Promise<PendingContinuation["routine"]> {
  const [row] = await db
    .select({ routineId: routines.id, boundary: routines.boundary, purpose: routines.purpose })
    .from(routineRuns)
    .innerJoin(routines, eq(routines.id, routineRuns.routineId))
    .where(eq(routineRuns.id, routineRunId));
  return row === undefined
    ? null
    : { routineId: RoutineId.parse(row.routineId), boundary: row.boundary, purpose: row.purpose };
}
