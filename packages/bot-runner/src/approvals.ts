import type { AgentToControl, BotId, GrantTarget, GroupId, RunId, ToolView } from "@baize/shared";

export type ApprovalAction = Extract<AgentToControl, { type: "approval_request" }>["action"];
type ApprovalAbandonReason = Exclude<Extract<AgentToControl, { type: "approval_abandoned" }>["reason"], "disconnected">;

export interface ApprovalRequest {
  readonly runId: RunId;
  readonly botId: BotId;
  readonly groupId: GroupId;
  readonly callId: string;
  readonly tool: string;
  readonly action: ApprovalAction;
  readonly target: GrantTarget | null;
  readonly view: ToolView;
}

export interface ApprovalGate {
  ask(request: ApprovalRequest, signal: AbortSignal | undefined): Promise<boolean>;
  settle(runId: RunId, callId: string, approved: boolean): void;
  block(callId: string): void;
  consumeBlocked(callId: string): boolean;
  abandon(reason: ApprovalAbandonReason, botId?: BotId): void;
  cancel(botId?: BotId): void;
}

interface WaitingApproval {
  readonly runId: RunId;
  readonly botId: BotId;
  readonly settle: (approved: boolean) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
}

export function createApprovalGate(send: (message: AgentToControl) => void): ApprovalGate {
  const waiting = new Map<string, WaitingApproval>();
  const blockedCallIds = new Set<string>();

  const settleCall = (callId: string, approved: boolean): void => {
    const entry = waiting.get(callId);
    if (entry === undefined) return;
    waiting.delete(callId);
    entry.signal?.removeEventListener("abort", entry.onAbort);
    if (!approved) blockedCallIds.add(callId);
    entry.settle(approved);
  };

  return {
    ask: (request, signal) => {
      if (signal?.aborted === true) {
        blockedCallIds.add(request.callId);
        return Promise.resolve(false);
      }
      return new Promise<boolean>((resolve) => {
        const onAbort = (): void => settleCall(request.callId, false);
        waiting.set(request.callId, {
          runId: request.runId,
          botId: request.botId,
          settle: resolve,
          signal,
          onAbort,
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        send({
          type: "approval_request",
          runId: request.runId,
          botId: request.botId,
          groupId: request.groupId,
          callId: request.callId,
          tool: request.tool,
          action: request.action,
          target: request.target,
          view: request.view,
        });
      });
    },
    settle: (runId, callId, approved) => {
      if (waiting.get(callId)?.runId !== runId) return;
      settleCall(callId, approved);
    },
    block: (callId) => {
      blockedCallIds.add(callId);
    },
    consumeBlocked: (callId) => blockedCallIds.delete(callId),
    abandon: (reason, botId) => {
      const targets: Array<readonly [callId: string, runId: RunId]> = [];
      for (const [callId, entry] of waiting) {
        if (botId === undefined || entry.botId === botId) targets.push([callId, entry.runId]);
      }
      for (const [callId, runId] of targets) {
        send({ type: "approval_abandoned", runId, callId, reason });
        settleCall(callId, false);
      }
    },
    cancel: (botId) => {
      const targets: string[] = [];
      for (const [callId, entry] of waiting) if (botId === undefined || entry.botId === botId) targets.push(callId);
      for (const callId of targets) settleCall(callId, false);
    },
  };
}
