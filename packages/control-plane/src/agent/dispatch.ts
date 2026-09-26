import {
  toolViewText,
  type Approval,
  type ApprovalId,
  type AccountId,
  type BotId,
  type Computer,
  type ContentPlan,
  type ContentPlanId,
  type ControlToAgent,
  type DecideApprovalRequest,
  type Draft,
  type DraftId,
  type Grant,
  type GroupId,
  type Handoff,
  type HandoffId,
  type Message,
  type MessageBody,
  type ModelPurpose,
  type RunId,
  type UserId,
} from "@baize/shared";
import type { Db } from "../db/client.js";
import { decideApproval, latestPendingApproval, listApprovals } from "../repo/approvals.js";
import { listAccounts } from "../repo/accounts.js";
import { PUBLISHING_TIERS, listDraftsForPage, listPlansForPage } from "../repo/drafts.js";
import { listHandoffs } from "../repo/handoffs.js";
import { appendMessage, listGroupBots, listMessages, messageSeq, type GroupBot } from "../repo/messages.js";
import { findChiefBotId } from "../repo/groups.js";
import { listComputers } from "../repo/computers.js";
import { startRun } from "../repo/runs.js";
import { findTaskByGroup, listProjects, setCurrentBot } from "../repo/tasks.js";
import { PLATFORM_LABEL, titleOf } from "../publish/settle.js";
import type { PushHub } from "../ws/hub.js";
import type { AgentHub } from "./hub.js";
import {
  selectComputer,
  selectionNotice,
  type ComputerSelection,
  type SelectionFailure,
} from "./computer-selection.js";
import { GroupTurns, type Speaker } from "./group-turn.js";
import { routeTargets } from "./routing.js";

/** 送进 prompt 的上下文条数。规格没定，取一屏对话的量。 */
export const CONTEXT_MESSAGES = 20;

/** 一条上下文的正文上限，长消息在这里截断，prompt 不替 Bot 读全文。 */
const CONTEXT_TEXT_LIMIT = 200;

export type DispatchDeps = {
  readonly db: Db;
  readonly push: PushHub;
  readonly agents: AgentHub;
  readonly groupTurns?: GroupTurns;
};

export type DispatchOptions = {
  /** 例行任务到点或试跑派的活带着它，往下一路传到 `startRun`。普通的用户消息不带。 */
  readonly routineRunId?: string | undefined;
  /** 例行任务按保存的用途选模型；普通消息不带，固定走 plan。 */
  readonly purpose?: ModelPurpose | undefined;
};

export type DispatchOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "unplaced"; readonly reason: SelectionFailure }
  | { readonly kind: "no_target" };

/** 这一版派活不要求账号，候选电脑也就不带账号，理由见 README「派到哪台电脑」。 */
async function computerFor(db: Db, agents: AgentHub, ownerId: UserId): Promise<ComputerSelection> {
  const computers = await listComputers(db, ownerId);
  return selectComputer(
    [],
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
 * 选不到电脑时只在群里留一句为什么，不建 run，免得表里堆永远不会结束的行。
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
  const selected = await computerFor(deps.db, deps.agents, ownerId);
  if (selected.kind === "failed") {
    await appendAndPush(deps, ownerId, groupId, {
      kind: "system",
      tone: "error",
      text: selectionNotice(selected.reason),
    });
    return { kind: "unplaced", reason: selected.reason };
  }
  // 头一个 speaker 就用这次选中的电脑。再选一次的话，两次之间掉线会让它不建 run 就派空，
  // 这里却已经报了 sent，例行就一直停在运行中。后面的 speaker 要等前一个跑完才派，到时再选。
  let placed: Computer | null = selected.computer;
  await deps.groupTurns.start({
    groupId,
    ownerId,
    epoch: await messageSeq(deps.db, trigger.id),
    members,
    speakers: targets.map((botId) => ({ botId, trigger, reason })),
    send: (speaker, includeRecent) => {
      const computer = placed;
      placed = null;
      return sendSpeaker(deps, ownerId, groupId, members, speaker, includeRecent, options, computer);
    },
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
  placed: Computer | null,
): Promise<RunId | null> {
  const selected: ComputerSelection =
    placed === null ? await computerFor(deps.db, deps.agents, ownerId) : { kind: "selected", computer: placed };
  if (selected.kind === "failed") {
    await appendAndPush(deps, ownerId, groupId, {
      kind: "system",
      tone: "error",
      text: selectionNotice(selected.reason),
    });
    return null;
  }

  const history = await recentBodies(deps.db, groupId, speaker.trigger, includeRecent);
  const context = await summarizeAll(deps.db, ownerId, history, speaker.botId, members);
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
  // 只有主助理拿项目清单，它才能把一句「下周多发点小红书」落到某个项目的节奏上。
  const speakerRole = members.find((member) => member.id === speaker.botId)?.role;
  const projects = speakerRole === "assistant" ? await listProjects(deps.db, ownerId) : undefined;
  const sent = deps.agents.send(selected.computer.id, {
    type: "prompt",
    runId,
    botId: speaker.botId,
    groupId,
    messageId: speaker.trigger.id,
    text: speaker.handoff?.text ?? triggerText(speaker.trigger.body),
    origin,
    reason: speaker.reason,
    group,
    context,
    purpose: options.purpose ?? "plan",
    task: members.length > 1 ? task : null,
    members: roster,
    ...(projects === undefined ? {} : { projects }),
    ...(speaker.handoff === undefined ? {} : { handoffId: speaker.handoff.id }),
  });
  if (!sent) {
    await appendAndPush(deps, ownerId, groupId, {
      kind: "system",
      tone: "error",
      text: selectionNotice("no_computer_online"),
    });
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

/** 上下文里的卡指向的那些行。卡正文只有 id，状态住在行上。 */
type CardRows = {
  readonly approvals: ReadonlyMap<ApprovalId, Approval>;
  readonly handoffs: ReadonlyMap<HandoffId, Handoff>;
  readonly drafts: ReadonlyMap<DraftId, Draft>;
  readonly plans: ReadonlyMap<ContentPlanId, ContentPlan>;
  /** 档位能自动发的账号。草稿批了之后等不等着发看它。 */
  readonly publishingAccounts: ReadonlySet<AccountId>;
};

function byId<K, T extends { readonly id: K }>(rows: readonly T[]): ReadonlyMap<K, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

/** 这一批上下文涉及的卡每种一次查完，再逐条写成一句。 */
async function summarizeAll(
  db: Db,
  ownerId: UserId,
  messages: readonly Message[],
  recipient: BotId,
  members: readonly GroupBot[],
): Promise<ContextLine[]> {
  const bodies = messages.map((message) => message.body);
  const draftIds = bodies.flatMap((body) => (body.kind === "draft" ? [body.draftId] : []));
  const [approvals, handoffs, drafts, plans, accounts] = await Promise.all([
    listApprovals(
      db,
      bodies.flatMap((body) => (body.kind === "approval" ? [body.approvalId] : [])),
    ),
    listHandoffs(
      db,
      bodies.flatMap((body) => (body.kind === "handoff" ? [body.handoffId] : [])),
    ),
    listDraftsForPage(db, ownerId, draftIds, []),
    listPlansForPage(
      db,
      ownerId,
      bodies.flatMap((body) => (body.kind === "plan" ? [body.planId] : [])),
    ),
    draftIds.length === 0 ? [] : listAccounts(db, ownerId),
  ]);
  const cards: CardRows = {
    approvals: byId(approvals),
    handoffs: byId(handoffs),
    drafts: byId(drafts),
    plans: byId(plans),
    publishingAccounts: new Set(
      accounts.filter(({ tier }) => PUBLISHING_TIERS.some((one) => one === tier)).map(({ id }) => id),
    ),
  };
  return messages.flatMap((message) => {
    const line = summarize(message, cards, recipient, members);
    return line === null ? [] : [line];
  });
}

const APPROVAL_OUTCOME: Record<Approval["status"], string> = {
  pending: "还在等你点头",
  approved: "你批准了",
  rejected: "你拒绝了",
  expired: "没批下来，过期了",
};

const HANDOFF_OUTCOME: Record<Handoff["status"], (to: string) => string> = {
  pending: (to) => `交接还在等${to}接`,
  accepted: (to) => `${to}接了`,
};

const DRAFT_OUTCOME: Record<Draft["status"], (publishes: boolean) => string> = {
  pending: () => "还在等你看",
  approved: (publishes) => (publishes ? "你批准了，等着发" : "你批准了，留着没发"),
  publishing: () => "正在发",
  published: () => "已经发出去了",
  returned: () => "你退回了",
  failed: () => "没发出去",
};

const PLAN_OUTCOME: Record<ContentPlan["status"], string> = {
  pending: "还在等你看",
  approved: "你批准了",
  returned: "你退回了",
};

const SKILL_OFFER_OUTCOME: Record<Extract<MessageBody, { kind: "skill_offer" }>["status"], string> = {
  offered: "还在等你定",
  saved: "你存了",
  dismissed: "你没存",
};

const PROJECT_OFFER_OUTCOME: Record<Extract<MessageBody, { kind: "project_offer" }>["status"], string> = {
  offered: "还在等你点开始",
  started: "你点了开始，项目群建好了",
  dismissed: "你没要",
};

/**
 * 群里每种消息在上下文里长什么样。加一种消息就在这里加一支。任务卡不进上下文，它走 prompt 的 task 字段。
 * 卡写成「谁做了什么，现在怎样」一句结论；卡指的行查不到就不写，免得说错状态。
 */
function summarize(
  message: Message,
  cards: CardRows,
  recipient: BotId,
  members: readonly GroupBot[],
): ContextLine | null {
  const body = message.body;
  const line = (from: string, text: string): ContextLine => ({ messageId: message.id, from, text });
  const who = (botId: BotId | null) => sender(botId, recipient, members);
  switch (body.kind) {
    case "user":
      return line("你", clip(body.text));
    case "bot":
      return line(who(body.botId), clip(body.text));
    case "system":
      return line("系统", clip(body.text));
    case "tool_call":
      return line(who(body.botId), clip(toolViewText(body.view)));
    case "cost":
      return null;
    case "approval": {
      const approval = cards.approvals.get(body.approvalId);
      if (approval === undefined) return null;
      return line(
        "系统",
        `${who(approval.botId)}${clip(toolViewText(approval.view))}，${APPROVAL_OUTCOME[approval.status]}`,
      );
    }
    case "handoff": {
      const handoff = cards.handoffs.get(body.handoffId);
      if (handoff === undefined) return null;
      const to = who(handoff.toBotId);
      return line(
        "系统",
        `${who(handoff.fromBotId)}把活交给${to}，下一步是「${clip(handoff.next)}」，${HANDOFF_OUTCOME[handoff.status](to)}`,
      );
    }
    case "draft": {
      const draft = cards.drafts.get(body.draftId);
      if (draft === undefined) return null;
      const noun = draft.content.kind === "reply" ? "回复" : "草稿";
      return line(
        "系统",
        `${who(draft.botId)}起草的${noun}「${titleOf(draft)}」（${PLATFORM_LABEL[draft.platform]}），${DRAFT_OUTCOME[draft.status](cards.publishingAccounts.has(draft.accountId))}`,
      );
    }
    case "plan": {
      const plan = cards.plans.get(body.planId);
      if (plan === undefined) return null;
      return line(
        "系统",
        `${who(plan.botId)}排的内容计划「${plan.title}」共 ${plan.draftIds.length} 篇，${PLAN_OUTCOME[plan.status]}`,
      );
    }
    case "skill_offer":
      return line("系统", `问过要不要存成 skill「${body.name}」，${SKILL_OFFER_OUTCOME[body.status]}`);
    case "project_offer":
      return line("系统", `${who(body.botId)}出的方案卡「${body.name}」，${PROJECT_OFFER_OUTCOME[body.status]}`);
  }
}

/** 收件人看自己只看到自己的名字，看别人带上 tag 才分得清同名的两位。 */
function sender(botId: BotId | null, recipient: BotId, members: readonly GroupBot[]): string {
  const member = botId === null ? undefined : members.find((one) => one.id === botId);
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

/** 群里回这四个词等于按了审批卡上的按钮。回话没法选范围，批准一律只批这一次。 */
const REPLY_DECISIONS = new Map<string, DecideApprovalRequest>([
  ["批准", { decision: "approved", scope: "once" }],
  ["同意", { decision: "approved", scope: "once" }],
  ["拒绝", { decision: "rejected" }],
  ["不行", { decision: "rejected" }],
]);

export type SettleResult =
  | { readonly kind: "ok"; readonly approval: Approval; readonly grant: Grant | null }
  | { readonly kind: "already_decided" }
  | { readonly kind: "scope_not_allowed"; readonly error: string };

/**
 * 给一条审批定结论、告诉电脑、推给客户端。按钮和群里回话共用这一份。
 * 落了授权就先重发 config 再放行：运行器放行之后紧接着的同类调用要看到这条授权，否则还会再问一次。
 * 电脑不在线时 send 返回 false，决定照样落库：运行器那一头本来就已经断了，等它回来是另一件事。
 */
export async function settleApproval(
  deps: DispatchDeps,
  ownerId: UserId,
  approvalId: ApprovalId,
  request: DecideApprovalRequest,
): Promise<SettleResult> {
  const outcome = await decideApproval(deps.db, ownerId, approvalId, request);
  if (outcome.kind !== "decided") return outcome;
  const { decided } = outcome;

  if (decided.grant !== null) await deps.agents.sendConfig(ownerId);
  if (decided.computerId !== null)
    deps.agents.send(decided.computerId, {
      type: "approval_result",
      runId: decided.runId,
      callId: decided.callId,
      approved: request.decision === "approved",
    });
  deps.push.push(ownerId, { type: "approval_updated", approval: decided.approval });
  return { kind: "ok", approval: decided.approval, grant: decided.grant };
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
