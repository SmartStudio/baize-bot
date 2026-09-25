import type { AgentToControl, BotId, GroupId, RunId, ToolConnection, ToolView } from "@baize/shared";

// 审批拦截器。扩展在 Pi 的 tool_call 事件里挂起一个 pending，控制面的 approval_result
// 经 runner.approve 落回来。被拒的 callId 记在这里：Pi 的事件层里「被拦下」和「工具自己报错」
// 都只是 isError，分不出来。

export type ApprovalKind = Extract<AgentToControl, { type: "approval_request" }>["kind"];
type ApprovalAbandonReason = Exclude<Extract<AgentToControl, { type: "approval_abandoned" }>["reason"], "disconnected">;

// 第一版按工具名前缀定审批类型。命中不了的一律当改生产数据，宁可多问一次。
const KIND_BY_PREFIX: ReadonlyArray<readonly [prefix: string, kind: ApprovalKind]> = [
  ["send_", "send_external"],
  ["pay_", "pay"],
];
const FALLBACK_KIND: ApprovalKind = "change_production_data";

export function approvalKind(toolName: string): ApprovalKind {
  return KIND_BY_PREFIX.find(([prefix]) => toolName.startsWith(prefix))?.[1] ?? FALLBACK_KIND;
}

/**
 * 工具连接里 needsApproval 为 true 的操作要审批。没在任何工具连接里出现过的自定义工具默认不审批。
 * 传进来的应当只是分配给这个 Bot 的连接：别的 Bot 的连接管不到它，也不该替它定审批。
 */
export function approvalRule(tools: readonly ToolConnection[]): (toolName: string) => boolean {
  const needing = new Set(
    tools.flatMap((tool) => tool.operations.filter((op) => op.needsApproval).map((op) => op.name)),
  );
  return (toolName) => needing.has(toolName);
}

export interface ApprovalRequest {
  readonly runId: RunId;
  readonly botId: BotId;
  readonly groupId: GroupId;
  readonly callId: string;
  readonly tool: string;
  readonly summary: string;
  readonly view: ToolView;
}

export interface ApprovalGate {
  /** 扩展调用。发出 approval_request，挂起到 approve 给结论为止。 */
  ask(request: ApprovalRequest): Promise<boolean>;
  /** 控制面的结论。runId 对不上的结论不作数。 */
  settle(runId: RunId, callId: string, approved: boolean): void;
  /**
   * 先上报还挂着的审批已放弃，再一律当拒绝收尾。不给 botId 就是全部。
   * 挂起的 handler 是 Pi 工具循环在 await 的东西，不解开它，abort 永远等不到 idle。
   */
  abandon(reason: ApprovalAbandonReason, botId?: BotId): void;
  readonly blockedCallIds: ReadonlySet<string>;
}

export function createApprovalGate(send: (message: AgentToControl) => void): ApprovalGate {
  const waiting = new Map<
    string,
    { readonly runId: RunId; readonly botId: BotId; readonly settle: (approved: boolean) => void }
  >();
  const blockedCallIds = new Set<string>();

  const decide = (callId: string, approved: boolean): void => {
    const entry = waiting.get(callId);
    if (entry === undefined) return;
    waiting.delete(callId);
    if (!approved) blockedCallIds.add(callId);
    entry.settle(approved);
  };

  return {
    blockedCallIds,
    ask: (request) =>
      new Promise<boolean>((resolve) => {
        waiting.set(request.callId, { runId: request.runId, botId: request.botId, settle: resolve });
        send({
          type: "approval_request",
          runId: request.runId,
          botId: request.botId,
          groupId: request.groupId,
          callId: request.callId,
          tool: request.tool,
          kind: approvalKind(request.tool),
          summary: request.summary,
          view: request.view,
        });
      }),
    settle: (runId, callId, approved) => {
      if (waiting.get(callId)?.runId !== runId) return;
      decide(callId, approved);
    },
    abandon: (reason, botId) => {
      const targets: Array<readonly [callId: string, runId: RunId]> = [];
      for (const [callId, entry] of waiting) {
        if (botId === undefined || entry.botId === botId) targets.push([callId, entry.runId]);
      }
      for (const [callId, runId] of targets) {
        send({ type: "approval_abandoned", runId, callId, reason });
        decide(callId, false);
      }
    },
  };
}
