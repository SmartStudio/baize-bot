import { AgentToControl, type BotId, type GroupId, type MessageId, type RunId } from "@baize/shared";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

// 一次 prompt 的会话事件翻成上行报文。出边界前一律过 AgentToControl.parse，schema 不过就抛。

export interface RunIdentity {
  readonly runId: RunId;
  readonly botId: BotId;
  readonly groupId: GroupId;
  readonly messageId: MessageId;
}

export function reportRun(
  session: AgentSession,
  identity: RunIdentity,
  blockedCallIds: ReadonlySet<string>,
  send: (message: AgentToControl) => void,
): () => void {
  const ids = { runId: identity.runId, botId: identity.botId, groupId: identity.groupId };
  const startedAt = new Map<string, number>();
  let steps = 0;

  const push = (message: AgentToControl): void => {
    send(AgentToControl.parse(message));
  };

  return session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      push({
        type: "bot_text",
        ...ids,
        messageId: identity.messageId,
        delta: event.assistantMessageEvent.delta,
        done: false,
      });
      return;
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_end") {
      push({ type: "bot_text", ...ids, messageId: identity.messageId, delta: "", done: true });
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
    // 不能挂 agent_end：自动重试和队列续跑时它一次 run 会发好几遍。agent_settled 在
    // _runAgentPrompt 的 finally 里发，一次 prompt 恰好一次，出错和中止也覆盖。
    if (event.type === "agent_settled") {
      const tokens = session.getSessionStats().tokens;
      push({ type: "run_done", ...ids, steps, inputTokens: tokens.input, outputTokens: tokens.output });
    }
  });
}
