import type {
  Approval,
  ApprovalId,
  BotId,
  GroupId,
  HandoffId,
  Message,
  MessageBody,
  TopicTask,
  UserId,
} from "@baize/shared";
import type { Db } from "../db/client.js";
import { decideApproval, latestPendingApproval } from "../repo/approvals.js";
import { appendMessage, listGroupBots, listMessages, type GroupBot } from "../repo/messages.js";
import { startRun } from "../repo/runs.js";
import { findTaskByGroup, setCurrentBot } from "../repo/tasks.js";
import type { PushHub } from "../ws/hub.js";
import type { AgentHub } from "./hub.js";
import type { MentionLoopGuard } from "./mention-loop.js";
import { routeTargets } from "./routing.js";

/** 送进 prompt 的上下文条数。规格没定，取一屏对话的量。 */
export const CONTEXT_MESSAGES = 20;

/** 一条上下文的正文上限，长消息在这里截断，prompt 不替 Bot 读全文。 */
const CONTEXT_TEXT_LIMIT = 200;

export const OFFLINE_NOTICE = "电脑不在线，消息已留着";
export const NO_TARGET_NOTICE = "@ 一个 Bot 派活";
export const MENTION_LOOP_NOTICE = "Bot 之间 @ 太多次，停下等你";
export const HANDOFF_LOOP_NOTICE = "Bot 之间交接太多次，停下等你";

export type DispatchDeps = {
  readonly db: Db;
  readonly push: PushHub;
  readonly agents: AgentHub;
};

export type DispatchOptions = {
  /** 例行任务到点或试跑派的活带着它，往下一路传到 `startRun`。普通的用户消息不带。 */
  readonly routineRunId?: string | undefined;
};

export type DispatchOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "offline" }
  | { readonly kind: "no_target" }
  | { readonly kind: "partial" };

/**
 * 用户发完消息就派活。路由规则本身是 routing.ts 的纯函数，这里只负责查料、改经手、发报文。
 * 电脑不在线时只在群里留一句话，不建 run，免得表里堆永远不会结束的行。
 */
export async function dispatchUserMessage(
  deps: DispatchDeps,
  ownerId: UserId,
  groupId: GroupId,
  trigger: Message,
  options: DispatchOptions = {},
): Promise<DispatchOutcome> {
  const members = await listGroupBots(deps.db, groupId);
  if (members.length === 0) return { kind: "no_target" };

  const mentions = trigger.body.kind === "user" ? (trigger.body.mentions ?? []) : [];
  const [first] = mentions;
  // @ 了好几个也只认第一个当经手。单 Bot 群没有经手可言，它的任务卡也不出边界。
  if (members.length > 1 && first !== undefined) await setCurrentBot(deps.db, groupId, first, new Date());

  // 排在改经手之后：送出去的任务卡要是改完经手的那份。
  const task = await findTaskByGroup(deps.db, groupId);
  const targets = routeTargets({ members, currentBotId: task?.currentBotId ?? null, mentions });
  // 排在在线检查之前：没人可派的时候「@ 一个 Bot 派活」比「电脑不在线」有用。
  if (targets.length === 0) {
    await appendAndPush(deps, ownerId, groupId, { kind: "system", text: NO_TARGET_NOTICE });
    return { kind: "no_target" };
  }

  return sendToTargets(deps, ownerId, groupId, { trigger, members, targets, task, ...options });
}

/** Bot @ 群里另一个 Bot。目标是报文点名的那一个，当前经手一个字不改：接力是 Bot 之间的事，不是用户交出去的。 */
export async function dispatchBotMention(
  deps: DispatchDeps,
  ownerId: UserId,
  groupId: GroupId,
  trigger: Message,
  targetBotId: BotId,
): Promise<void> {
  const members = await listGroupBots(deps.db, groupId);
  if (members.length === 0) return;

  const task = await findTaskByGroup(deps.db, groupId);
  const targets = routeTargets({ members, currentBotId: task?.currentBotId ?? null, mentions: [targetBotId] });
  if (targets.length === 0) return;

  await sendToTargets(deps, ownerId, groupId, { trigger, members, targets, task });
}

export type HandoffDispatch = {
  /** 群里那张交接卡。上下文取它之前那些，run 也挂在它上面。 */
  readonly trigger: Message;
  readonly targetBotId: BotId;
  readonly handoffId: HandoffId;
  /** 交接报文渲染出来的正文，当作这条 prompt 的正文发下去。 */
  readonly text: string;
};

/**
 * 把活派给交接的目标。目标由报文点名，不走当前经手：确认之前当前经手还是交出去的那一个。
 * prompt 带上 handoffId，运行器据此才开出 accept_handoff。
 */
export async function dispatchHandoff(
  deps: DispatchDeps & { readonly mentionLoop: MentionLoopGuard },
  ownerId: UserId,
  groupId: GroupId,
  input: HandoffDispatch,
): Promise<void> {
  switch (deps.mentionLoop.record(groupId)) {
    case "allow":
      break;
    case "stop":
      await appendAndPush(deps, ownerId, groupId, { kind: "system", text: HANDOFF_LOOP_NOTICE });
      return;
    case "silent":
      return;
  }

  const members = await listGroupBots(deps.db, groupId);
  const task = await findTaskByGroup(deps.db, groupId);
  const targets = routeTargets({ members, currentBotId: task?.currentBotId ?? null, mentions: [input.targetBotId] });
  if (targets.length === 0) return;

  await sendToTargets(deps, ownerId, groupId, {
    trigger: input.trigger,
    members,
    targets,
    task,
    handoff: { id: input.handoffId, text: input.text },
  });
}

type SendInput = {
  readonly trigger: Message;
  readonly members: readonly GroupBot[];
  readonly targets: readonly BotId[];
  readonly task: TopicTask | null;
  /** 只有交接派活带它：正文换成交接报文，报文编号跟着下去。 */
  readonly handoff?: { readonly id: HandoffId; readonly text: string } | undefined;
  readonly routineRunId?: string | undefined;
};

/** 每个目标各起一个 run、各发一条 prompt。上下文按收件人分别生成，所以署名在每个人眼里都对。 */
async function sendToTargets(
  deps: DispatchDeps,
  ownerId: UserId,
  groupId: GroupId,
  input: SendInput,
): Promise<Exclude<DispatchOutcome, { kind: "no_target" }>> {
  if (!deps.agents.isOnline(ownerId)) {
    await appendAndPush(deps, ownerId, groupId, { kind: "system", text: OFFLINE_NOTICE });
    return { kind: "offline" };
  }

  const history = await recentBodies(deps.db, groupId, input.trigger);
  const roster = input.members.map((member) => ({ id: member.id, name: member.name }));
  let dropped = false;
  let sentCount = 0;
  for (const target of input.targets) {
    const runId = await startRun(deps.db, {
      ownerId,
      botId: target,
      groupId,
      triggerMessageId: input.trigger.id,
      routineRunId: input.routineRunId,
    });
    const sent = deps.agents.send(ownerId, {
      type: "prompt",
      runId,
      botId: target,
      groupId,
      text: input.handoff?.text ?? triggerText(input.trigger.body),
      context: history.map((body) => summarize(body, target, input.members)),
      // 单 Bot 群没有任务卡可给，protocol.ts 就是这么定的。
      task: input.members.length > 1 ? input.task : null,
      members: roster,
      // handoffId 可省，恒带一个 undefined 在 exactOptionalPropertyTypes 下不是同一件事。
      ...(input.handoff === undefined ? {} : { handoffId: input.handoff.id }),
    });
    if (sent) sentCount += 1;
    else dropped = true;
  }
  // 查在线和发报文之间连接掉了。run 行留着不结束，跟一次跑到一半断连是同一种痕迹。
  // 几个目标一起没发出去也只留一句话：断的是同一条连接，说一遍就够。
  if (dropped) {
    await appendAndPush(deps, ownerId, groupId, { kind: "system", text: OFFLINE_NOTICE });
    return sentCount > 0 ? { kind: "partial" } : { kind: "offline" };
  }
  return { kind: "sent" };
}

function triggerText(body: MessageBody): string {
  if (body.kind === "user") return body.text;
  return body.kind === "bot" ? body.text : "";
}

type ContextLine = { readonly from: string; readonly text: string };

async function recentBodies(db: Db, groupId: GroupId, trigger: Message): Promise<MessageBody[]> {
  const result = await listMessages(db, groupId, { before: trigger.id, limit: CONTEXT_MESSAGES });
  if (result.kind !== "ok") return [];
  return result.page.messages.map((message) => message.body);
}

/** 群里每种消息在上下文里长什么样。加一种消息就在这里加一支。任务卡不进上下文，它走 prompt 的 task 字段。 */
function summarize(body: MessageBody, recipient: BotId, members: readonly GroupBot[]): ContextLine {
  switch (body.kind) {
    case "user":
      return { from: "你", text: clip(body.text) };
    case "bot":
      return { from: sender(body.botId, recipient, members), text: clip(body.text) };
    case "system":
      return { from: "系统", text: clip(body.text) };
    case "tool_call":
      return { from: sender(body.botId, recipient, members), text: clip(`用了 ${body.tool}：${body.argsSummary}`) };
    case "cost":
      return { from: "系统", text: `上一次跑了 ${body.steps} 步，花了 ${body.amount}` };
    case "approval":
      return { from: "系统", text: "一条等你点头的审批" };
    case "handoff":
      return { from: "系统", text: "一条交接报文" };
    case "skill_offer":
      return { from: "系统", text: `问过要不要存成 skill「${body.name}」` };
  }
}

/** 收件人看自己只看到自己的名字，看别人带上 tag 才分得清同名的两位。 */
function sender(botId: BotId, recipient: BotId, members: readonly GroupBot[]): string {
  const member = members.find((one) => one.id === botId);
  if (member === undefined) return "别的 Bot";
  if (member.id === recipient) return member.name;
  return member.tag === "" ? member.name : `${member.name} · ${member.tag}`;
}

function clip(text: string): string {
  return text.length <= CONTEXT_TEXT_LIMIT ? text : `${text.slice(0, CONTEXT_TEXT_LIMIT)}…`;
}

async function appendAndPush(deps: DispatchDeps, ownerId: UserId, groupId: string, body: MessageBody): Promise<void> {
  const message = await appendMessage(deps.db, groupId, body);
  deps.push.push(ownerId, { type: "message", message });
}

/** 群里回这四个词等于按了审批卡上的按钮。 */
const REPLY_DECISIONS = new Map<string, "approved" | "rejected">([
  ["批准", "approved"],
  ["同意", "approved"],
  ["拒绝", "rejected"],
  ["不行", "rejected"],
]);

export type SettleResult = { readonly kind: "ok"; readonly approval: Approval } | { readonly kind: "already_decided" };

/**
 * 给一条审批定结论、告诉电脑、推给客户端。按钮和群里回话共用这一份。
 * 电脑不在线时 send 返回 false，决定照样落库：运行器那一头本来就已经断了，等它回来是另一件事。
 */
export async function settleApproval(
  deps: DispatchDeps,
  ownerId: UserId,
  approvalId: ApprovalId,
  decision: "approved" | "rejected",
): Promise<SettleResult> {
  const decided = await decideApproval(deps.db, approvalId, decision);
  if (decided === null) return { kind: "already_decided" };

  deps.agents.send(ownerId, {
    type: "approval_result",
    runId: decided.runId,
    callId: decided.callId,
    approved: decision === "approved",
  });
  deps.push.push(ownerId, { type: "approval_updated", approval: decided.approval });
  return { kind: "ok", approval: decided.approval };
}

/**
 * 用户消息落到该群最近一条待批审批上。返回真表示这条消息已经当作审批回复用掉了，
 * 不再派活：运行器正挂着等结论，再派一次会并发起第二个 run。
 * 群里没有待批审批时「批准」就是一句普通话。
 */
export async function settleByReply(
  deps: DispatchDeps,
  ownerId: UserId,
  groupId: string,
  text: string,
): Promise<boolean> {
  const decision = REPLY_DECISIONS.get(text.trim());
  if (decision === undefined) return false;
  const pending = await latestPendingApproval(deps.db, groupId);
  if (pending === null) return false;
  await settleApproval(deps, ownerId, pending, decision);
  return true;
}
