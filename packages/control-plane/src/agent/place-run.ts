import {
  BotId,
  ComputerId,
  GroupId,
  RunId,
  type ComputerKind,
  type ControlToAgent,
  type MessageId,
  type PokerTableRole,
  type UserId,
  type Viewer,
} from "@baize/shared";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { computers, groupMembers, laneLeases, runs, workStreams } from "../db/schema.js";
import { newId } from "../ids.js";
import { appendMessage, type Tx } from "../repo/messages.js";
import { lockOwner, lockSettlement, shareBotRunsLock } from "../repo/runs.js";
import { CHOSEN_OFFLINE, type ComputerSelection, type SelectionFailure } from "./computer-selection.js";
import { clearBotContinuations, takeContinuation } from "./continuation.js";
import { enqueueDownlink } from "./envelope.js";

type Prompt = Extract<ControlToAgent, { type: "prompt" }>;
export type PlaceRunInput = {
  readonly ownerId: UserId;
  readonly botId: BotId;
  readonly groupId: GroupId;
  readonly triggerMessageId?: MessageId;
  readonly routineRunId?: string | undefined;
  readonly table?: { readonly role: PokerTableRole; readonly visibleTo: readonly [Viewer, ...Viewer[]] };
  /** 换电脑后的接续接的是哪一轮。落行时认领那一轮的标记、沿用它的运行记录，认领不到就不建。 */
  readonly continuesRunId?: RunId;
  readonly prompt: (runId: RunId, messageId: MessageId, placed: Placement) => Promise<Omit<Prompt, "runId" | "lane">>;
};

/** run 实际落在哪台、锁里读到的选定。prompt 的电脑快照按它算，不按锁外挑电脑时的那次。 */
export type Placement = { readonly computerId: ComputerId; readonly preference: ComputerPreference };

export type PlaceRunResult =
  | {
      readonly kind: "queued";
      readonly runId: RunId;
      readonly messageId: MessageId;
      readonly computerId: ComputerId;
      readonly flushComputerIds: readonly ComputerId[];
    }
  | { readonly kind: "unplaced"; readonly reason: SelectionFailure }
  | { readonly kind: "not_member" }
  | { readonly kind: "continued" };

/** 这个 Bot 在这个群里选定的电脑。null 是没选过，走默认策略。 */
export type ComputerPreference = ComputerKind | null;

/** 派活前先挑一次电脑要用；落库那一次以 placeRun 在锁里读到的为准。 */
export async function computerPreference(db: Db | Tx, groupId: GroupId, botId: BotId): Promise<ComputerPreference> {
  const [member] = await db
    .select({ computerKind: groupMembers.computerKind })
    .from(groupMembers)
    .where(and(eq(groupMembers.botId, botId), eq(groupMembers.groupId, groupId)));
  return member?.computerKind ?? null;
}

/** 接管可能同时改两台电脑的发件箱，先锁齐再碰道，两个方向都按同一顺序。 */
export async function lockLaneComputers(tx: Tx, ownerId: UserId): Promise<void> {
  await lockOwner(tx, ownerId, "shared");
  await tx
    .select({ id: computers.id })
    .from(computers)
    .where(eq(computers.ownerId, ownerId))
    .orderBy(asc(computers.id))
    .for("no key update");
}

async function claimLane(tx: Tx, input: PlaceRunInput, computerId: ComputerId, installId: string) {
  const [lease] = await tx
    .insert(laneLeases)
    .values({
      botId: input.botId,
      groupId: input.groupId,
      holderComputerId: computerId,
      holderInstallId: installId,
      epoch: 1,
    })
    .onConflictDoUpdate({
      target: [laneLeases.botId, laneLeases.groupId],
      set: { updatedAt: sql`now()` },
      setWhere: sql`EXISTS (SELECT 1 FROM ${computers} WHERE ${computers.id} = ${computerId}
      AND ${computers.installId} = ${installId} AND ${computers.leaseUntil} > clock_timestamp())`,
    })
    .returning();
  return lease;
}

async function takeOverLane(tx: Tx, lease: typeof laneLeases.$inferSelect, computerId: ComputerId, installId: string) {
  const [taken] = await tx
    .update(laneLeases)
    .set({
      holderComputerId: computerId,
      holderInstallId: installId,
      epoch: sql`${laneLeases.epoch} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(eq(laneLeases.botId, lease.botId), eq(laneLeases.groupId, lease.groupId), eq(laneLeases.epoch, lease.epoch)),
    )
    .returning();
  if (taken === undefined) throw new Error("租约认领后代际改变");
  await enqueueDownlink(tx, ComputerId.parse(lease.holderComputerId), {
    type: "cancel",
    lane: { botId: BotId.parse(lease.botId), groupId: GroupId.parse(lease.groupId) },
    epoch: taken.epoch,
  });
  return taken;
}

/** run、道代际和 prompt 在调用方的同一个事务里提交。 */
export async function placeRun(
  tx: Tx,
  input: PlaceRunInput,
  select: (preference: ComputerPreference) => Promise<ComputerSelection>,
): Promise<PlaceRunResult> {
  await lockOwner(tx, input.ownerId, "shared");
  await shareBotRunsLock(tx, input.botId);
  await lockLaneComputers(tx, input.ownerId);
  const [member] = await tx
    .select({ computerKind: groupMembers.computerKind })
    .from(groupMembers)
    .where(and(eq(groupMembers.botId, input.botId), eq(groupMembers.groupId, input.groupId)));
  if (member === undefined) return { kind: "not_member" };
  const preference = member.computerKind ?? null;
  const selected = await select(preference);
  if (selected.kind === "failed") return { kind: "unplaced", reason: selected.reason };
  // 挑中之后、锁住之前租约过期了：选过电脑的照样说是那台不在线，不笼统说电脑不在线。
  const lapsed: SelectionFailure = preference === null ? "no_computer_online" : CHOSEN_OFFLINE[preference];
  const [candidate] = await tx
    .select()
    .from(computers)
    .where(
      and(
        eq(computers.id, selected.computer.id),
        eq(computers.ownerId, input.ownerId),
        sql`${computers.leaseUntil} > clock_timestamp()`,
      ),
    );
  if (candidate === undefined || candidate.installId === null) return { kind: "unplaced", reason: lapsed };
  let lease = await claimLane(tx, input, selected.computer.id, candidate.installId);
  if (lease === undefined) return { kind: "unplaced", reason: lapsed };
  const [holder] = await tx
    .select({ id: computers.id })
    .from(computers)
    .where(
      and(
        eq(computers.id, lease.holderComputerId),
        eq(computers.installId, lease.holderInstallId),
        sql`${computers.leaseUntil} > clock_timestamp()`,
      ),
    );
  const [busy] = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.botId, input.botId), eq(runs.groupId, input.groupId), isNull(runs.endedAt)))
    .limit(1);
  const flushComputerIds = [ComputerId.parse(lease.holderComputerId)];
  const sameHolder = lease.holderComputerId === candidate.id && lease.holderInstallId === candidate.installId;
  if (!sameHolder && (holder === undefined || busy === undefined)) {
    lease = await takeOverLane(tx, lease, selected.computer.id, candidate.installId);
  }
  const computerId = ComputerId.parse(lease.holderComputerId);
  await lockSettlement(tx, input.groupId, input.botId);
  const triggerMessageId =
    input.table === undefined
      ? input.triggerMessageId
      : (await appendMessage(tx, input.groupId, { kind: "system", text: "牌桌回合" }, [...input.table.visibleTo])).id;
  if (triggerMessageId === undefined) throw new Error("派活缺少触发消息");
  const runId = await startRun(tx, input, computerId, triggerMessageId);
  if (runId === null) return { kind: "continued" };
  const heads: Prompt["lane"]["heads"] = {};
  for (const stream of await tx
    .select()
    .from(workStreams)
    .where(and(eq(workStreams.botId, input.botId), eq(workStreams.groupId, input.groupId)))) {
    heads[stream.stream] = { seq: stream.nextSeq, head: stream.head };
  }
  const body = await input.prompt(runId, triggerMessageId, { computerId, preference });
  if (!(await enqueueDownlink(tx, computerId, { ...body, runId, lane: { epoch: lease.epoch, heads } }, runId)))
    return tx.rollback();
  return {
    kind: "queued",
    runId,
    messageId: triggerMessageId,
    computerId,
    flushComputerIds: [...new Set([...flushComputerIds, computerId])],
  };
}

async function startRun(
  tx: Tx,
  input: PlaceRunInput,
  computerId: ComputerId,
  triggerMessageId: MessageId,
): Promise<RunId | null> {
  const continued = input.continuesRunId === undefined ? null : await takeContinuation(tx, input.continuesRunId);
  if (input.continuesRunId !== undefined && continued === null) return null;
  const [row] = await tx
    .insert(runs)
    .values({
      id: newId(),
      ownerId: input.ownerId,
      computerId,
      botId: input.botId,
      groupId: input.groupId,
      triggerMessageId,
      // 接续只认父链：父链没挂例行就是 null，不回退到这一回合的例行记录。
      routineRunId: continued === null ? (input.routineRunId ?? null) : continued.routineRunId,
      isRoutine: continued === null ? input.routineRunId !== undefined : continued.isRoutine,
      startedAt: new Date(),
      visibleTo: input.table === undefined ? null : [...input.table.visibleTo],
      tableRole: input.table?.role ?? null,
      continuesRunId: input.continuesRunId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: runs.id });
  if (row === undefined) return tx.rollback();
  return RunId.parse(row.id);
}

/** 调用方持有 Bot 排他锁，没有租约时无需碰电脑，避免挡住同账号其他 Bot 的上行。 */
export async function cancelLanes(tx: Tx, ownerId: UserId, botId: BotId): Promise<ComputerId[]> {
  const [ownedLane] = await tx
    .select({ botId: laneLeases.botId })
    .from(laneLeases)
    .where(eq(laneLeases.botId, botId))
    .limit(1);
  if (ownedLane === undefined) return [];
  await lockLaneComputers(tx, ownerId);
  const leases = await tx
    .select()
    .from(laneLeases)
    .where(eq(laneLeases.botId, botId))
    .orderBy(asc(laneLeases.groupId))
    .for("update");
  for (const lease of leases)
    await enqueueDownlink(tx, ComputerId.parse(lease.holderComputerId), {
      type: "cancel",
      lane: { botId, groupId: GroupId.parse(lease.groupId) },
      epoch: lease.epoch + 1,
    });
  await clearBotContinuations(tx, botId);
  return [...new Set(leases.map((lease) => ComputerId.parse(lease.holderComputerId)))];
}
