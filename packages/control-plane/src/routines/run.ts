import { BotId, GroupId, RoutineId, type Routine, type RunId, type UserId } from "@baize/shared";
import type { Db } from "../db/client.js";
import type { NoticePublisher } from "../notifications.js";
import type { AgentHub } from "../agent/hub.js";
import { dispatchUserMessage, type DispatchOutcome } from "../agent/dispatch.js";
import { SELECTION_FAILURE } from "../agent/computer-selection.js";
import type { GroupTurns } from "../agent/group-turn.js";
import { findSoloGroup } from "../repo/groups.js";
import { appendMessage } from "../repo/messages.js";
import {
  chargeRoutineRun,
  failRoutineRun,
  loadRoutine,
  noteRoutineRun,
  routineRunOfRun,
  settleRoutineRun,
  startRoutineRun,
  type RoutineRow,
  type RoutineRunRef,
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
  return outcome.kind === "unplaced"
    ? `${SELECTION_FAILURE[outcome.reason].why}，没跑起来`
    : "群里没有能派的 Bot，没跑起来";
}
export const WAITING_APPROVAL_NOTE = "1 条等你点头";
export const RETRY_NEXT_TIME_NOTE = "等你点头，下次照常跑";
export const EXPIRED_APPROVAL_NOTE = "审批已失效";

/**
 * 跑一次例行任务。到点触发、webhook、试跑走的都是这一条路。
 *
 * 一次运行等同于归属人发了一条消息：带群号的发进那个群（项目的例行），不带的发进这个 Bot 的单 Bot 群。
 * 先落一条 system 说是例行任务自动跑的，再落一条正文是 `instruction` 的 user 消息，
 * 然后走现有的 `dispatchUserMessage`，只派给例行所属的 Bot：项目群换了首席，主助理的周一计划也还是主助理排。
 * 运行器和电脑代理因此不用认识例行任务，没有新报文。
 */
export async function runRoutine(
  deps: RoutineDeps,
  ownerId: UserId,
  row: RoutineRow,
  at: Date,
): Promise<Routine | null> {
  const botId = BotId.parse(row.botId);
  const groupId = row.groupId === null ? await findSoloGroup(deps.db, botId) : GroupId.parse(row.groupId);
  if (groupId === null) return null;

  const started = await startRoutineRun(deps.db, row.id, at);

  const notice = await appendMessage(deps.db, groupId, {
    kind: "system",
    text: `例行任务「${row.name}」自动运行`,
  });
  deps.push.push(ownerId, { type: "message", message: notice });

  const instruction = await appendMessage(deps.db, groupId, { kind: "user", text: row.instruction });
  deps.push.push(ownerId, { type: "message", message: instruction });

  const outcome = await dispatchUserMessage(deps, ownerId, groupId, instruction, {
    routineRunId: started.id,
    purpose: row.purpose,
    botId,
  });
  if (outcome.kind !== "sent") {
    await settleRoutineRun(deps.db, started.id, "failed", notDispatchedNote(outcome));
  }
  // 用户自己发的消息派不出去，群里那句 system 他当场看得到；例行任务没人在看，才要找他。
  if (outcome.kind === "unplaced") {
    await deps.notifications.publish(ownerId, {
      kind: "stuck",
      text: `例行任务「${row.name}」没跑：${SELECTION_FAILURE[outcome.reason].why}`,
      groupId,
    });
  }

  const loaded = await loadRoutine(deps.db, RoutineId.parse(row.id));
  if (loaded === null) return null;
  deps.push.push(loaded.ownerId, { type: "routine_updated", routine: loaded.routine });
  return loaded.routine;
}

/**
 * 活跑完了。还在跑的记成 ok，已经停下等点头的保持 stopped，两种都在 note 后面缀上这次花费。
 * 回 null 说明这个 run 不是例行任务派的。
 */
export async function chargeRoutineRunOf(
  deps: RoutineDeps,
  runId: RunId,
  amount: number,
): Promise<RoutineRunRef | null> {
  const ref = await routineRunOfRun(deps.db, runId);
  if (ref === null) return null;
  await pushIfChanged(deps, await chargeRoutineRun(deps.db, ref.routineRunId, `¥${amount.toFixed(2)}`));
  return ref;
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

/** 每次状态或 note 变了就把整条例行任务推一遍，客户端整条替换。没改动就不推。 */
async function pushIfChanged(deps: RoutineDeps, routineId: string | null): Promise<void> {
  if (routineId === null) return;
  const loaded = await loadRoutine(deps.db, RoutineId.parse(routineId));
  if (loaded === null) return;
  deps.push.push(loaded.ownerId, { type: "routine_updated", routine: loaded.routine });
}
