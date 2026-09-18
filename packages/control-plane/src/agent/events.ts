import type { AgentToControl, ControlToAgent, Message, MessageBody, UserId } from "@baize/shared";
import type { Db } from "../db/client.js";
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

  const { message, created } = await appendMessageWithId(deps.db, event.messageId, groupId, {
    kind: "bot",
    botId: event.botId,
    text: "",
    streaming: true,
  });
  // 先推空壳再推 delta，客户端才有一条可以往上追加正文的消息。
  if (created) deps.push.push(conn.ownerId, { type: "message", message });

  await appendBotDelta(deps.db, event.messageId, event.delta, event.done);
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
    known === undefined ? await appendMessage(deps.db, groupId, body) : await replaceMessageBody(deps.db, known, body);
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
  // 报文带了群号就落在那个群，它是外部输入，照样按归属人过滤。不带才退回到最近一次还没结束的活。
  const named = event.groupId === undefined ? null : await findGroupId(deps.db, conn.ownerId, event.groupId);
  const groupId = named ?? (await latestOpenRun(deps.db, conn.ownerId))?.groupId ?? null;
  if (groupId === null) {
    console.error(`电脑 ${conn.computerId} 报错但没有进行中的活：${event.code} ${event.detail}`);
    return;
  }
  await appendAndPush(deps, conn.ownerId, groupId, {
    kind: "system",
    text: `电脑那边没干成这件事，${ERROR_REASONS[event.code]}。原话是：${event.detail}`,
  });
}

async function onApprovalRequest(deps: AgentEventDeps, conn: AgentConnection, event: ApprovalRequest): Promise<void> {
  // 审批是 M5 的事。先回一个拒绝，别让电脑上的运行器一直挂着等结论。
  deps.reply(conn, { type: "approval_result", runId: event.runId, callId: event.callId, approved: false });

  const groupId = await findGroupId(deps.db, conn.ownerId, event.groupId);
  if (groupId === null) return;
  await appendAndPush(deps, conn.ownerId, groupId, {
    kind: "system",
    text: `「${event.tool}」这一步要你点头（${event.summary}），审批要到 M5 才做，这次先当作没批。`,
  });
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
