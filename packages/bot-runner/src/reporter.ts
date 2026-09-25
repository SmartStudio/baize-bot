import { AgentToControl, type BotId, type GroupId, type MessageId, type RunId, type ToolView } from "@baize/shared";
import type { AgentSession, SessionStats } from "@earendil-works/pi-coding-agent";

// 一次 prompt 的会话事件翻成上行报文。出边界前一律过 AgentToControl.parse，schema 不过就抛。

export interface RunIdentity {
  readonly runId: RunId;
  readonly botId: BotId;
  readonly groupId: GroupId;
  readonly messageId: MessageId;
}

type ToolArgs = Record<string, unknown>;

const objectOf = (args: unknown): ToolArgs | null =>
  typeof args === "object" && args !== null && !Array.isArray(args) ? (args as ToolArgs) : null;

const rawOf = (args: unknown): { readonly raw?: ToolView["raw"] } =>
  args === undefined ? {} : { raw: args as ToolView["raw"] };

const lineCount = (text: string): number => (text === "" ? 0 : text.split("\n").length);

const changedLinesOf = (args: ToolArgs): number => {
  const edits = args.edits;
  if (!Array.isArray(edits)) return 0;
  return edits.reduce((total, edit) => {
    if (typeof edit !== "object" || edit === null || Array.isArray(edit)) return total;
    const oldText = "oldText" in edit && typeof edit.oldText === "string" ? edit.oldText : "";
    const newText = "newText" in edit && typeof edit.newText === "string" ? edit.newText : "";
    return total + Math.max(lineCount(oldText), lineCount(newText));
  }, 0);
};

const isScalar = (value: unknown): value is string | number | boolean | null =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

export function simpleToolView(toolName: string, args: unknown, server = ""): ToolView {
  const object = objectOf(args);
  if (toolName === "bash") {
    const command = object !== null && typeof object.command === "string" ? object.command : "";
    return { kind: "bash", command, ...rawOf(args) };
  }
  if (toolName === "write") {
    const path = object !== null && typeof object.path === "string" ? object.path : "";
    const content = object !== null && typeof object.content === "string" ? object.content.replace(/\n+$/, "") : "";
    const preview = content === "" ? [] : content.split("\n").slice(0, 5);
    return { kind: "write", path, preview, ...rawOf(args) };
  }
  if (toolName === "edit") {
    const path = object !== null && typeof object.path === "string" ? object.path : "";
    return { kind: "edit", path, changedLines: changedLinesOf(object ?? {}), ...rawOf(args) };
  }
  const params =
    object === null
      ? []
      : Object.entries(object)
          .filter((entry): entry is [string, string | number | boolean | null] => isScalar(entry[1]))
          .slice(0, 3)
          .map(([key, value]) => ({ key, value }));
  return { kind: "mcp", server, tool: toolName, params, ...rawOf(args) };
}

export function reportRun(
  session: AgentSession,
  statsBeforeRun: SessionStats,
  identity: RunIdentity,
  runnerAborted: () => boolean,
  blockedCallIds: ReadonlySet<string>,
  serverForTool: (toolName: string) => string,
  send: (message: AgentToControl) => void,
): () => void {
  const ids = { runId: identity.runId, botId: identity.botId, groupId: identity.groupId };
  const startedAt = new Map<string, number>();
  const views = new Map<string, ToolView>();
  let steps = 0;
  let lastModelError: string | null = null;

  const push = (message: AgentToControl): void => {
    send(AgentToControl.parse(message));
  };

  return session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      lastModelError =
        event.message.stopReason === "error" ? (event.message.errorMessage || "模型上游没回话").slice(0, 500) : null;
      return;
    }
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
      const view = simpleToolView(event.toolName, event.args, serverForTool(event.toolName));
      views.set(event.toolCallId, view);
      push({
        type: "bot_tool_call",
        ...ids,
        callId: event.toolCallId,
        tool: event.toolName,
        view,
        status: "running",
        durationMs: null,
      });
      return;
    }
    if (event.type === "tool_execution_end") {
      const began = startedAt.get(event.toolCallId);
      const view =
        views.get(event.toolCallId) ?? simpleToolView(event.toolName, undefined, serverForTool(event.toolName));
      startedAt.delete(event.toolCallId);
      views.delete(event.toolCallId);
      push({
        type: "bot_tool_call",
        ...ids,
        callId: event.toolCallId,
        tool: event.toolName,
        view,
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
      if (!runnerAborted() && lastModelError !== null) {
        push({ type: "agent_error", code: "model_failed", detail: lastModelError, groupId: ids.groupId });
      }
      const statsAfterRun = session.getSessionStats();
      // config 切换或会话重建会让累计值回零，差值最低按零报，不能把负数送出边界。
      const inputTokens = Math.max(0, statsAfterRun.tokens.input - statsBeforeRun.tokens.input);
      const outputTokens = Math.max(0, statsAfterRun.tokens.output - statsBeforeRun.tokens.output);
      push({ type: "run_done", ...ids, steps, inputTokens, outputTokens });
    }
  });
}
