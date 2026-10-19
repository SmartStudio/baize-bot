import { BotId, type Approval, type ComputerId, type GroupId, RunId, type UserId } from "@baize/shared";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { cancelGroupLanes, lockLaneComputers } from "../agent/place-run.js";
import type { Db } from "../db/client.js";
import {
  agentOutbox,
  approvals,
  groupMembers,
  groups,
  pokerHands,
  pokerSessions,
  pokerTables,
  runs,
  tasks,
} from "../db/schema.js";
import { lockTableKey } from "../poker/store.js";
import type { Tx } from "./messages.js";
import { pauseGroupRoutines, settleRoutineRun } from "./routines.js";
import { toApproval } from "./rows.js";
import { exclusiveBotRunsLock, lockOwner, lockSettlement } from "./runs.js";

export const GROUP_ARCHIVED_NOTE = "群已解散，这次没跑完";

export type ArchiveGroupResult =
  | {
      readonly kind: "archived";
      readonly cancelComputers: readonly ComputerId[];
      readonly endedRunIds: readonly RunId[];
      readonly expired: readonly Approval[];
      readonly routineIds: readonly string[];
    }
  | { readonly kind: "already_archived" }
  | { readonly kind: "solo" }
  | { readonly kind: "not_found" };

/**
 * 解散多 Bot 群：只给群盖 archived_at，消息、任务卡、牌局都留着，对外经 groupIsLive 一律当它不存在。
 * 同一个事务里把还在动的东西都停下：没结束的 run 收成没有账的结束并取消它们的道，挂着的审批收成 expired，
 * 换电脑的接续标记清掉，例行停下，任务卡收成 done；牌桌打着的那手作废、开着的那场散掉，不派复盘，群里不落任何话。
 * 交接卡不动：HandoffStatus 没有取消态，确认交接要靠群里一条活着的 run，run 都收了就没人能再确认它。
 * 锁序照删 Bot：归属人共享 → 成员 Bot 排他（按 id 升序）→ 电脑 → 桌锁 → 道 → 收尾锁 → run → 例行 → 任务卡 → 群行。
 * 成员 Bot 的排他锁让 placeRun 等到提交之后，那时它读到群已解散就不建 run。
 */
export async function archiveGroup(db: Db, ownerId: UserId, groupId: GroupId): Promise<ArchiveGroupResult> {
  return db.transaction(async (tx): Promise<ArchiveGroupResult> => {
    await lockOwner(tx, ownerId, "shared");
    const [group] = await tx
      .select({ soloBotId: groups.soloBotId, archivedAt: groups.archivedAt })
      .from(groups)
      .where(and(eq(groups.id, groupId), eq(groups.ownerId, ownerId)));
    if (group === undefined) return { kind: "not_found" };
    // 单聊（主助理的也是单聊）随 Bot 走，要删就删 Bot。
    if (group.soloBotId !== null) return { kind: "solo" };
    if (group.archivedAt !== null) return { kind: "already_archived" };
    const members = await tx
      .select({ botId: groupMembers.botId })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, groupId))
      .orderBy(asc(groupMembers.botId));
    if (members.length === 0) return { kind: "not_found" };
    const botIds = members.map((member) => BotId.parse(member.botId));
    for (const botId of botIds) await exclusiveBotRunsLock(tx, botId);
    await lockLaneComputers(tx, ownerId);
    await archiveTable(tx, groupId);
    const cancelComputers = await cancelGroupLanes(tx, groupId);
    for (const botId of botIds) await lockSettlement(tx, groupId, botId);
    const runIds = await endOpenRuns(tx, groupId);
    const routineIds = [...runIds.routineIds];
    const expired = await tx
      .update(approvals)
      .set({ status: "expired" })
      .where(and(eq(approvals.groupId, groupId), eq(approvals.status, "pending")))
      .returning();
    const thisGroup = tx.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId));
    routineIds.push(...(await pauseGroupRoutines(tx, thisGroup)));
    await tx.update(tasks).set({ status: "done" }).where(eq(tasks.groupId, groupId));
    await tx
      .update(groups)
      .set({ archivedAt: sql`now()` })
      .where(and(eq(groups.id, groupId), isNull(groups.archivedAt)));
    return {
      kind: "archived",
      cancelComputers,
      endedRunIds: runIds.ended,
      expired: expired.map(toApproval),
      routineIds: [...new Set(routineIds)],
    };
  });
}

/** 群里还没结束的 run 收成没有账的结束，还没送出去的 prompt 从发件箱撤掉；挂着的例行运行记录收成 stopped。 */
async function endOpenRuns(
  tx: Tx,
  groupId: GroupId,
): Promise<{ readonly ended: RunId[]; readonly routineIds: string[] }> {
  await tx
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.groupId, groupId), isNull(runs.chargedAt)))
    .orderBy(asc(runs.id))
    .for("update");
  await tx
    .update(runs)
    .set({ continueRequested: false })
    .where(and(eq(runs.groupId, groupId), eq(runs.continueRequested, true)));
  const now = new Date();
  const ended = await tx
    .update(runs)
    .set({ endedAt: now, chargedAt: now })
    .where(and(eq(runs.groupId, groupId), isNull(runs.endedAt)))
    .returning({ id: runs.id, routineRunId: runs.routineRunId });
  if (ended.length === 0) return { ended: [], routineIds: [] };
  await tx.delete(agentOutbox).where(
    inArray(
      agentOutbox.runId,
      ended.map((run) => run.id),
    ),
  );
  const routineIds: string[] = [];
  for (const { routineRunId } of ended) {
    if (routineRunId === null) continue;
    const routineId = await settleRoutineRun(tx, routineRunId, "stopped", GROUP_ARCHIVED_NOTE);
    if (routineId !== null) routineIds.push(routineId);
  }
  return { ended: ended.map((run) => RunId.parse(run.id)), routineIds };
}

/**
 * 牌桌群：拿和 withTableLock 同一把桌锁，打着的手收成 abandoned、筹码退回开手时，开着的那场盖上 ended_at。
 * 不是牌桌什么都不做。之后 loadTable 认不出解散的群，扫描器和推进都碰不到它。
 */
async function archiveTable(tx: Tx, groupId: GroupId): Promise<void> {
  await lockTableKey(tx, groupId);
  const [table] = await tx.select().from(pokerTables).where(eq(pokerTables.groupId, groupId)).for("update");
  if (table === undefined) return;
  const now = new Date();
  const [hand] = await tx
    .update(pokerHands)
    .set({
      status: "abandoned",
      completedAt: now,
      turnSeat: null,
      turnRunId: null,
      turnAttempts: 0,
      turnDeadline: null,
      version: sql`${pokerHands.version} + 1`,
    })
    .where(and(eq(pokerHands.groupId, groupId), eq(pokerHands.status, "playing")))
    .returning({ seatsStart: pokerHands.seatsStart });
  await tx
    .update(pokerTables)
    .set({
      status: "idle",
      ...(hand === undefined ? {} : { seats: hand.seatsStart }),
      version: sql`${pokerTables.version} + 1`,
    })
    .where(eq(pokerTables.groupId, groupId));
  await tx
    .update(pokerSessions)
    .set({ endedAt: now })
    .where(and(eq(pokerSessions.groupId, groupId), isNull(pokerSessions.endedAt)));
}
