import type { AgentToControl, ApprovalOutcome, BotId, GrantTarget, GroupId, RunId, ToolView } from "@baize/shared";

export type ApprovalAction = Extract<AgentToControl, { type: "approval_request" }>["action"];
export type LocalApprovalOutcome = ApprovalOutcome | "expired";
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
  ask(request: ApprovalRequest, signal: AbortSignal | undefined): Promise<LocalApprovalOutcome>;
  settle(runId: RunId, callId: string, outcome: ApprovalOutcome): boolean;
  expire(runId: RunId): readonly string[];
  block(runId: RunId, callId: string): void;
  consumeBlocked(runId: RunId, callId: string): boolean;
  abandon(reason: ApprovalAbandonReason, botId?: BotId, runId?: RunId): void;
  cancel(botId?: BotId): void;
}

interface WaitingApproval {
  readonly runId: RunId;
  readonly callId: string;
  readonly botId: BotId;
  readonly settle: (outcome: LocalApprovalOutcome) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
}

const approvalKey = (runId: RunId, callId: string): string => JSON.stringify([runId, callId]);

export function createApprovalGate(send: (message: AgentToControl) => void): ApprovalGate {
  const waiting = new Map<string, WaitingApproval>();
  const blockedCallIds = new Set<string>();

  const settleCall = (runId: RunId, callId: string, outcome: LocalApprovalOutcome): boolean => {
    const entry = waiting.get(approvalKey(runId, callId));
    if (entry === undefined) return false;
    waiting.delete(approvalKey(runId, callId));
    entry.signal?.removeEventListener("abort", entry.onAbort);
    if (outcome !== "approved") blockedCallIds.add(approvalKey(runId, callId));
    entry.settle(outcome);
    return true;
  };

  return {
    ask: (request, signal) => {
      if (signal?.aborted === true) {
        blockedCallIds.add(approvalKey(request.runId, request.callId));
        return Promise.resolve("rejected");
      }
      return new Promise<LocalApprovalOutcome>((resolve) => {
        const onAbort = (): void => {
          settleCall(request.runId, request.callId, "rejected");
        };
        waiting.set(approvalKey(request.runId, request.callId), {
          runId: request.runId,
          callId: request.callId,
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
    settle: (runId, callId, outcome) => {
      if (waiting.get(approvalKey(runId, callId))?.runId !== runId) return false;
      return settleCall(runId, callId, outcome);
    },
    expire: (runId) => {
      const callIds = [...waiting.values()].filter((entry) => entry.runId === runId).map((entry) => entry.callId);
      for (const callId of callIds) settleCall(runId, callId, "expired");
      return callIds;
    },
    block: (runId, callId) => {
      blockedCallIds.add(approvalKey(runId, callId));
    },
    consumeBlocked: (runId, callId) => blockedCallIds.delete(approvalKey(runId, callId)),
    abandon: (reason, botId, runId) => {
      const targets: Array<readonly [callId: string, runId: RunId]> = [];
      for (const entry of waiting.values()) {
        if ((botId === undefined || entry.botId === botId) && (runId === undefined || entry.runId === runId))
          targets.push([entry.callId, entry.runId]);
      }
      for (const [callId, waitingRunId] of targets) {
        send({ type: "approval_abandoned", runId: waitingRunId, callId, reason });
        settleCall(waitingRunId, callId, "rejected");
      }
    },
    cancel: (botId) => {
      const targets = [...waiting.values()].filter((entry) => botId === undefined || entry.botId === botId);
      for (const entry of targets) settleCall(entry.runId, entry.callId, "rejected");
    },
  };
}
