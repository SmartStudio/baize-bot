import { randomUUID } from "node:crypto";
import { AgentToControl, type BotId, type GroupId, MessageId, type RunId, type ToolView } from "@baize/shared";
import type { AgentSession, SessionStats } from "@earendil-works/pi-coding-agent";
import { HELPER_TOOL, helperToolView } from "./helper.js";
import { TAKEOVER_TOOL, takeoverToolView } from "./takeover.js";

// 一次 prompt 的会话事件翻成上行报文。出边界前一律过 AgentToControl.parse，schema 不过就抛。

export interface RunIdentity {
  readonly runId: RunId;
  readonly botId: BotId;
  readonly groupId: GroupId;
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
  if (toolName === HELPER_TOOL) return helperToolView(args, "running");
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

export interface RunReport {
  readonly unsubscribe: () => void;
  /** 这次 run 里见过触发那条 user 消息的 message_end，也就是它真进了会话。 */
  readonly entered: () => boolean;
}

const firstText = (message: { readonly content: string | readonly { readonly type: string }[] }): string | null => {
  if (typeof message.content === "string") return message.content;
  const block = message.content[0];
  return block !== undefined && block.type === "text" && "text" in block && typeof block.text === "string"
    ? block.text
    : null;
};

export function reportRun(
  session: AgentSession,
  statsBeforeRun: SessionStats,
  identity: RunIdentity,
  promptText: string,
  runnerAborted: () => boolean,
  consumeBlockedCall: (callId: string) => boolean,
  serverForTool: (toolName: string) => string,
  send: (message: AgentToControl) => void,
): RunReport {
  const ids = { runId: identity.runId, botId: identity.botId, groupId: identity.groupId };
  const startedAt = new Map<string, number>();
  const views = new Map<string, ToolView>();
  let steps = 0;
  let lastModelError: string | null = null;
  let entered = false;
  // 每个文字块一条群消息。text_end 之后这条不再长，工具之后的正文另起一条，
  // 控制面的 streaming 因此就等于「这条还会长」，别的 Bot 的水位靠它。
  let block: MessageId | null = null;
  let blockText = "";

  const push = (message: AgentToControl): void => {
    send(AgentToControl.parse(message));
  };

  const unsubscribe = session.subscribe((event) => {
    // Agent 的 processEvents 先把 message_end 的消息 push 进 state（dist/agent.js 403-405）再叫订阅者（431-433），
    // 见到触发这条 user 消息的 message_end 就是它进了会话。按正文认而不是「第一条 user 消息」：
    // 排队的 prompt 和续跑都会发 user 消息的 message_end。
    if (event.type === "message_end" && event.message.role === "user") {
      if (firstText(event.message) === promptText) entered = true;
      return;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      lastModelError =
        event.message.stopReason === "error" ? (event.message.errorMessage || "模型上游没回话").slice(0, 500) : null;
      return;
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      block ??= MessageId.parse(randomUUID());
      blockText += event.assistantMessageEvent.delta;
      push({ type: "bot_text", ...ids, messageId: block, delta: event.assistantMessageEvent.delta, done: false });
      return;
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_end") {
      if (block === null) return;
      push({ type: "bot_text_done", ...ids, messageId: block, text: blockText });
      block = null;
      blockText = "";
      return;
    }
    if (event.type === "tool_execution_start") {
      startedAt.set(event.toolCallId, Date.now());
      // 接手卡的 liveId 由 runId 和 callId 算出，simpleToolView 拿不到这两样。
      const view =
        event.toolName === TAKEOVER_TOOL
          ? takeoverToolView(event.args, identity.runId, event.toolCallId)
          : simpleToolView(event.toolName, event.args, serverForTool(event.toolName));
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
      const status = consumeBlockedCall(event.toolCallId) ? "blocked" : event.isError ? "failed" : "ok";
      push({
        type: "bot_tool_call",
        ...ids,
        callId: event.toolCallId,
        tool: event.toolName,
        // 帮手那一行自带进度，跟着这条调用的终态走。
        view: view.kind === "helper" ? { ...view, status: status === "ok" ? "done" : "failed" } : view,
        status,
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
      // agent_settled 从 _runAgentPrompt 的 finally 发（dist/core/agent-session.js 1376），一次 prompt 恰好一次，
      // 但它不等于消息进了会话：Agent.prompt 在 activeRun 占着时抛（dist/agent.js 243-248）也走这个 finally。
      // 进没进看上面那条 message_end。
      push({
        type: "run_done",
        ...ids,
        prompt: entered ? "entered" : "dropped",
        steps,
        inputTokens,
        outputTokens,
      });
    }
  });
  return { unsubscribe, entered: () => entered };
}
