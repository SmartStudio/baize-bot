import {
  ApprovalId,
  BotId,
  ComputerId,
  GRANTABLE_SCOPES,
  GrantId,
  GroupId,
  RunId,
  toolViewText,
  UserId,
  type Approval,
  type ApprovalScope,
  type ActionKind,
  type DecideApprovalRequest,
  type Grant,
  type GrantTarget,
  type Message,
  type ToolView,
} from "@baize/shared";
import { TransactionRollbackError, and, count, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { approvals, grants, groups, messages, runs } from "../db/schema.js";
import { newId } from "../ids.js";
import { appendMessage, type Tx } from "./messages.js";
import { appendReminders } from "./reminders.js";
import { lockOpenRun } from "./runs.js";
import { toApproval, toGrant } from "./rows.js";
import type { PushHub } from "../ws/hub.js";

type ApprovalRow = typeof approvals.$inferSelect;

/** 过了这么久还没有结论就提醒一次。规格里的「24 小时后追加一条 system 提醒」。 */
export const STALE_APPROVAL_MS = 24 * 60 * 60 * 1000;

export type CreateApprovalInput = {
  readonly runId: RunId;
  readonly botId: BotId;
  readonly groupId: GroupId;
  readonly callId: string;
  readonly tool: string;
  readonly action: ActionKind;
  readonly target: GrantTarget | null;
  readonly view: ToolView;
};

export type CreatedApproval = { readonly approval: Approval; readonly message: Message };

export type ApprovalRun = { readonly botId: BotId; readonly groupId: GroupId };

/**
 * 建一条待批审批和群里那张卡。两者在一个事务里生，所以群里不会出现没有审批的孤儿卡。
 * 电脑重发同一条 approval_request 时唯一索引拦下，整条事务回滚，返回 null；run 已经结束也返回 null。
 */
export async function createApproval(db: Db, input: CreateApprovalInput): Promise<CreatedApproval | null> {
  const approvalId = ApprovalId.parse(newId());
  try {
    return await db.transaction(async (tx): Promise<CreatedApproval | null> => {
      // run 收尾时已经把它的审批打成过期，之后晚到的请求再出一张卡就永远等不到结论。
      if (!(await lockOpenRun(tx, input))) return null;
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
          action: input.action,
          target: input.target,
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
  readonly computerId: ComputerId | null;
  readonly callId: string;
  /** 批准时选了长期范围才有。同一个目标之前批过，拿到的是原来那一条。 */
  readonly grant: Grant | null;
};

export type DecideOutcome =
  | { readonly kind: "decided"; readonly decided: DecidedApproval }
  | { readonly kind: "already_decided" }
  | { readonly kind: "scope_not_allowed"; readonly error: string };

/** 这条审批能不能批到这个范围。不能就给一句人话，能就是 null。 */
function scopeRefusal(row: ApprovalRow, scope: ApprovalScope): string | null {
  if (scope === "once") return null;
  const allowed = GRANTABLE_SCOPES[row.action];
  if (!allowed.includes(scope))
    return allowed.includes("project") ? "这类动作最多批到这个项目里" : "这类动作只能批这一次";
  // 授权要记住「同类动作、同一个目标」，没有目标就没有东西可记。
  if (row.target === null) return "这条审批没有具体目标，只能批这一次";
  return null;
}

/**
 * 只给还没有结论的那一行定结论，批准时顺手落授权，都在一个事务里。
 * 幂等靠 UPDATE 的 WHERE status = 'pending' 和授权表的唯一约束，不靠先查后写。
 * 越级的范围整条回滚，审批还在等。
 */
export async function decideApproval(
  db: Db,
  ownerId: UserId,
  approvalId: ApprovalId,
  request: DecideApprovalRequest,
): Promise<DecideOutcome> {
  // 回滚只能靠抛异常，拒绝的原因从这里带出事务。
  const refused: { error: string | null } = { error: null };
  try {
    const decided = await db.transaction(async (tx): Promise<DecidedApproval | null> => {
      const [row] = await tx
        .update(approvals)
        .set({ status: request.decision, decidedAt: new Date() })
        .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
        .returning();
      if (row === undefined) return null;

      const scope = request.decision === "approved" ? request.scope : "once";
      refused.error = scopeRefusal(row, scope);
      if (refused.error !== null) return tx.rollback();

      let settled = row;
      let grant: Grant | null = null;
      if (scope !== "once" && row.target !== null) {
        const [grantRow] = await tx
          .insert(grants)
          .values({
            id: GrantId.parse(newId()),
            ownerId,
            action: row.action,
            target: row.target,
            scope,
            groupId: scope === "project" ? row.groupId : null,
          })
          .onConflictDoUpdate({
            target: [grants.ownerId, grants.action, grants.target, grants.groupId],
            // 空更新只为让 RETURNING 带回已有那一行。
            set: { scope: sql`excluded.scope` },
          })
          .returning();
        if (grantRow === undefined) throw new Error("授权写入没有返回行");
        grant = toGrant(grantRow);
        const [linked] = await tx
          .update(approvals)
          .set({ grantId: grant.id })
          .where(eq(approvals.id, approvalId))
          .returning();
        if (linked === undefined) throw new Error("审批行在同一事务里消失了");
        settled = linked;
      }

      const [run] = await tx.select({ computerId: runs.computerId }).from(runs).where(eq(runs.id, row.runId)).limit(1);
      return {
        approval: toApproval(settled),
        runId: RunId.parse(row.runId),
        computerId: run?.computerId === null || run?.computerId === undefined ? null : ComputerId.parse(run.computerId),
        callId: row.callId,
        grant,
      };
    });
    return decided === null ? { kind: "already_decided" } : { kind: "decided", decided };
  } catch (error) {
    if (error instanceof TransactionRollbackError && refused.error !== null) {
      return { kind: "scope_not_allowed", error: refused.error };
    }
    throw error;
  }
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
