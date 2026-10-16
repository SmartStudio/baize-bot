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
  type ModelPurpose,
  type RoutineBoundary,
  type ServerPush,
  type SwitchComputerResponse,
} from "@baize/shared";
import { and, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { computers, groupMembers, routineRuns, routines, runs } from "../db/schema.js";
import { findOwnedMessage, type Tx } from "../repo/messages.js";
import { chooseComputer } from "./computer-choice.js";
import type { ComputerAvailability } from "./computer-availability.js";
import type { ContinuationSpeaker } from "./group-turn.js";

export type SwitchOutcome = SwitchComputerResponse;

type SwitchRefusal = Extract<SwitchOutcome, { result: "refused" }>["reason"];

const COMPUTER_NAME: Record<ComputerKind, string> = { remote: "云电脑", local: "主人的电脑" };

/** 拒绝的文案原样给模型当工具错误，所以按目标那台说。 */
export const SWITCH_REFUSED: Record<SwitchRefusal, (kind: ComputerKind) => string> = {
  not_current_run: () => "这一轮已经结束，换不了电脑。",
  already_continued: () => "这一轮已经换过一次电脑，不能再换，请在当前这台上做完或告诉主人。",
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
 * 模型重试同一次请求时标记已经立着，UPDATE 不到行也仍回 switching，接续只起一条由 runs_continues_run_idx 保证。
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

/** 用户插话、删 Bot 发 cancel 时清掉：之后收尾不再起接续，hello 的补扫也不会。 */
export async function clearContinuation(db: Db | Tx, runId: RunId): Promise<void> {
  await db
    .update(runs)
    .set({ continueRequested: false })
    .where(and(eq(runs.id, runId), eq(runs.continueRequested, true)));
}

/** 删 Bot 取消它所有的道时一起清，和 cancel 同一个事务。 */
export async function clearBotContinuations(tx: Tx, botId: BotId): Promise<void> {
  await tx
    .update(runs)
    .set({ continueRequested: false })
    .where(and(eq(runs.botId, botId), eq(runs.continueRequested, true)));
}

/** 这个群里所有还没起接续的换电脑标记。用户在群里又说了话，之前那段活不再自动接着做。 */
export async function clearGroupContinuations(db: Db | Tx, groupId: GroupId): Promise<void> {
  await db
    .update(runs)
    .set({ continueRequested: false })
    .where(and(eq(runs.groupId, groupId), eq(runs.continueRequested, true)));
}

export type PendingContinuation = {
  readonly runId: RunId;
  readonly ownerId: UserId;
  readonly botId: BotId;
  readonly groupId: GroupId;
  readonly trigger: Message;
  readonly choice: ComputerKind | null;
  readonly routine: {
    readonly routineId: RoutineId;
    readonly boundary: RoutineBoundary;
    readonly purpose: ModelPurpose;
  } | null;
};

/** 旧 run 请求过换电脑、已经结束、还没有接续时，接续这一位要说的话。选择又被清掉了就不起。 */
export function continuationSpeaker(pending: PendingContinuation): ContinuationSpeaker | null {
  if (pending.choice === null) return null;
  return {
    botId: pending.botId,
    trigger: pending.trigger,
    reason: "continuation",
    continuation: { fromRunId: pending.runId, text: continuationText(pending.choice) },
  };
}

const notContinued = sql`NOT EXISTS (SELECT 1 FROM ${runs} AS later WHERE later.continues_run_id = ${runs.id})`;

/**
 * 还欠着接续的 run：立过标记、已经结束、没有哪条 run 接着它。
 * 触发消息按这个 Bot 的视角读：它这一轮就是被这条消息派起来的，看得见；看不见的（不该有）跳过。
 */
export async function pendingContinuations(db: Db, ownerId?: UserId): Promise<readonly PendingContinuation[]> {
  return loadPending(db, ownerId === undefined ? undefined : eq(runs.ownerId, ownerId));
}

export async function pendingContinuation(db: Db, runId: RunId): Promise<PendingContinuation | null> {
  const [found] = await loadPending(db, eq(runs.id, runId));
  return found ?? null;
}

async function loadPending(db: Db, filter: SQL | undefined): Promise<PendingContinuation[]> {
  const rows = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.continueRequested, true),
        isNotNull(runs.endedAt),
        isNotNull(runs.ownerId),
        isNotNull(runs.botId),
        isNotNull(runs.groupId),
        isNotNull(runs.triggerMessageId),
        notContinued,
        filter,
      ),
    )
    .orderBy(runs.endedAt, runs.id);
  const result: PendingContinuation[] = [];
  for (const row of rows) {
    const ownerId = UserId.parse(row.ownerId);
    const botId = BotId.parse(row.botId);
    const groupId = GroupId.parse(row.groupId);
    const trigger = await findOwnedMessage(db, ownerId, MessageId.parse(row.triggerMessageId), { kind: "bot", botId });
    if (trigger === null) continue;
    result.push({
      runId: RunId.parse(row.id),
      ownerId,
      botId,
      groupId,
      trigger,
      choice: await choiceOf(db, groupId, botId),
      routine: row.isRoutine ? await routineOf(db, row.id) : null,
    });
  }
  return result;
}

async function choiceOf(db: Db | Tx, groupId: GroupId, botId: BotId): Promise<ComputerKind | null> {
  const [member] = await db
    .select({ kind: groupMembers.computerKind })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.botId, botId)));
  return member?.kind ?? null;
}

/** 例行派起的 run 换电脑后，接续仍按那条例行的边界和用途跑，不然读写边界在换机那一刻就丢了。 */
async function routineOf(db: Db | Tx, runId: string): Promise<PendingContinuation["routine"]> {
  const [row] = await db
    .select({ routineId: routines.id, boundary: routines.boundary, purpose: routines.purpose })
    .from(runs)
    .innerJoin(routineRuns, eq(routineRuns.id, runs.routineRunId))
    .innerJoin(routines, eq(routines.id, routineRuns.routineId))
    .where(eq(runs.id, runId))
    .limit(1);
  return row === undefined
    ? null
    : { routineId: RoutineId.parse(row.routineId), boundary: row.boundary, purpose: row.purpose };
}
