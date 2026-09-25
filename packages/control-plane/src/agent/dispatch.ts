import {
  toolViewText,
  type Approval,
  type ApprovalId,
  type AccountConfig,
  type BotId,
  type ControlToAgent,
  type GroupId,
  type Message,
  type MessageBody,
  type RunId,
  type UserId,
} from "@baize/shared";
import type { Db } from "../db/client.js";
import { decideApproval, latestPendingApproval } from "../repo/approvals.js";
import { appendMessage, listGroupBots, listMessages, messageSeq, type GroupBot } from "../repo/messages.js";
import { findChiefBotId } from "../repo/groups.js";
import { listComputers } from "../repo/computers.js";
import { startRun } from "../repo/runs.js";
import { findTaskByGroup, setCurrentBot } from "../repo/tasks.js";
import type { PushHub } from "../ws/hub.js";
import type { AgentHub } from "./hub.js";
import { selectComputer, type ComputerSelection } from "./computer-selection.js";
import { GroupTurns, type Speaker } from "./group-turn.js";
import { routeTargets } from "./routing.js";

/** 送进 prompt 的上下文条数。规格没定，取一屏对话的量。 */
export const CONTEXT_MESSAGES = 20;

/** 一条上下文的正文上限，长消息在这里截断，prompt 不替 Bot 读全文。 */
const CONTEXT_TEXT_LIMIT = 200;

export const OFFLINE_NOTICE = "电脑不在线，这条没派出去，电脑回来后再说一次";

export type DispatchDeps = {
  readonly db: Db;
  readonly push: PushHub;
  readonly agents: AgentHub;
  readonly groupTurns?: GroupTurns;
};

export type DispatchOptions = {
  /** 例行任务到点或试跑派的活带着它，往下一路传到 `startRun`。普通的用户消息不带。 */
  readonly routineRunId?: string | undefined;
};

export type DispatchOutcome = { readonly kind: "sent" } | { readonly kind: "offline" } | { readonly kind: "no_target" };

async function computerFor(
  db: Db,
  agents: AgentHub,
  ownerId: UserId,
  requiredAccounts: readonly AccountConfig[],
): Promise<ComputerSelection> {
  const computers = await listComputers(db, ownerId);
  return selectComputer(
    requiredAccounts,
    computers.map((computer) => ({
      computer: agents.isOnline(computer.id)
        ? { ...computer, status: "online" }
        : computer.status === "online"
          ? { ...computer, status: "sleeping" }
          : computer,
      accounts: [],
    })),
  );
}

/**
 * 用户发完消息就派活。路由规则本身是 routing.ts 的纯函数，这里只负责查料、改经手、发报文。
 * 电脑不在线时只在群里留一句话，不建 run，免得表里堆永远不会结束的行。
 */
export async function dispatchUserMessage(
  deps: DispatchDeps & { readonly groupTurns: GroupTurns },
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
  // 经手换了人就推一条任务卡，不然页面要等到刷新或交接才看到新经手。送出去的任务卡也要是改完经手的那份。
  let task = await findTaskByGroup(deps.db, groupId);
  if (members.length > 1 && first !== undefined && task !== null && task.currentBotId !== first) {
    task = await setCurrentBot(deps.db, groupId, first, new Date());
    if (task !== null) deps.push.push(ownerId, { type: "task_updated", task });
  }
  const chiefBotId = await findChiefBotId(deps.db, groupId);
  const targets = routeTargets({ members, chiefBotId, currentBotId: task?.currentBotId ?? null, mentions });
  if (targets.length === 0) return { kind: "no_target" };

  const reason =
    members.length === 1
      ? "solo"
      : mentions.length > 0
        ? "mentioned"
        : chiefBotId !== null
          ? "chief"
          : task?.currentBotId !== null && task?.currentBotId !== undefined
            ? "current"
            : "everyone";
  const selected = await computerFor(deps.db, deps.agents, ownerId, []);
  if (selected.kind === "failed") {
    await appendAndPush(deps, ownerId, groupId, { kind: "system", tone: "error", text: OFFLINE_NOTICE });
    return { kind: "offline" };
  }
  await deps.groupTurns.start({
    groupId,
    ownerId,
    epoch: await messageSeq(deps.db, trigger.id),
    members,
    speakers: targets.map((botId) => ({ botId, trigger, reason })),
    send: (speaker, includeRecent) => sendSpeaker(deps, ownerId, groupId, members, speaker, includeRecent, options),
  });
  return { kind: "sent" };
}

type PromptOrigin = Extract<ControlToAgent, { type: "prompt" }>["origin"];

/** 发信 Bot 已经不在群里时退回 user：报文是它留下的，但没有名字可署。 */
function botOrigin(members: readonly GroupBot[], botId: BotId): PromptOrigin {
  const bot = members.find((member) => member.id === botId);
  return bot === undefined ? { kind: "user" } : { kind: "bot", id: bot.id, name: bot.name, tag: bot.tag };
}

async function sendSpeaker(
  deps: DispatchDeps,
  ownerId: UserId,
  groupId: GroupId,
  members: readonly GroupBot[],
  speaker: Speaker,
  includeRecent: boolean,
  options: DispatchOptions,
): Promise<RunId | null> {
  const selected = await computerFor(deps.db, deps.agents, ownerId, []);
  if (selected.kind === "failed") {
    await appendAndPush(deps, ownerId, groupId, { kind: "system", tone: "error", text: OFFLINE_NOTICE });
    return null;
  }

  const history = await recentBodies(deps.db, groupId, speaker.trigger, includeRecent);
  const chiefBotId = await findChiefBotId(deps.db, groupId);
  const task = await findTaskByGroup(deps.db, groupId);
  const roster = members.map(({ id, name, tag, description }) => ({
    id,
    name,
    tag,
    description,
    seat: id === chiefBotId ? ("chief" as const) : ("member" as const),
  }));
  const group = {
    id: groupId,
    number: task?.number ?? "",
    title: task?.title ?? "",
    kind: members.length > 1 ? ("team" as const) : ("solo" as const),
  };
  const runId = await startRun(deps.db, {
    ownerId,
    computerId: selected.computer.id,
    botId: speaker.botId,
    groupId,
    triggerMessageId: speaker.trigger.id,
    routineRunId: options.routineRunId,
  });
  const origin: PromptOrigin =
    speaker.handoff !== undefined
      ? botOrigin(members, speaker.handoff.fromBotId)
      : speaker.trigger.body.kind === "bot"
        ? botOrigin(members, speaker.trigger.body.botId)
        : { kind: options.routineRunId === undefined ? "user" : "routine" };
  const sent = deps.agents.send(selected.computer.id, {
    type: "prompt",
    runId,
    botId: speaker.botId,
    groupId,
    text: speaker.handoff?.text ?? triggerText(speaker.trigger.body),
    origin,
    reason: speaker.reason,
    group,
    context: history.flatMap((message) => {
      const line = summarize(message, speaker.botId, members);
      return line === null ? [] : [line];
    }),
    purpose: "plan",
    task: members.length > 1 ? task : null,
    members: roster,
    ...(speaker.handoff === undefined ? {} : { handoffId: speaker.handoff.id }),
  });
  if (!sent) {
    await appendAndPush(deps, ownerId, groupId, { kind: "system", tone: "error", text: OFFLINE_NOTICE });
    return null;
  }
  return runId;
}

function triggerText(body: MessageBody): string {
  if (body.kind === "user") return body.text;
  return body.kind === "bot" ? body.text : "";
}

type ContextLine = { readonly messageId: Message["id"]; readonly from: string; readonly text: string };

async function recentBodies(db: Db, groupId: GroupId, trigger: Message, includeRecent: boolean): Promise<Message[]> {
  const result = await listMessages(db, groupId, {
    ...(includeRecent ? {} : { before: trigger.id }),
    limit: CONTEXT_MESSAGES,
  });
  if (result.kind !== "ok") return [];
  return result.page.messages.filter((message) => message.id !== trigger.id);
}

/** 群里每种消息在上下文里长什么样。加一种消息就在这里加一支。任务卡不进上下文，它走 prompt 的 task 字段。 */
function summarize(message: Message, recipient: BotId, members: readonly GroupBot[]): ContextLine | null {
  const body = message.body;
  const line = (from: string, text: string): ContextLine => ({ messageId: message.id, from, text });
  switch (body.kind) {
    case "user":
      return line("你", clip(body.text));
    case "bot":
      return line(sender(body.botId, recipient, members), clip(body.text));
    case "system":
      return line("系统", clip(body.text));
    case "tool_call":
      return line(sender(body.botId, recipient, members), clip(toolViewText(body.view)));
    case "cost":
      return null;
    case "approval":
      return line("系统", "一条等你点头的审批");
    case "handoff":
      return line("系统", "一条交接报文");
    case "skill_offer":
      return line("系统", `问过要不要存成 skill「${body.name}」`);
    case "project_offer":
    case "draft":
    case "plan":
      return null;
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

  if (decided.computerId !== null)
    deps.agents.send(decided.computerId, {
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
