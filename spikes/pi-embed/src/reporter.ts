import { AgentToControl, BotId, GroupId, MessageId, RunId } from "@baize/shared";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

// 把一次 prompt 的会话事件翻成电脑代理发给控制面的报文。
// 报文出边界前一律过 AgentToControl.parse，schema 不过就抛。

export interface RunIdentity {
  readonly runId: string;
  readonly botId: string;
  readonly groupId: string;
  readonly messageId: string;
}

export interface RunReport {
  readonly messages: readonly AgentToControl[];
}

export function recordRun(
  session: AgentSession,
  identity: RunIdentity,
  blockedCallIds: ReadonlySet<string>,
): { messages: AgentToControl[]; unsubscribe: () => void } {
  const messages: AgentToControl[] = [];
  const ids = {
    runId: RunId.parse(identity.runId),
    botId: BotId.parse(identity.botId),
    groupId: GroupId.parse(identity.groupId),
  };
  const messageId = MessageId.parse(identity.messageId);
  const startedAt = new Map<string, number>();
  let steps = 0;

  const push = (message: AgentToControl): void => {
    messages.push(AgentToControl.parse(message));
  };

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      push({ type: "bot_text", ...ids, messageId, delta: event.assistantMessageEvent.delta, done: false });
      return;
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_end") {
      push({ type: "bot_text", ...ids, messageId, delta: "", done: true });
      return;
    }
    if (event.type === "tool_execution_start") {
      startedAt.set(event.toolCallId, Date.now());
      push({
        type: "bot_tool_call",
        ...ids,
        callId: event.toolCallId,
        tool: event.toolName,
        argsSummary: JSON.stringify(event.args),
        status: "running",
        durationMs: null,
      });
      return;
    }
    if (event.type === "tool_execution_end") {
      const began = startedAt.get(event.toolCallId);
      push({
        type: "bot_tool_call",
        ...ids,
        callId: event.toolCallId,
        tool: event.toolName,
        argsSummary: "",
        status: blockedCallIds.has(event.toolCallId) ? "blocked" : event.isError ? "failed" : "ok",
        durationMs: began === undefined ? null : Date.now() - began,
      });
      return;
    }
    if (event.type === "turn_end") {
      steps += 1;
      return;
    }
    if (event.type === "agent_end") {
      const tokens = session.getSessionStats().tokens;
      push({ type: "run_done", ...ids, steps, inputTokens: tokens.input, outputTokens: tokens.output });
    }
  });

  return { messages, unsubscribe };
}
