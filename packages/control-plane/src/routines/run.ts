import { BotId, RoutineId, type Routine, type RunId, type UserId } from "@baize/shared";
import type { Db } from "../db/client.js";
import type { NoticePublisher } from "../notifications.js";
import type { AgentHub } from "../agent/hub.js";
import { dispatchUserMessage, type DispatchOutcome } from "../agent/dispatch.js";
import { SELECTION_FAILURE } from "../agent/computer-selection.js";
import type { GroupTurns } from "../agent/group-turn.js";
import { appendMessage, type Tx } from "../repo/messages.js";
import { isOverBudget } from "../repo/usage.js";
import {
  autoPauseIfUnseen,
  chargeRoutineRun,
  failRoutineRun,
  loadRoutine,
  noteRoutineRun,
  OVER_BUDGET_NOTE,
  openRoutineRun,
  recordStoppedRoutineRun,
  routineRunOfRun,
  settleRoutineRun,
  trimRoutineRuns,
  type RoutineRow,
  type RoutineRunRef,
  type RunOrigin,
} from "../repo/routines.js";
import type { PushHub } from "../ws/hub.js";

export type RoutineDeps = {
  readonly db: Db;
  readonly push: PushHub;
  readonly agents: AgentHub;
  readonly groupTurns: GroupTurns;
  readonly notifications: NoticePublisher;
};

/**
 * 派活那一步就没成，群里已经有一句为什么，运行记录不该停在「运行中」。
 * 选不到电脑的原因和群里那句同源，运行记录只留原因，不补跑。
 */
function notDispatchedNote(outcome: Exclude<DispatchOutcome, { kind: "sent" }>): string {
  switch (outcome.kind) {
    case "unplaced":
      return `${SELECTION_FAILURE[outcome.reason].why}，没跑起来`;
    case "no_target":
      return "群里没有能派的 Bot，没跑起来";
    case "failed":
      return DISPATCH_FAILED_NOTE;
  }
}
export const WAITING_APPROVAL_NOTE = "1 条等你点头";
export const RETRY_NEXT_TIME_NOTE = "等你点头，下次照常跑";
export const EXPIRED_APPROVAL_NOTE = "审批已失效";
export const DISPATCH_FAILED_NOTE = "派活出错，没跑起来";

/**
 * 跑一次例行任务。到点触发、webhook、试跑走的都是这一条路。
 *
 * 一次运行等同于归属人发了一条消息：带群号的发进那个群（项目的例行），不带的发进这个 Bot 的单 Bot 群。
 * 先落一条 system 说是例行任务自动跑的，再落一条正文是 `instruction` 的 user 消息，
 * 然后走现有的 `dispatchUserMessage`，只派给例行所属的 Bot：项目群换了首席，主助理的周一计划也还是主助理排。
 * 运行器和电脑代理因此不用认识例行任务，没有新报文。
 *
 * 运行记录和两条消息在一个事务里落，事务开头 openRoutineRun 锁住执行者并重读：调用方手里的 `row` 是扫到时的样子，
 * 派发按重读到的执行者和群，自动触发还按重读到的状态决定跑不跑。记录落了之后派发抛错也要收尾，不能留 running，
 * 收尾和别的收尾一样要过三次没人看的判断、推一次快照，再把错往外抛。
 * 回 null 是例行没了，或者自动触发撞上它刚停下。
 */
export async function runRoutine(
  deps: RoutineDeps,
  ownerId: UserId,
  row: RoutineRow,
  at: Date,
  origin: RunOrigin,
): Promise<Routine | null> {
  // D13：超预算只停自动触发（到点和 webhook），试跑是用户当面点的，照跑。记一条 stopped 让他看得到为什么没跑，
  // 不改例行状态，这条也不算进三次没人看（autoPauseIfUnseen 按 note 排除）：下个月或者调高预算后它接着按点跑。
  if (origin !== "trial" && (await isOverBudget(deps.db, ownerId, at))) {
    await recordStoppedRoutineRun(deps.db, row.id, at, OVER_BUDGET_NOTE);
    await trimRoutineRuns(deps.db, row.id);
    const loaded = await loadRoutine(deps.db, RoutineId.parse(row.id));
    if (loaded === null) return null;
    deps.push.push(loaded.ownerId, { type: "routine_updated", routine: loaded.routine });
    return loaded.routine;
  }
  const opened = await deps.db.transaction(async (tx) => {
    const run = await openRoutineRun(tx, row.id, at, origin);
    if (run === null) return null;
    const notice = await appendMessage(tx, run.groupId, {
      kind: "system",
      text: `例行任务「${run.row.name}」自动运行`,
    });
    const instruction = await appendMessage(tx, run.groupId, { kind: "user", text: run.row.instruction });
    return { ...run, notice, instruction };
  });
  if (opened === null) return null;
  const { groupId, row: current } = opened;
  deps.push.push(ownerId, { type: "message", message: opened.notice });
  deps.push.push(ownerId, { type: "message", message: opened.instruction });

  const outcome = await dispatchUserMessage(deps, ownerId, groupId, opened.instruction, {
    routineRunId: opened.id,
    purpose: current.purpose,
    botId: BotId.parse(current.botId),
    routine: { routineId: RoutineId.parse(row.id), boundary: current.boundary },
  }).catch(async (error: unknown) => {
    await settleRoutineRun(deps.db, opened.id, "failed", DISPATCH_FAILED_NOTE);
    await pushRoutineUpdated(deps, row.id);
    throw error;
  });
  if (outcome.kind !== "sent") {
    await settleRoutineRun(deps.db, opened.id, "failed", notDispatchedNote(outcome));
    await autoPauseIfUnseen(deps.db, row.id);
  }
  // 用户自己发的消息派不出去，群里那句 system 他当场看得到；例行任务没人在看，才要找他。
  if (outcome.kind === "unplaced") {
    await deps.notifications.publish(ownerId, {
      kind: "stuck",
      text: `例行任务「${current.name}」没跑：${SELECTION_FAILURE[outcome.reason].why}`,
      groupId,
    });
  }

  // 活已经派出去了，裁剪失败往外抛的话试跑和 webhook 回 500，平台一重试就重复派活。只是多留几条，下次裁剪收回。
  await trimRoutineRuns(deps.db, row.id).catch((error: unknown) => {
    console.error(`例行任务 ${row.id} 裁剪运行记录出错`, error);
  });
  const loaded = await loadRoutine(deps.db, RoutineId.parse(row.id));
  if (loaded === null) return null;
  deps.push.push(loaded.ownerId, { type: "routine_updated", routine: loaded.routine });
  return loaded.routine;
}

/**
 * 活跑完了。还在跑的记成 ok，已经停下等点头的保持 stopped，两种都在 note 后面缀上这次花费。
 * 回 null 说明这个 run 不是例行任务派的。
 * 在 run_done 的结账事务里记：note 是往后缀的，自身不幂等，只记一次靠这个事务的 claimCharge。
 * 推送留给调用方在提交之后做（pushRoutineUpdated），事务回滚了页面不能先看到「ok · ¥0.60」。
 */
export async function chargeRoutineRunIn(tx: Tx, runId: RunId, amount: number): Promise<RoutineRunRef | null> {
  const ref = await routineRunOfRun(tx, runId);
  if (ref === null) return null;
  await chargeRoutineRun(tx, ref.routineRunId, `¥${amount.toFixed(2)}`);
  return ref;
}

export async function pushRoutineUpdated(deps: RoutineDeps, routineId: string): Promise<void> {
  await pushIfChanged(deps, routineId);
}

export async function failRoutineRunOf(deps: RoutineDeps, runId: RunId, reason: string): Promise<RoutineRunRef | null> {
  const ref = await routineRunOfRun(deps.db, runId);
  if (ref === null) return null;
  await pushIfChanged(deps, await failRoutineRun(deps.db, ref.routineRunId, reason));
  return ref;
}

/**
 * 运行途中出现审批。`stop_and_tell` 就地停下，用户在运行记录里看得到是卡在点头上；
 * `retry_next_time` 只补一句话，活照旧挂着等点头，下一个时刻照常再跑一次。
 */
export async function holdRoutineRunOf(deps: RoutineDeps, runId: RunId): Promise<void> {
  const ref = await routineRunOfRun(deps.db, runId);
  if (ref === null) return;
  const changed =
    ref.onFailure === "stop_and_tell"
      ? await settleRoutineRun(deps.db, ref.routineRunId, "stopped", WAITING_APPROVAL_NOTE)
      : await noteRoutineRun(deps.db, ref.routineRunId, RETRY_NEXT_TIME_NOTE);
  await pushIfChanged(deps, changed);
}

/**
 * 每次状态或 note 变了就把整条例行任务推一遍，客户端整条替换。没改动就不推。
 * 运行记录变了就可能刚好凑满三次没人看，自己停下的那一下和这次收尾合成一次推送。
 */
async function pushIfChanged(deps: RoutineDeps, routineId: string | null): Promise<void> {
  if (routineId === null) return;
  await autoPauseIfUnseen(deps.db, routineId);
  const loaded = await loadRoutine(deps.db, RoutineId.parse(routineId));
  if (loaded === null) return;
  deps.push.push(loaded.ownerId, { type: "routine_updated", routine: loaded.routine });
}
