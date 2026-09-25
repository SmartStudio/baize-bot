import {
  ApprovalId,
  BotId,
  GroupId,
  RunId,
  toolViewText,
  UserId,
  type Approval,
  type Message,
  type ToolView,
} from "@baize/shared";
import { TransactionRollbackError, and, count, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { approvals, groups, messages } from "../db/schema.js";
import { newId } from "../ids.js";
import { appendMessage, type Tx } from "./messages.js";
import { appendReminders } from "./reminders.js";
import { toApproval } from "./rows.js";
import type { PushHub } from "../ws/hub.js";

// shared 只导出了 ApprovalKind 和 ApprovalStatus 的 schema，没有导出类型，从列上取回来。
type ApprovalRow = typeof approvals.$inferSelect;
type ApprovalKind = ApprovalRow["kind"];
type Decision = Exclude<ApprovalRow["status"], "pending">;

/** 过了这么久还没有结论就提醒一次。规格里的「24 小时后追加一条 system 提醒」。 */
export const STALE_APPROVAL_MS = 24 * 60 * 60 * 1000;

export type CreateApprovalInput = {
  readonly runId: RunId;
  readonly botId: BotId;
  readonly groupId: string;
  readonly callId: string;
  readonly tool: string;
  readonly kind: ApprovalKind;
  readonly view: ToolView;
};

export type CreatedApproval = { readonly approval: Approval; readonly message: Message };

export type ApprovalRun = { readonly botId: BotId; readonly groupId: GroupId };

/**
 * 建一条待批审批和群里那张卡。两者在一个事务里生，所以群里不会出现没有审批的孤儿卡。
 * 电脑重发同一条 approval_request 时唯一索引拦下，整条事务回滚，返回 null。
 */
export async function createApproval(db: Db, input: CreateApprovalInput): Promise<CreatedApproval | null> {
  const approvalId = ApprovalId.parse(newId());
  try {
    return await db.transaction(async (tx): Promise<CreatedApproval> => {
      // 卡先落地，approvals.message_id 是非空外键。
      const message = await appendMessage(tx, input.groupId, { kind: "approval", approvalId });

      const [row] = await tx
        .insert(approvals)
        .values({
          id: approvalId,
          runId: input.runId,
          botId: input.botId,
          groupId: input.groupId,
          callId: input.callId,
          tool: input.tool,
          kind: input.kind,
          view: input.view,
          messageId: message.id,
        })
        .onConflictDoNothing({ target: [approvals.runId, approvals.callId] })
        .returning();
      if (row === undefined) return tx.rollback();
      return { approval: toApproval(row), message };
    });
  } catch (error) {
    if (error instanceof TransactionRollbackError) return null;
    throw error;
  }
}

/** approval_abandoned 没带 Bot 和群，先从它指名的审批还原，随后交给上行报文的统一 run 归属校验。 */
export async function approvalRun(db: Db, runId: RunId, callId: string): Promise<ApprovalRun | null> {
  const [row] = await db
    .select({ botId: approvals.botId, groupId: approvals.groupId })
    .from(approvals)
    .where(and(eq(approvals.runId, runId), eq(approvals.callId, callId)))
    .limit(1);
  if (row === undefined) return null;
  return { botId: BotId.parse(row.botId), groupId: GroupId.parse(row.groupId) };
}

/** 只让还在等点头的那一行失效，重复报文或已有结论都返回 null。 */
export async function expireApproval(db: Db, runId: RunId, callId: string): Promise<Approval | null> {
  const [row] = await db
    .update(approvals)
    .set({ status: "expired" })
    .where(and(eq(approvals.runId, runId), eq(approvals.callId, callId), eq(approvals.status, "pending")))
    .returning();
  return row === undefined ? null : toApproval(row);
}

/** hub 收尾 run 时把它上面所有还在等的审批一起失效。 */
export async function expireApprovalsOfRun(db: Db | Tx, runId: RunId): Promise<Approval[]> {
  const rows = await db
    .update(approvals)
    .set({ status: "expired" })
    .where(and(eq(approvals.runId, runId), eq(approvals.status, "pending")))
    .returning();
  return rows.map(toApproval);
}

/** 审批按归属人过滤。别人的审批在这里查不到，路由层因此返回 404 而不是 403。 */
export async function findApprovalId(db: Db, ownerId: UserId, approvalId: ApprovalId): Promise<ApprovalId | null> {
  const [row] = await db
    .select({ id: approvals.id })
    .from(approvals)
    .innerJoin(groups, eq(groups.id, approvals.groupId))
    .where(and(eq(approvals.id, approvalId), eq(groups.ownerId, ownerId)))
    .limit(1);
  return row === undefined ? null : approvalId;
}

/** 群里最近一条还没有结论的审批。群里回「批准」这类词落到它身上。 */
export async function latestPendingApproval(db: Db, groupId: string): Promise<ApprovalId | null> {
  const [row] = await db
    .select({ id: approvals.id, seq: messages.seq })
    .from(approvals)
    .innerJoin(messages, eq(messages.id, approvals.messageId))
    .where(and(eq(approvals.groupId, groupId), eq(approvals.status, "pending")))
    // 按卡的 seq 排，不按 created_at：后者是事务开始时刻，两条事务交错时和用户在群里看到的顺序会反过来。
    .orderBy(desc(messages.seq))
    .limit(1);
  return row === undefined ? null : ApprovalId.parse(row.id);
}

/** 定完结论要往电脑发 approval_result。runId 和 callId 只在这条路上用，不进 Approval。 */
export type DecidedApproval = {
  readonly approval: Approval;
  readonly runId: RunId;
  readonly callId: string;
};

/**
 * 只给还没有结论的那一行定结论。重复的决定返回 null，
 * 幂等靠这条 UPDATE 的 WHERE 本身，不靠先查后写。
 */
export async function decideApproval(
  db: Db,
  approvalId: ApprovalId,
  decision: Decision,
): Promise<DecidedApproval | null> {
  const [row] = await db
    .update(approvals)
    .set({ status: decision, decidedAt: new Date() })
    .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
    .returning();
  if (row === undefined) return null;
  return { approval: toApproval(row), runId: RunId.parse(row.runId), callId: row.callId };
}

/** 一页消息引用到的审批。客户端画卡要的状态跟着这一页一起回，不用再发一次请求。 */
export async function listApprovals(db: Db, approvalIds: readonly ApprovalId[]): Promise<Approval[]> {
  if (approvalIds.length === 0) return [];
  const rows = await db
    .select()
    .from(approvals)
    .where(inArray(approvals.id, [...approvalIds]));
  return rows.map(toApproval);
}

/** 每个群还有几条等人点头。侧栏角标用，一次查询查完所有群。 */
export async function pendingApprovalCounts(db: Db, groupIds: readonly string[]): Promise<Map<string, number>> {
  if (groupIds.length === 0) return new Map();
  const rows = await db
    .select({ groupId: approvals.groupId, pending: count() })
    .from(approvals)
    .where(and(inArray(approvals.groupId, [...groupIds]), eq(approvals.status, "pending")))
    .groupBy(approvals.groupId);
  return new Map(rows.map((row) => [row.groupId, row.pending]));
}

/**
 * 放了一天还没有结论的审批各补一条提醒。不升级也不自动拒绝，等的人还是归属人。
 * 先把 reminded_at 占住再补消息，所以扫第二遍不会重复提醒，进程重启也不会。
 * 时钟是参数，测试直接传一个 25 小时后的 now。
 */
export async function remindStaleApprovals(db: Db, push: PushHub, now: Date): Promise<number> {
  return appendReminders(db, push, async (tx) => {
    const stale = await tx
      .update(approvals)
      .set({ remindedAt: now })
      .where(
        and(
          eq(approvals.status, "pending"),
          isNull(approvals.remindedAt),
          lte(approvals.createdAt, new Date(now.getTime() - STALE_APPROVAL_MS)),
        ),
      )
      .returning();
    return stale.map((row) => ({
      groupId: row.groupId,
      text: `「${toolViewText(row.view)}」这件事等你点头已经一天了，它还挂着。`,
    }));
  });
}
