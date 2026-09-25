import {
  GroupId,
  type AgentToControl,
  type BotId,
  type Message,
  type MessageBody,
  type RunId,
  type UserId,
} from "@baize/shared";
import type { Db } from "../db/client.js";
import { approvalRun, createApproval, expireApproval } from "../repo/approvals.js";
import { markComputerOnline } from "../repo/computers.js";
import { acceptHandoff, createHandoff } from "../repo/handoffs.js";
import { findChiefBotId, findGroup, setChiefBotId } from "../repo/groups.js";
import {
  appendBotDelta,
  appendMessage,
  appendMessageWithId,
  appendSkillOffer,
  failRunningToolCalls,
  findGroupId,
  listGroupBots,
  replaceMessageBody,
} from "../repo/messages.js";
import { routineRunOfRun } from "../repo/routines.js";
import { finishRun, latestOpenRun, runBelongsTo } from "../repo/runs.js";
import { findTaskByGroup, replaceChecklist, setCurrentBot } from "../repo/tasks.js";
import { chargeRoutineRunOf, EXPIRED_APPROVAL_NOTE, failRoutineRunOf, holdRoutineRunOf } from "../routines/run.js";
import type { PushHub } from "../ws/hub.js";
import { HANDOFF_LIMIT_NOTICE, type GroupTurns } from "./group-turn.js";
import { renderHandoffReport } from "./handoff.js";
import type { AgentHub, AgentConnection } from "./hub.js";

export type AgentEventDeps = {
  readonly db: Db;
  readonly push: PushHub;
  readonly agents: AgentHub;
  readonly groupTurns: GroupTurns;
  readonly priceInputPerM: number;
  readonly priceOutputPerM: number;
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
    case "approval_abandoned":
      await onApprovalAbandoned(deps, conn, message);
      return;
    case "task_checklist":
      await onTaskChecklist(deps, conn, message);
      return;
    case "mention":
      await onMention(deps, conn, message);
      return;
    case "skill_offer":
      await onSkillOffer(deps, conn, message);
      return;
    case "handoff":
      await onHandoff(deps, conn, message);
      return;
    case "handoff_accept":
      await onHandoffAccept(deps, conn, message);
      return;
    case "set_chief":
      await onSetChief(deps, conn, message);
      return;
  }
}

/** 群要是这台电脑主人的，run 要是这个 Bot 在这个群里的。任一不成立整条丢掉。 */
async function resolveRun(
  deps: AgentEventDeps,
  conn: AgentConnection,
  event: { readonly runId: RunId; readonly botId: BotId; readonly groupId: GroupId },
): Promise<GroupId | null> {
  // 报文里的群号是外部输入，findGroupId 按归属人过滤，不是这台电脑主人的群整条丢掉。
  const groupId = await findGroupId(deps.db, conn.ownerId, event.groupId);
  if (groupId === null) return null;
  // 外键只保证 runId 存在，管不了它指到哪个群：不校的话一个被入侵的电脑代理能拿自己的 runId 往自己另一个群插卡。
  if (await runBelongsTo(deps.db, event.runId, event.botId, groupId, conn.computerId)) return GroupId.parse(groupId);
  console.warn(`电脑 ${conn.computerId} 报的 run ${event.runId} 不是它在群 ${event.groupId} 里的活，整条丢掉`);
  return null;
}

type BotText = Extract<AgentToControl, { type: "bot_text" }>;
type ToolCall = Extract<AgentToControl, { type: "bot_tool_call" }>;
type RunDone = Extract<AgentToControl, { type: "run_done" }>;
type AgentError = Extract<AgentToControl, { type: "agent_error" }>;
type ApprovalRequest = Extract<AgentToControl, { type: "approval_request" }>;
type ApprovalAbandoned = Extract<AgentToControl, { type: "approval_abandoned" }>;
type TaskChecklist = Extract<AgentToControl, { type: "task_checklist" }>;
type Mention = Extract<AgentToControl, { type: "mention" }>;
type SkillOffer = Extract<AgentToControl, { type: "skill_offer" }>;
type HandoffEvent = Extract<AgentToControl, { type: "handoff" }>;
type HandoffAcceptEvent = Extract<AgentToControl, { type: "handoff_accept" }>;
type SetChiefEvent = Extract<AgentToControl, { type: "set_chief" }>;

type TextPrefix =
  | { readonly kind: "buffering"; readonly text: string; readonly runId: RunId }
  | { readonly kind: "pass"; readonly runId: RunId }
  | { readonly kind: "visible"; readonly runId: RunId };
const textPrefixes = new Map<string, TextPrefix>();

export function clearTextPrefixes(runId: RunId): void {
  for (const [messageId, prefix] of textPrefixes) if (prefix.runId === runId) textPrefixes.delete(messageId);
}

async function onBotText(deps: AgentEventDeps, conn: AgentConnection, event: BotText): Promise<void> {
  const groupId = await resolveRun(deps, conn, event);
  if (groupId === null) return;
  if (deps.groupTurns.isBlocked(event.runId)) return;

  const previous = textPrefixes.get(event.messageId);
  if (previous?.kind === "pass") return;
  let delta = event.delta;
  if (previous === undefined || previous.kind === "buffering") {
    delta = (previous?.text ?? "") + event.delta;
    if (delta.length < 6 && !event.done) {
      textPrefixes.set(event.messageId, { kind: "buffering", text: delta, runId: event.runId });
      return;
    }
    if (delta.startsWith("(pass)") || delta.startsWith("（pass）")) {
      textPrefixes.set(event.messageId, { kind: "pass", runId: event.runId });
      return;
    }
    textPrefixes.set(event.messageId, { kind: "visible", runId: event.runId });
  }

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

  const updated = await appendBotDelta(deps.db, event.messageId, groupId, delta, event.done);
  deps.push.push(conn.ownerId, {
    type: "message_delta",
    messageId: event.messageId,
    groupId: event.groupId,
    delta,
    done: event.done,
  });
  if (event.done && updated !== null) await deps.groupTurns.recordBotMessage(groupId, event.runId, updated);
}

async function onToolCall(deps: AgentEventDeps, conn: AgentConnection, event: ToolCall): Promise<void> {
  const groupId = await resolveRun(deps, conn, event);
  if (groupId === null) return;

  const body = {
    kind: "tool_call",
    runId: event.runId,
    botId: event.botId,
    tool: event.tool,
    view: event.view,
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
  const groupId = await resolveRun(deps, conn, event);
  if (groupId === null) return;

  const amount =
    (event.inputTokens / 1_000_000) * deps.priceInputPerM + (event.outputTokens / 1_000_000) * deps.priceOutputPerM;
  const finished = await deps.db.transaction(async (tx) => {
    const usage = await finishRun(tx, event.runId, event.groupId, {
      steps: event.steps,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      amount,
    });
    if (usage === null) return null;
    return { usage, failedTools: await failRunningToolCalls(tx, event.groupId, event.runId) };
  });
  // 重复的 runId 和不认识的 runId 在这里都是 null，不再多记一行也不再多一张花费卡。
  if (finished === null) return;
  const { usage } = finished;
  for (const message of finished.failedTools) deps.push.push(conn.ownerId, { type: "message", message });

  const passed = runPassed(event.runId);
  clearTextPrefixes(event.runId);
  if (passed) {
    const absorbed = deps.groupTurns.absorbPassCost(groupId, event.runId, {
      steps: usage.steps,
      amount: usage.amount,
      botId: event.botId,
    });
    if (absorbed.kind === "merged") {
      const updated = await replaceMessageBody(deps.db, absorbed.cost.messageId, groupId, {
        kind: "cost",
        runId: absorbed.cost.runId,
        botId: absorbed.cost.botId,
        steps: absorbed.cost.steps,
        amount: absorbed.cost.amount,
      });
      if (updated !== null) deps.push.push(conn.ownerId, { type: "message", message: updated });
    }
    if (absorbed.kind !== "miss") {
      await chargeRoutineRunOf(deps, event.runId, usage.amount);
      await deps.groupTurns.runDone(event.groupId, event.runId);
      return;
    }
  }

  const held = deps.groupTurns.takeHeldPass(groupId, event.runId);
  const message = await appendAndPush(deps, conn.ownerId, groupId, {
    kind: "cost",
    runId: event.runId,
    botId: event.botId,
    steps: usage.steps + held.steps,
    amount: usage.amount + held.amount,
  });
  deps.groupTurns.rememberCost(groupId, event.runId, {
    messageId: message.id,
    runId: event.runId,
    botId: event.botId,
    steps: usage.steps + held.steps,
    amount: usage.amount + held.amount,
  });
  await chargeRoutineRunOf(deps, event.runId, usage.amount);
  await deps.groupTurns.runDone(event.groupId, event.runId);
}

function runPassed(runId: RunId): boolean {
  for (const prefix of textPrefixes.values()) {
    if (prefix.runId === runId && prefix.kind === "pass") return true;
  }
  return false;
}

const ERROR_REASONS: Record<AgentError["code"], string> = {
  bad_message: "它看不懂控制面发过去的报文",
  prompt_before_config: "配置还没到就先接到了活",
  unsupported: "这件事它还做不了",
  runner_failed: "跑活的进程出错了",
  model_failed: "模型上游没回话",
};

function modelFailureStatus(detail: string): string {
  const status = /(?:^|\D)([45]\d{2})(?:\D|$)/.exec(detail)?.[1];
  return status === undefined ? "" : `，上游状态码 ${status}`;
}

async function onAgentError(deps: AgentEventDeps, conn: AgentConnection, event: AgentError): Promise<void> {
  // 报文带了群号就落在那个群，它是外部输入，照样按归属人过滤。不带才退回到最近一次还没结束的活。
  const named = event.groupId === undefined ? null : await findGroupId(deps.db, conn.ownerId, event.groupId);
  const open = await latestOpenRun(deps.db, conn.computerId);
  const groupId = named ?? open?.groupId ?? null;
  if (groupId === null) {
    console.error(`电脑 ${conn.computerId} 报错但没有进行中的活：${event.code} ${event.detail}`);
    return;
  }
  await appendAndPush(deps, conn.ownerId, groupId, {
    kind: "system",
    tone: "error",
    text:
      event.code === "model_failed"
        ? `模型没回话${modelFailureStatus(event.detail)}。检查控制面的上游地址和 key（.env 里的 UPSTREAM_BASE_URL、UPSTREAM_API_KEY、GATEWAY_MODEL）。`
        : `电脑那边没干成这件事，${ERROR_REASONS[event.code]}。原话是：${event.detail}`,
  });
  // 报文不带 run 号，只能拿最近一个没结束的活顶上，它得落在同一个群里，不然记错的是别人的运行记录。
  if (open !== null && open.groupId === groupId) {
    await failRoutineRunOf(deps, open.runId, ERROR_REASONS[event.code]);
  }
}

/**
 * 不回 approval_result，电脑上的运行器就一直挂着等，直到归属人点了按钮或在群里回了话。
 * 这是审批的本意：没人点头就不往下走。
 */
async function onApprovalRequest(deps: AgentEventDeps, conn: AgentConnection, event: ApprovalRequest): Promise<void> {
  const groupId = await resolveRun(deps, conn, event);
  if (groupId === null) return;

  const created = await createApproval(deps.db, {
    runId: event.runId,
    botId: event.botId,
    groupId,
    callId: event.callId,
    tool: event.tool,
    action: event.action,
    target: event.target,
    view: event.view,
  });
  // 同一条 approval_request 重发时这里是 null：不多一张卡，也不多推一次。
  if (created === null) return;

  // 先推审批再推卡，客户端画那张卡的时候状态已经在手上了。
  deps.push.push(conn.ownerId, { type: "approval_updated", approval: created.approval });
  deps.push.push(conn.ownerId, { type: "message", message: created.message });
  await holdRoutineRunOf(deps, event.runId);
}

async function onApprovalAbandoned(
  deps: AgentEventDeps,
  conn: AgentConnection,
  event: ApprovalAbandoned,
): Promise<void> {
  const scope = await approvalRun(deps.db, event.runId, event.callId);
  if (scope === null) return;
  const groupId = await resolveRun(deps, conn, { runId: event.runId, botId: scope.botId, groupId: scope.groupId });
  if (groupId === null) return;

  const approval = await expireApproval(deps.db, event.runId, event.callId);
  if (approval === null) return;
  deps.push.push(conn.ownerId, { type: "approval_updated", approval });
  await failRoutineRunOf(deps, event.runId, EXPIRED_APPROVAL_NOTE);
}

/**
 * 运行器整份替换清单。ownerBotId 当不可信输入再校一次：
 * 运行器只能对着这次 prompt 带去的 members 把名字解析成 id，比不出群的真实成员表。
 */
async function onTaskChecklist(deps: AgentEventDeps, conn: AgentConnection, event: TaskChecklist): Promise<void> {
  const groupId = await resolveRun(deps, conn, event);
  if (groupId === null) return;

  const members = await listGroupBots(deps.db, groupId);
  const memberIds = new Set<string>(members.map((member) => member.id));
  const stranger = event.checklist.find((item) => item.ownerBotId !== null && !memberIds.has(item.ownerBotId));
  if (stranger !== undefined) {
    console.warn(`电脑 ${conn.computerId} 报的清单里 ${stranger.ownerBotId} 不是群 ${event.groupId} 的成员，整条丢掉`);
    return;
  }

  const task = await replaceChecklist(deps.db, groupId, event.checklist);
  if (task === null) return;
  deps.push.push(conn.ownerId, { type: "task_updated", task });

  const botName = members.find((member) => member.id === event.botId)?.name ?? "Bot";
  const done = event.checklist.filter((item) => item.done).length;
  await appendAndPush(deps, conn.ownerId, groupId, {
    kind: "system",
    text: `${botName}更新了清单，${done}/${event.checklist.length} 完成`,
  });
}

/**
 * Bot @ 群里另一个 Bot。消息先落再判限额：那句话 Bot 确实说了，用户该看见，停下的只是派活。
 * 目标是外部输入，必须是这个群的成员且不是它自己，否则整条丢掉。
 */
async function onMention(deps: AgentEventDeps, conn: AgentConnection, event: Mention): Promise<void> {
  const groupId = await resolveRun(deps, conn, event);
  if (groupId === null || deps.groupTurns.isBlocked(event.runId)) return;

  const members = await listGroupBots(deps.db, groupId);
  const known = members.some((member) => member.id === event.targetBotId);
  if (!known || event.targetBotId === event.botId) {
    console.warn(`电脑 ${conn.computerId} 报的 @ 目标 ${event.targetBotId} 不是群 ${event.groupId} 里的别人，整条丢掉`);
    return;
  }

  const said = await appendAndPush(deps, conn.ownerId, groupId, {
    kind: "bot",
    botId: event.botId,
    text: event.text,
    streaming: false,
    mentions: [event.targetBotId],
  });
  await deps.groupTurns.recordBotMessage(groupId, event.runId, said);
}

/**
 * Bot 干完一件多步的活，问用户存不存。这一步只落一张卡，不建 skill 行：
 * 存不存由用户在群里点，`config.skills` 因此一个字都没变，不用重发 config。
 *
 * 来源按「这个 run 属不属于一次例行任务运行」判，只有此刻查得到：用户点存时手上只有那张卡，
 * 卡的正文里没有 runId，而例行任务的运行记录只留最近 20 条，早的那次到时候连行都不在了。
 * 所以现在就判出来记在这一行的 `skill_offer_source` 列上。
 */
async function onSkillOffer(deps: AgentEventDeps, conn: AgentConnection, event: SkillOffer): Promise<void> {
  const groupId = await resolveRun(deps, conn, event);
  if (groupId === null) return;

  const source = (await routineRunOfRun(deps.db, event.runId)) !== null ? "routine" : "chat";
  const message = await appendSkillOffer(
    deps.db,
    groupId,
    { kind: "skill_offer", botId: event.botId, name: event.name, steps: event.steps, status: "offered", skillId: null },
    source,
  );
  deps.push.push(conn.ownerId, { type: "message", message });
}

/**
 * 当前经手把活交给同群另一个 Bot。发起者必须是当前经手，目标必须是群里的别人，两道都是外部输入，任一不成立整条丢掉。
 * 报文和群里那张卡一起落，随后把活派给目标。当前经手这时一个字都不改：
 * 交出去只是发了份报文，要等目标确认了才换人，没人确认这件事就还挂在原来那个身上。
 */
async function onHandoff(deps: AgentEventDeps, conn: AgentConnection, event: HandoffEvent): Promise<void> {
  const groupId = await resolveRun(deps, conn, event);
  if (groupId === null) return;

  const task = await findTaskByGroup(deps.db, groupId);
  if (task === null || task.currentBotId !== event.botId) {
    console.warn(`电脑 ${conn.computerId} 报的交接来自 ${event.botId}，它不是群 ${event.groupId} 的当前经手，整条丢掉`);
    return;
  }

  const members = await listGroupBots(deps.db, groupId);
  const known = members.some((member) => member.id === event.toBotId);
  if (!known || event.toBotId === event.botId) {
    console.warn(`电脑 ${conn.computerId} 报的交接目标 ${event.toBotId} 不是群 ${event.groupId} 里的别人，整条丢掉`);
    return;
  }

  if (deps.groupTurns.isBlocked(event.runId)) {
    if (deps.groupTurns.claimHandoffLimitNotice(event.runId)) {
      await appendAndPush(deps, conn.ownerId, groupId, {
        kind: "system",
        tone: "error",
        text: HANDOFF_LIMIT_NOTICE,
      });
    }
    return;
  }

  const created = await createHandoff(deps.db, {
    groupId,
    fromBotId: event.botId,
    toBotId: event.toBotId,
    done: event.done,
    notDone: event.notDone,
    next: event.next,
    checklistIndex: event.checklistIndex,
  });

  // 先推交接再推卡，客户端画那张卡的时候状态已经在手上了。
  deps.push.push(conn.ownerId, { type: "handoff_updated", handoff: created.handoff });
  deps.push.push(conn.ownerId, { type: "message", message: created.message });

  deps.groupTurns.queueHandoff(groupId, event.runId, {
    botId: event.toBotId,
    trigger: created.message,
    reason: "handoff",
    handoff: {
      id: created.handoff.id,
      fromBotId: event.botId,
      text: renderHandoffReport({
        fromName: members.find((member) => member.id === event.botId)?.name ?? "上一位",
        done: event.done,
        notDone: event.notDone,
        next: event.next,
        checklistIndex: event.checklistIndex,
      }),
    },
  });
  await deps.groupTurns.recordHandoff(groupId, event.runId);
}

async function onSetChief(deps: AgentEventDeps, conn: AgentConnection, event: SetChiefEvent): Promise<void> {
  const groupId = await resolveRun(deps, conn, event);
  if (groupId === null) return;
  const members = await listGroupBots(deps.db, groupId);
  if (members.length < 2) return;
  if (event.targetBotId !== null && !members.some((member) => member.id === event.targetBotId)) return;
  const previousChief = await findChiefBotId(deps.db, groupId);
  if (!(await setChiefBotId(deps.db, groupId, event.targetBotId))) return;
  const detail = await findGroup(deps.db, conn.ownerId, groupId);
  if (detail !== null) deps.push.push(conn.ownerId, { type: "group_updated", group: detail.group });
  const name = members.find((member) => member.id === (event.targetBotId ?? previousChief))?.name ?? "Bot";
  await appendAndPush(deps, conn.ownerId, groupId, {
    kind: "system",
    text: `${name}${event.targetBotId === null ? "卸任首席" : "成为首席"}`,
  });
}

/**
 * 目标确认接手。确认之后它才是当前经手：`setCurrentBot` 给上一位补上交出去的时刻，新一位追加一条。
 * 不是它的交接、对不上群的编号、重复的确认，全在 `acceptHandoff` 那条 UPDATE 的 WHERE 里挡掉，
 * 所以这里只剩一条成功路径，重复确认既不会再改经手也不会再推一次。
 */
async function onHandoffAccept(deps: AgentEventDeps, conn: AgentConnection, event: HandoffAcceptEvent): Promise<void> {
  const groupId = await resolveRun(deps, conn, event);
  if (groupId === null) return;

  // 同一个时刻既是 accepted_at 也是经手记录里新那一条的 from，卡上和任务页因此对得起来。
  const at = new Date();
  const accepted = await acceptHandoff(deps.db, { handoffId: event.handoffId, groupId, toBotId: event.botId, at });
  if (accepted === null) {
    console.warn(
      `电脑 ${conn.computerId} 报的确认 ${event.handoffId} 不是群 ${event.groupId} 里等 ${event.botId} 接手的交接，整条丢掉`,
    );
    return;
  }

  const task = await setCurrentBot(deps.db, groupId, event.botId, at);
  deps.push.push(conn.ownerId, { type: "handoff_updated", handoff: accepted });
  if (task !== null) deps.push.push(conn.ownerId, { type: "task_updated", task });
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
