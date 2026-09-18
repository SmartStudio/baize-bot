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
    // 不能挂 agent_end：自动重试和队列续跑时它一次 run 会发好几遍（agent-session.js:386 的
    // willRetry，agent-session.js:776 的 continue 循环）。agent_settled 在 _runAgentPrompt 的
    // finally 里发，一次 prompt 恰好一次（agent-session.js:347、:784）。
    if (event.type === "agent_settled") {
      const tokens = session.getSessionStats().tokens;
      push({ type: "run_done", ...ids, steps, inputTokens: tokens.input, outputTokens: tokens.output });
    }
  });

  return { messages, unsubscribe };
}
