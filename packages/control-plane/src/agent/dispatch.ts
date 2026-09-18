import type { GroupId, Message, MessageBody, UserId } from "@baize/shared";
import type { Db } from "../db/client.js";
import { appendMessage, listGroupBots, listMessages } from "../repo/messages.js";
import { startRun } from "../repo/runs.js";
import type { PushHub } from "../ws/hub.js";
import type { AgentHub } from "./hub.js";

/** 送进 prompt 的上下文条数。规格没定，取一屏对话的量。 */
export const CONTEXT_MESSAGES = 20;

/** 一条上下文的正文上限，长消息在这里截断，prompt 不替 Bot 读全文。 */
const CONTEXT_TEXT_LIMIT = 200;

export const OFFLINE_NOTICE = "电脑不在线，消息已留着";

export type DispatchDeps = {
  readonly db: Db;
  readonly push: PushHub;
  readonly agents: AgentHub;
};

/**
 * 用户发完消息就派活。M3 只有单 Bot 群，取群里第一个成员。
 * 电脑不在线时只在群里留一句话，不建 run，免得表里堆永远不会结束的行。
 */
export async function dispatchUserMessage(
  deps: DispatchDeps,
  ownerId: UserId,
  groupId: GroupId,
  trigger: Message,
): Promise<void> {
  const [bot] = await listGroupBots(deps.db, groupId);
  if (bot === undefined) return;

  if (!deps.agents.isOnline(ownerId)) {
    await appendAndPush(deps, ownerId, groupId, { kind: "system", text: OFFLINE_NOTICE });
    return;
  }

  const context = await recentContext(deps.db, groupId, trigger, bot.name);
  const runId = await startRun(deps.db, { botId: bot.id, groupId, triggerMessageId: trigger.id });
  const sent = deps.agents.send(ownerId, {
    type: "prompt",
    runId,
    botId: bot.id,
    groupId,
    text: trigger.body.kind === "user" ? trigger.body.text : "",
    context,
    // M3 只有单 Bot 群，任务卡不给。M7 的多 Bot 群在这里带上任务卡和成员。
    task: null,
    members: [{ id: bot.id, name: bot.name }],
  });
  // 查在线和发报文之间连接掉了。run 行留着不结束，跟一次跑到一半断连是同一种痕迹。
  if (!sent) await appendAndPush(deps, ownerId, groupId, { kind: "system", text: OFFLINE_NOTICE });
}

type ContextLine = { readonly from: string; readonly text: string };

async function recentContext(db: Db, groupId: GroupId, trigger: Message, botName: string): Promise<ContextLine[]> {
  const result = await listMessages(db, groupId, { before: trigger.id, limit: CONTEXT_MESSAGES });
  if (result.kind !== "ok") return [];
  return result.page.messages.map((message) => summarize(message.body, botName));
}

/** 群里每种消息在上下文里长什么样。加一种消息就在这里加一支。 */
function summarize(body: MessageBody, botName: string): ContextLine {
  switch (body.kind) {
    case "user":
      return { from: "你", text: clip(body.text) };
    case "bot":
      return { from: botName, text: clip(body.text) };
    case "system":
      return { from: "系统", text: clip(body.text) };
    case "tool_call":
      return { from: botName, text: clip(`用了 ${body.tool}：${body.argsSummary}`) };
    case "cost":
      return { from: "系统", text: `上一次跑了 ${body.steps} 步，花了 ${body.amount}` };
    case "approval":
      return { from: "系统", text: "一条等你点头的审批" };
    case "handoff":
      return { from: "系统", text: "一条交接报文" };
  }
}

function clip(text: string): string {
  return text.length <= CONTEXT_TEXT_LIMIT ? text : `${text.slice(0, CONTEXT_TEXT_LIMIT)}…`;
}

async function appendAndPush(deps: DispatchDeps, ownerId: UserId, groupId: string, body: MessageBody): Promise<void> {
  const message = await appendMessage(deps.db, groupId, body);
  deps.push.push(ownerId, { type: "message", message });
}
