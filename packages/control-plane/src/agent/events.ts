import type { AgentToControl, ControlToAgent, Message, MessageBody, UserId } from "@baize/shared";
import type { Db } from "../db/client.js";
import { createApproval } from "../repo/approvals.js";
import { markComputerOnline } from "../repo/computers.js";
import {
  appendBotDelta,
  appendMessage,
  appendMessageWithId,
  findGroupId,
  replaceMessageBody,
} from "../repo/messages.js";
import { finishRun, latestOpenRun } from "../repo/runs.js";
import type { PushHub } from "../ws/hub.js";
import type { AgentConnection } from "./hub.js";

export type AgentEventDeps = {
  readonly db: Db;
  readonly push: PushHub;
  readonly priceInputPerM: number;
  readonly priceOutputPerM: number;
  readonly reply: (conn: AgentConnection, message: ControlToAgent) => void;
};

/** 电脑代理报上来的事件。每一条都写进 messages 表再推给 Web 客户端，群消息是事实来源。 */
export async function handleAgentEvent(
  deps: AgentEventDeps,
  conn: AgentConnection,
  message: AgentToControl,
): Promise<void> {
  switch (message.type) {
    // 握手在 hub 里做完了，重复的 hello 不再认一次身份。
    case "hello":
      return;
    case "heartbeat":
      await markComputerOnline(deps.db, conn.computerId);
      return;
    // 已登录站点是 M6 的对象，这一版收下不存。
    case "sites":
      return;
    case "bot_text":
      await onBotText(deps, conn, message);
      return;
    case "bot_tool_call":
      await onToolCall(deps, conn, message);
      return;
    case "run_done":
      await onRunDone(deps, conn, message);
      return;
    case "agent_error":
      await onAgentError(deps, conn, message);
      return;
    case "approval_request":
      await onApprovalRequest(deps, conn, message);
      return;
  }
}

type BotText = Extract<AgentToControl, { type: "bot_text" }>;
type ToolCall = Extract<AgentToControl, { type: "bot_tool_call" }>;
type RunDone = Extract<AgentToControl, { type: "run_done" }>;
type AgentError = Extract<AgentToControl, { type: "agent_error" }>;
type ApprovalRequest = Extract<AgentToControl, { type: "approval_request" }>;

async function onBotText(deps: AgentEventDeps, conn: AgentConnection, event: BotText): Promise<void> {
  // 报文里的群号是外部输入，findGroupId 按归属人过滤，不是这台电脑主人的群整条丢掉。
  const groupId = await findGroupId(deps.db, conn.ownerId, event.groupId);
  if (groupId === null) return;

  const appended = await appendMessageWithId(deps.db, event.messageId, groupId, {
    kind: "bot",
    botId: event.botId,
    text: "",
    streaming: true,
  });
  if (appended.kind === "taken") {
    console.warn(`电脑 ${conn.computerId} 报的消息编号 ${event.messageId} 已经被别的群占了，整条丢掉`);
    return;
  }
  // 先推空壳再推 delta，客户端才有一条可以往上追加正文的消息。
  if (appended.kind === "created") deps.push.push(conn.ownerId, { type: "message", message: appended.message });

  await appendBotDelta(deps.db, event.messageId, groupId, event.delta, event.done);
  deps.push.push(conn.ownerId, {
    type: "message_delta",
    messageId: event.messageId,
    groupId: event.groupId,
    delta: event.delta,
    done: event.done,
  });
}

async function onToolCall(deps: AgentEventDeps, conn: AgentConnection, event: ToolCall): Promise<void> {
  const groupId = await findGroupId(deps.db, conn.ownerId, event.groupId);
  if (groupId === null) return;

  const body = {
    kind: "tool_call",
    botId: event.botId,
    tool: event.tool,
    argsSummary: event.argsSummary,
    status: event.status,
    durationMs: event.durationMs,
  } as const;

  const key = `${event.runId}:${event.callId}`;
  const known = conn.toolCallMessages.get(key);
  const message =
    known === undefined
      ? await appendMessage(deps.db, groupId, body)
      : await replaceMessageBody(deps.db, known, groupId, body);
  if (message === null) return;

  // 同一个 id 推第二次，客户端按 id 覆盖那张卡。
  deps.push.push(conn.ownerId, { type: "message", message });
  if (event.status === "running") conn.toolCallMessages.set(key, message.id);
  else conn.toolCallMessages.delete(key);
}

async function onRunDone(deps: AgentEventDeps, conn: AgentConnection, event: RunDone): Promise<void> {
  const groupId = await findGroupId(deps.db, conn.ownerId, event.groupId);
  if (groupId === null) return;

  const amount =
    (event.inputTokens / 1_000_000) * deps.priceInputPerM + (event.outputTokens / 1_000_000) * deps.priceOutputPerM;
  const usage = await finishRun(deps.db, event.runId, event.groupId, {
    steps: event.steps,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    amount,
  });
  // 重复的 runId 和不认识的 runId 在这里都是 null，不再多记一行也不再多一张花费卡。
  if (usage === null) return;

  await appendAndPush(deps, conn.ownerId, groupId, {
    kind: "cost",
    runId: event.runId,
    steps: usage.steps,
    amount: usage.amount,
  });
}

const ERROR_REASONS: Record<AgentError["code"], string> = {
  bad_message: "它看不懂控制面发过去的报文",
  prompt_before_config: "配置还没到就先接到了活",
  unsupported: "这件事它还做不了",
  runner_failed: "跑活的进程出错了",
};

async function onAgentError(deps: AgentEventDeps, conn: AgentConnection, event: AgentError): Promise<void> {
  // agent_error 报文里没有群号，只能落到这台电脑最近一次还没结束的活所在的群。
  const open = await latestOpenRun(deps.db, conn.ownerId);
  if (open === null) {
    console.error(`电脑 ${conn.computerId} 报错但没有进行中的活：${event.code} ${event.detail}`);
    return;
  }
  await appendAndPush(deps, conn.ownerId, open.groupId, {
    kind: "system",
    text: `电脑那边没干成这件事，${ERROR_REASONS[event.code]}。原话是：${event.detail}`,
  });
}

/**
 * 不回 approval_result，电脑上的运行器就一直挂着等，直到归属人点了按钮或在群里回了话。
 * 这是审批的本意：没人点头就不往下走。
 */
async function onApprovalRequest(deps: AgentEventDeps, conn: AgentConnection, event: ApprovalRequest): Promise<void> {
  const groupId = await findGroupId(deps.db, conn.ownerId, event.groupId);
  if (groupId === null) return;

  const created = await createApproval(deps.db, {
    runId: event.runId,
    botId: event.botId,
    groupId,
    callId: event.callId,
    tool: event.tool,
    kind: event.kind,
    summary: event.summary,
  });
  // 同一条 approval_request 重发时这里是 null：不多一张卡，也不多推一次。
  if (created === null) return;

  // 先推审批再推卡，客户端画那张卡的时候状态已经在手上了。
  deps.push.push(conn.ownerId, { type: "approval_updated", approval: created.approval });
  deps.push.push(conn.ownerId, { type: "message", message: created.message });
}

async function appendAndPush(
  deps: AgentEventDeps,
  ownerId: UserId,
  groupId: string,
  body: MessageBody,
): Promise<Message> {
  const message = await appendMessage(deps.db, groupId, body);
  deps.push.push(ownerId, { type: "message", message });
  return message;
}
