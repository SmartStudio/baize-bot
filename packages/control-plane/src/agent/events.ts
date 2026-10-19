import {
  GroupId,
  MessageId,
  type AgentToControl,
  type BotId,
  type ComputerId,
  type LoginFailure,
  type Message,
  type MessageBody,
  type Platform,
  type RunId,
  type UsageRecord,
  type UserId,
} from "@baize/shared";
import { TransactionRollbackError, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { runs } from "../db/schema.js";
import { refreshHintForRun } from "../poker/hint.js";
import type { NoticePublisher } from "../notifications.js";
import { expireLogin } from "../account-expiry.js";
import { findAccountOnComputer, markLoginFailed, markLoginValid } from "../repo/accounts.js";
import {
  APPROVAL_AUTO_REJECT_MS,
  approvalRun,
  createApproval,
  expireApproval,
  expireApprovalsOfRun,
} from "../repo/approvals.js";
import { markComputerOnline } from "../repo/computers.js";
import { findAssistant } from "../repo/bots.js";
import { acceptHandoff, createHandoff } from "../repo/handoffs.js";
import { findChiefBotId, findGroup, setChiefBotId } from "../repo/groups.js";
import {
  appendBotText,
  finalizeBotText,
  upsertToolCall,
  appendMessage,
  appendSkillOffer,
  failRunningToolCalls,
  findGroupId,
  findOwnedMessage,
  listGroupBots,
  replaceMessageBody,
  settleStreamingText,
  type Tx,
} from "../repo/messages.js";
import { createDraft, editDraft, proposePlan } from "../repo/drafts.js";
import { confirmContext } from "../repo/context-window.js";
import {
  failRoutineRun,
  markRoutineRunResult,
  pushRoutineUpdated,
  routineRunOfRun,
  type RoutineRunRef,
} from "../repo/routines.js";
import { trustedPageUrl } from "../publish/platforms.js";
import { publishFailed, publishSucceeded } from "../publish/settle.js";
import {
  claimCharge,
  finishRun,
  uniqueOpenRun,
  lockRuns,
  lockSettlement,
  lockSettlementOfRun,
  openRunsForComputer,
  runBelongsTo,
  unchargedRunsForComputer,
  whileRunOpen,
  type RunScope,
} from "../repo/runs.js";
import { findTaskByGroup, replaceChecklist, setCurrentBot, setProjectCadence } from "../repo/tasks.js";
import {
  chargeRoutineRunIn,
  EXPIRED_APPROVAL_NOTE,
  failRoutineRunOf,
  holdRoutineRunOf,
  type ChargedRoutineRun,
  type RoutineDeps,
} from "../routines/run.js";
import type { PushHub } from "../ws/hub.js";
import { HANDOFF_LIMIT_NOTICE, type GroupTurns, type PassAbsorption } from "./group-turn.js";
import { continuesAfter } from "./continuation.js";
import { resumeContinuation } from "./dispatch.js";
import { renderHandoffReport } from "./handoff.js";
import { handleMetricReport } from "./events/metric-report.js";
import { handlePokerAct } from "./events/poker-act.js";
import { handlePokerReview } from "./events/poker-review.js";
import { handlePreferenceOffer } from "./events/preference-offer.js";
import { handleReviewSubmit } from "./events/review-submit.js";
import { botTextVisibility, isUplinkAllowed } from "./table-run-policy.js";
import { handleRoutineOffer } from "./events/routine-offer.js";
import { handleTeamOffer } from "./events/team-offer.js";
import type { AgentHub, AgentConnection } from "./hub.js";

export type AgentEventDeps = {
  readonly db: Db;
  readonly push: PushHub;
  readonly agents: AgentHub;
  readonly groupTurns: GroupTurns;
  readonly priceInputPerM: number;
  readonly priceOutputPerM: number;
  readonly notifications: NoticePublisher;
  readonly afterCommit?: (effect: (deps: AgentEventDeps) => Promise<void>) => void;
};

/** 电脑代理报上来的事件。每一条都写进 messages 表再推给 Web 客户端，群消息是事实来源。 */
export async function handleAgentEvent(
  deps: AgentEventDeps,
  conn: AgentConnection,
  message: AgentToControl,
  receivedAt = new Date(),
): Promise<void> {
  switch (message.type) {
    // 握手在 hub 里做完了，重复的 hello 不再认一次身份。
    case "downlink_ack":
    case "hello":
      return;
    case "heartbeat":
      await markComputerOnline(deps.db, conn.computerId, conn.gatewayKey);
      return;
    case "config_applied":
      await deps.agents.markConfigApplied(conn, message.generation);
      return;
    case "bot_text":
      await onBotText(deps, conn, message);
      return;
    case "bot_text_done":
      await onBotTextDone(deps, conn, message);
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
    case "set_cadence":
      await onSetCadence(deps, conn, message);
      return;
    case "project_offer":
      await onProjectOffer(deps, conn, message);
      return;
    case "login_state":
      await onLoginState(deps, conn, message);
      return;
    case "draft_create":
      await onDraftCreate(deps, conn, message);
      return;
    case "plan_propose":
      await onPlanPropose(deps, conn, message);
      return;
    case "draft_edit":
      await onDraftEdit(deps, conn, message);
      return;
    case "publish_result":
      await onPublishResult(deps, conn, message);
      return;
    case "team_offer":
      await handleTeamOffer(deps, conn, message);
      return;
    case "routine_offer":
      await handleRoutineOffer(deps, conn, message);
      return;
    case "preference_offer":
      await handlePreferenceOffer(deps, conn, message);
      return;
    case "metric_report":
      await handleMetricReport(deps, conn, message);
      return;
    case "review_submit":
      await handleReviewSubmit(deps, conn, message, receivedAt);
      return;
    case "poker_act":
      await handlePokerAct(deps, conn, message);
      return;
    case "poker_review":
      await handlePokerReview(deps, conn, message);
      return;
  }
}

/**
 * 群要是这台电脑主人的，run 要是这个 Bot 在这个群里的，这种报文要是这个 run 在牌桌上能发的。任一不成立整条丢掉。
 * 报文的 type 一并带进来，牌桌 run 的放行名单按它查（table-run-policy）。
 */
async function resolveRun(
  deps: AgentEventDeps,
  conn: AgentConnection,
  event: {
    readonly type: AgentToControl["type"];
    readonly runId: RunId;
    readonly botId: BotId;
    readonly groupId: GroupId;
  },
): Promise<GroupId | null> {
  // 报文里的群号是外部输入，findGroupId 按归属人过滤，不是这台电脑主人的群整条丢掉。
  const groupId = await findGroupId(deps.db, conn.ownerId, event.groupId);
  if (groupId === null) return null;
  // 外键只保证 runId 存在，管不了它指到哪个群：不校的话一个被入侵的电脑代理能拿自己的 runId 往自己另一个群插卡。
  if (!(await runBelongsTo(deps.db, event.runId, event.botId, groupId, conn.computerId))) {
    console.warn(`电脑 ${conn.computerId} 报的 run ${event.runId} 不是它在群 ${event.groupId} 里的活，整条丢掉`);
    return null;
  }
  const run = { runId: event.runId, botId: event.botId, groupId: GroupId.parse(groupId) };
  if (!(await isUplinkAllowed(deps.db, run, event.type))) {
    console.warn(`电脑 ${conn.computerId} 的牌桌 run ${event.runId} 发了它不能发的 ${event.type}，整条丢掉`);
    return null;
  }
  return run.groupId;
}

type LoginState = Extract<AgentToControl, { type: "login_state" }>;

const PLATFORM_LABEL: Record<Platform, string> = { github: "GitHub", x: "X", xiaohongshu: "小红书" };
const LOGIN_FAILURE_NOTICE: Record<LoginFailure, (platform: string) => string> = {
  window_failed: (platform) => `${platform}的登录窗口出错或被关掉了，账号状态没变，可以再点一次登录`,
  timed_out: (platform) => `${platform}的登录窗口开了很久还没登上，已经收起，账号状态没变，可以再点一次登录`,
};

/**
 * 三种结论都先认电脑：账号必须是这台电脑主人的、登在这台电脑上的，否则整条丢掉。
 * 还得是在电脑浏览器里登录的账号：授权连上的账号登录状态只跟着控制面的凭据代际走，电脑说什么都不算。
 * 账号不属于哪个群，没有群消息可落，要用户处理的都走通知。登录状态随 config.accounts 下发，变了就重发。
 */
async function onLoginState(deps: AgentEventDeps, conn: AgentConnection, event: LoginState): Promise<void> {
  const found = await findAccountOnComputer(deps.db, conn.ownerId, conn.computerId, event.accountId);
  if (found === null) {
    console.warn(`电脑 ${conn.computerId} 报的账号 ${event.accountId} 不在它上面，整条丢掉`);
    return;
  }
  if (found.via !== "computer") {
    console.warn(
      `电脑 ${conn.computerId} 报了 ${found.platform} 账号 ${event.accountId} 的登录状态，这个账号是授权连上的，整条丢掉`,
    );
    return;
  }
  // 三种写都带这条连接：落库那一刻连接已经被顶掉的话一行都不改，新连接刚写下的事实不会被在途的旧帧盖掉。
  const { state } = event;
  switch (state.login) {
    case "valid": {
      const change = await markLoginValid(deps.db, conn.ownerId, conn, event.accountId, state.handle);
      if (change === null) return;
      if (change.deleted !== null) deps.push.push(conn.ownerId, { type: "account_deleted", accountId: change.deleted });
      deps.push.push(conn.ownerId, { type: "account_updated", account: change.account });
      await deps.agents.sendConfig(conn.ownerId);
      return;
    }
    case "expired":
      await expireLogin(deps, conn.ownerId, event.accountId, conn);
      return;
    case "failed": {
      // 登录没成不等于账号过期，accounts.login 不动，只在账号上记下最近这一次，页面刷新之后还看得到。
      // 页面按 accountId 和 attempt 结算那张卡，通知只是给人看的；这两样只说那一次尝试，不看库里的连接代次。
      const account = await markLoginFailed(deps.db, conn.ownerId, conn, event.accountId, state.reason);
      if (account !== null) deps.push.push(conn.ownerId, { type: "account_updated", account });
      deps.push.push(conn.ownerId, {
        type: "login_failed",
        accountId: event.accountId,
        attempt: state.attempt,
        reason: state.reason,
      });
      await deps.notifications.publish(conn.ownerId, {
        kind: "failed",
        text: LOGIN_FAILURE_NOTICE[state.reason](PLATFORM_LABEL[found.platform]),
        groupId: null,
      });
      return;
    }
  }
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
type SetCadenceEvent = Extract<AgentToControl, { type: "set_cadence" }>;
type ProjectOfferEvent = Extract<AgentToControl, { type: "project_offer" }>;

type TextPrefix =
  | { readonly kind: "buffering"; readonly text: string; readonly runId: RunId }
  | { readonly kind: "pass"; readonly runId: RunId }
  | { readonly kind: "visible"; readonly runId: RunId };
const textPrefixes = new Map<string, TextPrefix>();

export function eventMemoryRollback(body: AgentToControl): () => void {
  if (!("runId" in body) || body.runId === undefined || body.runId === null) return () => undefined;
  const runId = body.runId;
  const prefixes = new Map([...textPrefixes].filter(([, prefix]) => prefix.runId === runId));
  const booking = costBookings.get(runId);
  const groupId = "groupId" in body ? body.groupId : undefined;
  const held = new Map([...heldPasses].filter(([id, value]) => id === runId || value.groupId === groupId));
  return () => {
    for (const [id, prefix] of textPrefixes) if (prefix.runId === runId) textPrefixes.delete(id);
    for (const [id, prefix] of prefixes) textPrefixes.set(id, prefix);
    if (booking === undefined) costBookings.delete(runId);
    else costBookings.set(runId, booking);
    for (const [id, value] of held) if (!heldPasses.has(id)) heldPasses.set(id, value);
    if (!held.has(runId)) heldPasses.delete(runId);
  };
}

function clearTextPrefixes(runId: RunId): void {
  for (const [messageId, prefix] of textPrefixes) if (prefix.runId === runId) textPrefixes.delete(messageId);
  costBookings.delete(runId);
}

/** 收成定稿的 Bot 文字沿用流式那条推送：空 delta 带 done 和收尾那次写下的 revision，客户端照常把它收尾。 */
function pushSettled(push: PushHub, ownerId: UserId, settled: readonly Message[]): void {
  for (const message of settled) {
    push.push(ownerId, {
      type: "message_delta",
      messageId: message.id,
      groupId: message.groupId,
      delta: "",
      done: true,
      revision: message.revision,
      visibleTo: message.visibleTo,
    });
  }
}

/**
 * 替等不到 run_done 的 run 收尾：run 行结束，挂着的审批过期，还在跑的工具行失败，还在流的 Bot 文字收成定稿，
 * 群里说一句 notice，例行记失败；还欠着换电脑接续的不记，运行记录由接续那一轮收尾。
 * 幂等靠 finishRun 的 WHERE ended_at IS NULL，已经收过尾的返回 null，什么都不再做。
 */
export async function abandonRun(
  deps: RoutineDeps & { readonly afterCommit?: AgentEventDeps["afterCommit"] },
  ownerId: UserId,
  run: { readonly runId: RunId; readonly groupId: GroupId | null },
  notice: { readonly text: string; readonly reason: string },
  transaction?: {
    readonly tx: Tx;
    afterCommit(effect: () => Promise<{ readonly routine: RoutineRunRef | null }>): void;
  },
): Promise<{ readonly routine: RoutineRunRef | null } | null> {
  const db = transaction === undefined ? deps.db : (transaction.tx as unknown as Db);
  const result = await db.transaction(async (tx) => {
    await lockSettlementOfRun(tx, run.runId);
    const usage = await finishRun(
      tx,
      run.runId,
      run.groupId,
      { steps: 0, inputTokens: 0, outputTokens: 0, amount: 0 },
      "abandoned",
    );
    if (usage === null) return null;
    const expiredApprovals = await expireApprovalsOfRun(tx, run.runId);
    const failedTools = run.groupId === null ? [] : await failRunningToolCalls(tx, run.groupId, run.runId);
    const settled =
      run.groupId === null || usage.botId === null
        ? []
        : await settleStreamingText(tx, run.groupId, usage.botId, run.runId);
    const message =
      run.groupId === null
        ? null
        : await appendMessage(tx, run.groupId, { kind: "system", tone: "error", text: notice.text });
    // 记录跟 run 同一个事务收：提交后再记，记的那一下出错时 run 已经收完，记录就永远停在 running。
    const routine = (await continuesAfter(tx, run.runId)) ? null : await routineRunOfRun(tx, run.runId);
    const failedRoutineId =
      routine === null
        ? null
        : await failRoutineRun(
            tx,
            routine.routineRunId,
            expiredApprovals.length > 0 ? EXPIRED_APPROVAL_NOTE : notice.reason,
          );
    return { expiredApprovals, failedTools, settled, message, routine, failedRoutineId };
  });
  if (result === null) return null;
  // 收尾已经提交，下面每一步各自兜错：刷新牌桌提示出错不能让接续不起，接续出错也不能吞掉后面的推送。
  // 漏掉的接续由定期补扫捡回来，推送丢了只是页面要刷新才看得到。
  const step = async (name: string, work: () => Promise<void> | void) => {
    try {
      await work();
    } catch (error) {
      console.error(`run ${run.runId} 收尾后${name}出错：${errorKind(error)}`);
    }
  };
  const publish = async (real: RoutineDeps) => {
    clearTextPrefixes(run.runId);
    if (run.groupId !== null) real.groupTurns.abandon(run.groupId, run.runId);
    await step("刷新牌桌提示", () => refreshHintForRun(real, run.runId));
    for (const approval of result.expiredApprovals) real.push.push(ownerId, { type: "approval_updated", approval });
    // Bot 刚请求换电脑、电脑随即掉线，run_done 还在发件箱里：被放弃的这一轮照样在另一台上接着做。
    if (run.groupId !== null) await step("起接续", () => resumeContinuation(real, run.runId));
    for (const message of result.failedTools) real.push.push(ownerId, { type: "message", message });
    pushSettled(real.push, ownerId, result.settled);
    if (result.message !== null) real.push.push(ownerId, { type: "message", message: result.message });
    await step("推例行状态", () => pushRoutineUpdated(real, result.failedRoutineId));
    return { routine: result.routine };
  };
  if (transaction !== undefined) transaction.afterCommit(() => publish(deps));
  // 信封里 deps.db 是还没提交的事务，推送要等它提交：在事务里兜住一条查询的错，提交时整个事务会被悄悄回滚。
  else if (deps.afterCommit !== undefined) deps.afterCommit(async (real) => void (await publish(real)));
  else return publish(deps);
  return { routine: null };
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

  const text = {
    messageId: event.messageId,
    groupId,
    botId: event.botId,
    visibleTo: await botTextVisibility(deps.db, event.runId),
  };
  const appended = await whileRunOpen(deps.db, { runId: event.runId, botId: event.botId, groupId }, async (tx) => {
    const written = await appendBotText(tx, text, delta, event.done);
    if (written.kind !== "taken" && delta.trim() !== "") await markRoutineRunResult(tx, event.runId);
    return written;
  });
  // run 已经收尾：这条要么从没落过，要么收尾时已经收成定稿，晚到的这段不接上去，也不推。
  if (appended === null) return;
  if (appended.kind === "taken") {
    console.warn(`电脑 ${conn.computerId} 报的消息编号 ${event.messageId} 已经被别的群占了，整条丢掉`);
    return;
  }
  if (appended.created !== null) deps.push.push(conn.ownerId, { type: "message", message: appended.created });
  deps.push.push(conn.ownerId, {
    type: "message_delta",
    messageId: event.messageId,
    groupId: event.groupId,
    delta,
    done: event.done,
    revision: appended.message.revision,
    visibleTo: appended.message.visibleTo,
  });
  if (appended.created !== null || event.done) await refreshHintForRun(deps, event.runId, appended.message.id);
  if (event.done) await deps.groupTurns.recordBotMessage(groupId, event.runId, appended.message, "text");
}

async function onBotTextDone(
  deps: AgentEventDeps,
  conn: AgentConnection,
  event: Extract<AgentToControl, { type: "bot_text_done" }>,
): Promise<void> {
  const groupId = await resolveRun(deps, conn, event);
  if (groupId === null || deps.groupTurns.isBlocked(event.runId)) return;
  const passed = event.text.startsWith("(pass)") || event.text.startsWith("（pass）");
  textPrefixes.set(event.messageId, { kind: passed ? "pass" : "visible", runId: event.runId });
  if (passed) return;
  const final = await finalizeBotText(
    deps.db,
    {
      messageId: event.messageId,
      groupId,
      botId: event.botId,
      visibleTo: await botTextVisibility(deps.db, event.runId),
    },
    event.text,
  );
  if (final.kind === "taken") return;
  // 和定稿同在信封的事务里：流式那几段没记上（比如整段只来了这一条）也在这里记上。
  if (event.text.trim() !== "") await markRoutineRunResult(deps.db, event.runId);
  if (final.created !== null) deps.push.push(conn.ownerId, { type: "message", message: final.created });
  if (final.replace) deps.push.push(conn.ownerId, { type: "message", message: final.message });
  deps.push.push(conn.ownerId, {
    type: "message_delta",
    messageId: event.messageId,
    groupId,
    delta: final.delta,
    done: true,
    revision: final.message.revision,
    visibleTo: final.message.visibleTo,
  });
  await refreshHintForRun(deps, event.runId, final.message.id);
  await deps.groupTurns.recordBotMessage(groupId, event.runId, final.message, "text");
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
  const message = await upsertToolCall(deps.db, groupId, event.runId, event.callId, body);
  if (message === null) return;

  // 同一个 id 推第二次，客户端按 id 覆盖那张卡。
  deps.push.push(conn.ownerId, { type: "message", message });
  if (event.status === "running") conn.toolCallMessages.set(key, message.id);
  else conn.toolCallMessages.delete(key);
}

/**
 * 结束 run 和结账沿用各自的函数，在信封路径里共用外层事务；任一步失败，两步和游标一起回滚。
 * 提交后才推进回合、弹通知，再回累计确认。
 * 费用卡怎么出（单落、并进汇总、先记着）看运行器此前的文字块和回合的内存状态，这两样只在第一次结账时读，
 * 读到的结论记在 costBookings 里；信封事务失败时恢复内存标记，成功后保留结论供后续补结账使用。
 */
async function onRunDone(deps: AgentEventDeps, conn: AgentConnection, event: RunDone): Promise<void> {
  const groupId = await resolveRun(deps, conn, event);
  if (groupId === null) return;

  const amount =
    (event.inputTokens / 1_000_000) * deps.priceInputPerM + (event.outputTokens / 1_000_000) * deps.priceOutputPerM;
  const finished = await deps.db.transaction(async (tx) => {
    await lockSettlement(tx, groupId, event.botId);
    // 信封把结束与结账合成一个事务，第一次改 run 前就按同序锁齐可能合账的行。
    await lockRuns(tx, [event.runId, ...heldRunsOfGroup(groupId)]);
    const usage = await finishRun(
      tx,
      event.runId,
      event.groupId,
      { steps: event.steps, inputTokens: event.inputTokens, outputTokens: event.outputTokens, amount },
      "run_done",
    );
    if (usage === null) return null;
    // 旧运行器不带 prompt 字段，它的 run_done 一直是「收下就确认」，维持原样。
    if ((event.prompt ?? "entered") === "entered") await confirmContext(tx, event.runId);
    return {
      failedTools: await failRunningToolCalls(tx, event.groupId, event.runId),
      settled: await settleStreamingText(tx, event.groupId, event.botId, event.runId),
    };
  });
  // 重复的、对账已经收尾的 run 在这里是 null：行已经结束，工具行和文字定稿都推过了，剩下的只有可能没结完的账。
  if (finished !== null) {
    for (const message of finished.failedTools) deps.push.push(conn.ownerId, { type: "message", message });
    pushSettled(deps.push, conn.ownerId, finished.settled);
    await refreshHintForRun(deps, event.runId);
  }

  const run = { runId: event.runId, botId: event.botId, groupId };
  await settleCharge(deps, conn.ownerId, run, (usage, heldRuns, routine) =>
    bookCost(deps, conn.ownerId, run, usage, heldRuns, routine),
  );
}

/**
 * hello 时补结账：这台电脑名下结束了、没结账的 run，按 run_done 的路子一条条结掉。
 * 可靠补发只在重连 hello 之后发；旧版本或历史故障留下的欠账由 charged_at 为空记得，
 * 故障排除后的下一次 hello（包括控制面重启后的重连）把这些欠账补齐。
 * 还在回合里先记着的 pass 不动，它等这一轮下一张费用卡；回合已经没了的，单落一张卡。
 * 费用卡沿用这个进程里结账失败时记下的结论，没有就单落，结果通知同 run_done 一样只在结账提交的这次弹。
 */
export async function settleUnchargedRuns(deps: RoutineDeps, computerId: ComputerId, ownerId: UserId): Promise<void> {
  for (const run of await unchargedRunsForComputer(deps.db, computerId)) {
    const held = heldPasses.get(run.runId);
    if (held !== undefined) {
      const live = deps.groupTurns
        .snapshots(ownerId)
        .some((turn) => turn.groupId === run.groupId && turn.epoch === held.epoch);
      if (live) continue;
      heldPasses.delete(run.runId);
    }
    // 一条结不成不挡后面的：各行的认领互不相干，账留在库里等下一次 hello。
    await settleCharge(deps, ownerId, run, () => ({ kind: "card", heldRuns: [] })).catch((error: unknown) =>
      console.error(`电脑 ${computerId} 上线补结账 run ${run.runId} 失败：${errorKind(error)}`),
    );
  }
}

/** 日志只记错误类别（name，pg 错误带 code）。异常原文可能夹着用户正文或凭据，不进日志。 */
export function errorKind(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  return "code" in error && typeof error.code === "string" ? `${error.name} ${error.code}` : error.name;
}

/**
 * 结账提交之后推送费用卡、推送例行任务、推进回合、弹结果通知。run_done 和 hello 补结账共用。
 * 回合推进只认当前回合的 runId，重复调用是空操作；结账提交后推进抛错的，补发时账已结、回合还在这里，接着推。
 */
async function settleCharge(
  deps: RoutineDeps & { readonly afterCommit?: AgentEventDeps["afterCommit"] },
  ownerId: UserId,
  run: RunScope,
  book: BookCost,
): Promise<void> {
  const charge = heldPasses.has(run.runId) ? null : await chargeRun(deps, run, book);
  clearTextPrefixes(run.runId);
  if (charge?.kind === "card") {
    deps.push.push(ownerId, { type: "message", message: charge.message });
    deps.groupTurns.rememberCost(run.groupId, run.runId, {
      messageId: charge.message.id,
      runId: run.runId,
      botId: run.botId,
      steps: charge.steps,
      amount: charge.amount,
    });
  }
  if (charge?.kind === "merged" && charge.message !== null) {
    deps.push.push(ownerId, { type: "message", message: charge.message });
    if (charge.message.body.kind === "cost")
      deps.groupTurns.rememberCost(run.groupId, run.runId, {
        messageId: charge.message.id,
        runId: charge.message.body.runId ?? run.runId,
        botId: charge.message.body.botId ?? run.botId,
        steps: charge.message.body.steps,
        amount: charge.message.body.amount,
      });
  }
  // 例行状态推送只管实时视图，推送失败只记日志，不挡回合推进和后面的行。丢了这条，已加载的例行列表停在旧状态，
  // WebSocket 重连不补拉它，要整页刷新或重新进入时的 HTTP 读取才拿到库里的状态。
  // 推送按 id 整条覆盖，重放已结账的行也再推一次。
  try {
    const routine =
      charge !== null && charge.kind !== "held" ? charge.routine : await routineRunOfRun(deps.db, run.runId);
    if (routine !== null) await pushRoutineUpdated(deps, routine.routineId);
  } catch (error) {
    console.error(`run ${run.runId} 结账后推送例行状态失败：${errorKind(error)}`);
  }
  // 接续排在回合推进之前：推进会把排着的下一位派出去，接续得先插到它前面。信封里两者都等提交后按这个顺序跑。
  const resume = (real: RoutineDeps) => resumeContinuation(real, run.runId);
  if (deps.afterCommit === undefined) await resume(deps);
  else deps.afterCommit(resume);
  await deps.groupTurns.runDone(run.groupId, run.runId);
  // 用户当场发起的对话他就在群里看着，只有他不在场时派出去的活才值得弹一条。
  // 通知只是一条推送，没有落库的地方可以做幂等：结账提交后到这里之前抛错的那次，补发不再弹，最多弹一次。
  // 换电脑的链只在链尾结账时按整条链有没有结果弹，记录被别处先收成 failed 的不弹，见 chargeRoutineRun。
  const routine = charge !== null && charge.kind !== "held" ? charge.routine : null;
  if (routine !== null && routine.notify) {
    await deps.notifications.publish(ownerId, {
      kind: "result",
      text: `例行任务「${routine.name}」做完了，打开群聊看结果`,
      groupId: run.groupId,
    });
  }
  if (charge !== null) await deps.notifications.usageCharged(ownerId);
}

type Charge =
  | {
      readonly kind: "card";
      readonly message: Message;
      readonly steps: number;
      readonly amount: number;
      readonly routine: ChargedRoutineRun | null;
    }
  | { readonly kind: "merged"; readonly message: Message | null; readonly routine: ChargedRoutineRun | null }
  | { readonly kind: "held" };

/**
 * 结账事务：claimCharge 认领 charged_at，费用卡和例行记账在同一个事务里落，哪一件抛错整个事务回滚，认领也回滚，
 * 下一次补发或 hello 补结账再认领一次。已经结过账的回 null。
 * 先记着的 pass 不结账，认领回滚：charged_at 为空就是它落库的样子，金额在 run 行上，
 * 等这一轮下一张费用卡在自己的事务里认领它、把金额加进卡里；控制面重启了就由 hello 补结账单落一张。
 * 事务开头先把这条 run 和它可能一并认领的 pass 按 id 升序锁住，再逐条认领：认领的次序是「当前这条、再按记下的顺序」，
 * 删 Bot 锁它名下的 run 是 id 序，两边各持一行互等就是死锁。要锁哪些在事务外定下来，认领的就是锁过的这几条。
 */
async function chargeRun(deps: RoutineDeps, run: RunScope, book: BookCost): Promise<Charge | null> {
  const retained = costBookings.get(run.runId);
  const heldRuns = retained?.kind === "card" ? retained.heldRuns : heldRunsOfGroup(run.groupId);
  try {
    return await deps.db.transaction(async (tx) => {
      await lockRuns(tx, [run.runId, ...heldRuns]);
      const usage = await claimCharge(tx, run.runId);
      if (usage === null) return null;
      const routine = await chargeRoutineRunIn(tx, run.runId, usage.amount);
      const booking = retained ?? book(usage, heldRuns, routine !== null);
      costBookings.set(run.runId, booking);
      if (booking.kind === "held") return tx.rollback();
      if (booking.kind === "merged") {
        const message = await replaceMessageBody(tx, booking.cost.messageId, run.groupId, {
          kind: "cost",
          runId: booking.cost.runId,
          botId: booking.cost.botId,
          steps: booking.cost.steps,
          amount: booking.cost.amount,
        });
        return { kind: "merged", message, routine } as const;
      }
      let { steps, amount } = usage;
      // 先记着的 pass 不会是例行派起的（见 bookCost），没有例行账要记。
      for (const heldRunId of booking.heldRuns) {
        const held = await claimCharge(tx, heldRunId);
        if (held === null) continue;
        steps += held.steps;
        amount += held.amount;
      }
      const message = await appendMessage(tx, run.groupId, {
        kind: "cost",
        runId: run.runId,
        botId: run.botId,
        steps,
        amount,
      });
      return { kind: "card", message, steps, amount, routine } as const;
    });
  } catch (error) {
    if (error instanceof TransactionRollbackError) return { kind: "held" };
    throw error;
  }
}

/** 定这次花费怎么落：单落一张卡、并进这一轮的汇总行，还是先记着。routine：这条 run 是例行派起的。 */
type BookCost = (usage: UsageRecord, heldRuns: readonly RunId[], routine: boolean) => CostBooking;

type CostBooking =
  | { readonly kind: "card"; readonly heldRuns: readonly RunId[] }
  | { readonly kind: "merged"; readonly cost: Extract<PassAbsorption, { kind: "merged" }>["cost"] }
  | { readonly kind: "held" };

// 结账事务失败后留着的费用卡结论，按 runId 记，结账提交或 run 被收掉时清。控制面重启就没了，
// 那时补发的 run_done 按「普通回话」单落一张卡：文字块记忆已丢，分不出 (pass)，宁可多一张卡也不丢账。
const costBookings = new Map<RunId, CostBooking>();

// 先记着、还没进费用卡的 pass。epoch 认回合：hello 补结账时回合还在的不动，回合没了的单落。
const heldPasses = new Map<RunId, { readonly groupId: GroupId; readonly epoch: number }>();

/** 这个群先记着、还没进费用卡的 pass，按 id 升序。 */
function heldRunsOfGroup(groupId: GroupId): readonly RunId[] {
  return [...heldPasses]
    .flatMap(([heldRunId, held]) => (held.groupId === groupId ? [heldRunId] : []))
    .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * `(pass)` 不单落花费。这一轮已经有汇总行就并进去，还没有就先记着，等这个群下一张费用卡一起写；
 * 对不上当前回合的照旧单落一条。真回话的把这个群先记着的 pass 一起认领，认领的就是结账事务开头锁过的那几条 `heldRuns`。
 * 这里会改回合的内存状态（并进汇总、记下或取走先记着的），所以一次结账只算一次。
 */
function bookCost(
  deps: AgentEventDeps,
  ownerId: UserId,
  { runId, botId, groupId }: RunScope,
  usage: UsageRecord,
  heldRuns: readonly RunId[],
  routine: boolean,
): CostBooking {
  const passed = runPassed(runId);
  // 例行派起的 run 不先记着：它在那一轮里是第一个说话的，后面多半没有费用卡来认领它，记着就是运行记录一直 running。
  if (passed && !routine) {
    const absorbed = deps.groupTurns.absorbPassCost(groupId, runId, {
      steps: usage.steps,
      amount: usage.amount,
      botId,
    });
    if (absorbed.kind === "merged") return absorbed;
    if (absorbed.kind === "held") {
      const turn = deps.groupTurns.snapshots(ownerId).find((snapshot) => snapshot.groupId === groupId);
      heldPasses.set(runId, { groupId, epoch: turn?.epoch ?? -1 });
      return absorbed;
    }
  }
  for (const heldRunId of heldRuns) heldPasses.delete(heldRunId);
  return { kind: "card", heldRuns };
}

// 一个 run 按文字块分成好几条，先说了可见的话再回 (pass) 的 run 仍是回了话，花费卡要留。
function runPassed(runId: RunId): boolean {
  let passed = false;
  for (const prefix of textPrefixes.values()) {
    if (prefix.runId !== runId) continue;
    if (prefix.kind === "visible") return false;
    if (prefix.kind === "pass") passed = true;
  }
  return passed;
}

const CONFIG_MISMATCH = "电脑代理和控制面版本对不上，配置被拒";

const ERROR_REASONS: Record<AgentError["code"], string> = {
  bad_message: "它看不懂控制面发过去的报文",
  prompt_before_config: "配置还没到就先接到了活",
  unsupported: "这件事它还做不了",
  runner_failed: "跑活的进程出错了",
  model_failed: "模型上游没回话",
  config_rejected: CONFIG_MISMATCH,
};

function modelFailureStatus(detail: string): string {
  const status = /(?:^|\D)([45]\d{2})(?:\D|$)/.exec(detail)?.[1];
  return status === undefined ? "" : `，上游状态码 ${status}`;
}

function modelFailureMessage(detail: string): string {
  const status = /(?:^|\D)([45]\d{2})(?:\D|$)/.exec(detail)?.[1];
  if (status === "413") return "这次带的内容太大（超过 20 MiB）";
  return `模型没回话${modelFailureStatus(detail)}。检查控制面的上游地址、key 和模型映射（.env 里的 UPSTREAM_BASE_URL、UPSTREAM_API_KEY、GATEWAY_MODELS）。`;
}

const LOGGED_DETAIL_CHARS = 80;

/** detail 是运行器原样带来的用户内容，没有长度上限。按码点截，不把一个 emoji 的两半劈开。 */
function clipDetail(detail: string): string {
  let end = 0;
  let kept = 0;
  for (const point of detail) {
    if (kept === LOGGED_DETAIL_CHARS) return `${detail.slice(0, end)}…`;
    end += point.length;
    kept += 1;
  }
  return detail;
}

async function onAgentError(deps: AgentEventDeps, conn: AgentConnection, event: AgentError): Promise<void> {
  if (event.code === "config_rejected") {
    // 不认这台电脑上的任何 config，派过去的活都会被它回成 prompt_before_config，先停派，再告诉用户为什么。
    if (!(await deps.agents.markConfigRejected(conn, event.generation))) return;
    console.warn(`电脑 ${conn.computerId} 拒了第 ${event.generation ?? "?"} 代 config：${clipDetail(event.detail)}`);
    await deps.notifications.publish(conn.ownerId, {
      kind: "stuck",
      text: `电脑上的活派不出去：${CONFIG_MISMATCH}。把电脑代理和控制面升到同一个版本再连。`,
      groupId: null,
    });
    return;
  }
  // 被拒期间代理手里没有能用的运行器，它回的 prompt_before_config 其实是版本不对，照实说。
  const reason =
    event.code === "prompt_before_config" && deps.agents.configRejected(conn.computerId)
      ? CONFIG_MISMATCH
      : ERROR_REASONS[event.code];
  const text =
    event.code === "model_failed"
      ? modelFailureMessage(event.detail)
      : `电脑那边没干成这件事，${reason}。原话是：${event.detail}`;
  if (event.runId !== undefined) {
    // runId 是外部输入，只认这台电脑上还没结束的活。已经收过尾的重报落在这里，只留一行日志。
    const run = (await openRunsForComputer(deps.db, conn.computerId)).find((open) => open.runId === event.runId);
    if (run !== undefined) await abandonRun(deps, conn.ownerId, run, { text, reason });
    else
      console.error(
        `电脑 ${conn.computerId} 报错带的 run ${event.runId} 不是它还开着的活，不收尾：${event.code} ${clipDetail(event.detail)}`,
      );
    return;
  }
  // 运行器也会发不属于某次 run 的错误。群号明确时只查该群，不带群号时必须能唯一确定进行中的活。
  const named = event.groupId === undefined ? null : await findGroupId(deps.db, conn.ownerId, event.groupId);
  if (event.groupId !== undefined && named === null) {
    console.warn(
      `电脑 ${conn.computerId} 报错指定的群已不存在或不属于归属人，不落群：${event.code} ${clipDetail(event.detail)}`,
    );
    return;
  }
  const open = await uniqueOpenRun(deps.db, conn.computerId, event.groupId);
  const groupId = named ?? open?.groupId ?? null;
  if (groupId === null) {
    console.warn(
      `电脑 ${conn.computerId} 报错没带群号，也确定不了唯一一个还开着的活，不落群：${event.code} ${clipDetail(event.detail)}`,
    );
    return;
  }
  await appendAndPush(deps, conn.ownerId, groupId, { kind: "system", tone: "error", text });
  // 指定群里有多条 open run 时仍可留群级提示，但不能替其中某一条例行任务记失败。
  if (open !== null && open.groupId === groupId) {
    await failRoutineRunOf(deps, open.runId, reason);
  }
}

async function onApprovalRequest(deps: AgentEventDeps, conn: AgentConnection, event: ApprovalRequest): Promise<void> {
  const groupId = await resolveRun(deps, conn, event);
  if (groupId === null) return;

  const [run] = await deps.db
    .select({ routineRunId: runs.routineRunId, triggerMessageId: runs.triggerMessageId })
    .from(runs)
    .where(eq(runs.id, event.runId))
    .limit(1);
  if (run === undefined) return;
  // 来源看触发消息：交接和例行 run 等十分钟，用户当面发起的 run 不设截止。
  const trigger =
    run.triggerMessageId === null
      ? null
      : await findOwnedMessage(deps.db, conn.ownerId, MessageId.parse(run.triggerMessageId), {
          kind: "bot",
          botId: event.botId,
        });
  const createdAt = new Date();
  const deadlineAt =
    run.routineRunId !== null || trigger?.body.kind === "handoff"
      ? new Date(createdAt.getTime() + APPROVAL_AUTO_REJECT_MS)
      : null;

  const created = await createApproval(deps.db, {
    runId: event.runId,
    botId: event.botId,
    groupId,
    callId: event.callId,
    tool: event.tool,
    action: event.action,
    target: event.target,
    view: event.view,
    createdAt,
    deadlineAt,
  });
  // 同一条 approval_request 重发时这里是 null：不多一张卡，也不多推一次。
  if (created === null) return;

  // 先推审批再推卡，客户端画那张卡的时候状态已经在手上了。
  deps.push.push(conn.ownerId, { type: "approval_updated", approval: created.approval });
  deps.push.push(conn.ownerId, { type: "message", message: created.message });
  await holdRoutineRunOf(deps, event.runId);
  await deps.notifications.publish(conn.ownerId, {
    kind: "confirm",
    text: "有一件事等你确认，打开「今天」看",
    groupId,
  });
}

async function onApprovalAbandoned(
  deps: AgentEventDeps,
  conn: AgentConnection,
  event: ApprovalAbandoned,
): Promise<void> {
  const scope = await approvalRun(deps.db, event.runId, event.callId);
  if (scope === null) return;
  const groupId = await resolveRun(deps, conn, {
    type: event.type,
    runId: event.runId,
    botId: scope.botId,
    groupId: scope.groupId,
  });
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

  const botName = members.find((member) => member.id === event.botId)?.name ?? "Bot";
  const done = event.checklist.filter((item) => item.done).length;
  const written = await whileRunOpen(deps.db, { runId: event.runId, botId: event.botId, groupId }, async (tx) => {
    const task = await replaceChecklist(tx, groupId, event.checklist);
    if (task === null) return null;
    const message = await appendMessage(tx, groupId, {
      kind: "system",
      text: `${botName}更新了清单，${done}/${event.checklist.length} 完成`,
    });
    return { task, message };
  });
  if (written === null) return;
  deps.push.push(conn.ownerId, { type: "task_updated", task: written.task });
  deps.push.push(conn.ownerId, { type: "message", message: written.message });
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

  const said = await whileRunOpen(deps.db, { runId: event.runId, botId: event.botId, groupId }, (tx) =>
    appendMessage(tx, groupId, {
      kind: "bot",
      botId: event.botId,
      text: event.text,
      streaming: false,
      mentions: [event.targetBotId],
    }),
  );
  if (said === null) return;
  deps.push.push(conn.ownerId, { type: "message", message: said });
  await deps.groupTurns.recordBotMessage(groupId, event.runId, said, "mention");
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
  const message = await whileRunOpen(deps.db, { runId: event.runId, botId: event.botId, groupId }, (tx) =>
    appendSkillOffer(
      tx,
      groupId,
      {
        kind: "skill_offer",
        botId: event.botId,
        name: event.name,
        steps: event.steps,
        status: "offered",
        skillId: null,
      },
      source,
    ),
  );
  if (message === null) return;
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
    const notice = await whileRunOpen(deps.db, { runId: event.runId, botId: event.botId, groupId }, (tx) =>
      deps.groupTurns.claimHandoffLimitNotice(event.runId)
        ? appendMessage(tx, groupId, { kind: "system", tone: "error", text: HANDOFF_LIMIT_NOTICE })
        : Promise.resolve(null),
    );
    if (notice !== null) deps.push.push(conn.ownerId, { type: "message", message: notice });
    return;
  }

  // run 已经收尾：交接卡不落，也不排进下一轮派活。
  const created = await whileRunOpen(deps.db, { runId: event.runId, botId: event.botId, groupId }, (tx) =>
    createHandoff(tx, {
      groupId,
      fromBotId: event.botId,
      toBotId: event.toBotId,
      done: event.done,
      notDone: event.notDone,
      next: event.next,
      checklistIndex: event.checklistIndex,
    }),
  );
  if (created === null) return;

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
  const name = members.find((member) => member.id === (event.targetBotId ?? previousChief))?.name ?? "Bot";
  const notice = await whileRunOpen(deps.db, { runId: event.runId, botId: event.botId, groupId }, async (tx) =>
    (await setChiefBotId(tx, groupId, event.targetBotId))
      ? appendMessage(tx, groupId, {
          kind: "system",
          text: `${name}${event.targetBotId === null ? "卸任首席" : "成为首席"}`,
        })
      : null,
  );
  if (notice === null) return;
  const detail = await findGroup(deps.db, conn.ownerId, groupId);
  if (detail !== null) deps.push.push(conn.ownerId, { type: "group_updated", group: detail.group });
  deps.push.push(conn.ownerId, { type: "message", message: notice });
}

/**
 * 主助理改一个项目的节奏。用户那句话本身就是决定，所以不出审批、不落卡，只推任务卡让首页和项目页刷新。
 * 项目群和发起者都是外部输入，`setProjectCadence` 那条 UPDATE 校验它们，不成立整条丢掉。
 */
async function onSetCadence(deps: AgentEventDeps, conn: AgentConnection, event: SetCadenceEvent): Promise<void> {
  const groupId = await resolveRun(deps, conn, event);
  if (groupId === null) return;
  const set = await whileRunOpen(deps.db, { runId: event.runId, botId: event.botId, groupId }, async (tx) => ({
    task: await setProjectCadence(tx, conn.ownerId, event.botId, event.projectGroupId, event.cadence),
  }));
  if (set === null) return;
  const { task } = set;
  if (task === null) {
    console.warn(
      `电脑 ${conn.computerId} 报的节奏改动指向 ${event.projectGroupId}，它不是这个用户的项目群或 ${event.botId} 不是主助理，整条丢掉`,
    );
    return;
  }
  deps.push.push(conn.ownerId, { type: "task_updated", task });
}

/**
 * 主助理出的方案卡，只落一条消息，什么都不建，要等用户点开始。
 * 只认主助理在自己单聊里发的：点卡的路由只处理单聊里的卡，队员或别的群发来的整条丢掉。
 */
async function onProjectOffer(deps: AgentEventDeps, conn: AgentConnection, event: ProjectOfferEvent): Promise<void> {
  const groupId = await resolveRun(deps, conn, event);
  if (groupId === null) return;
  const assistant = await findAssistant(deps.db, conn.ownerId);
  if (assistant === null || assistant.bot.id !== event.botId || assistant.groupId !== groupId) {
    console.warn(`电脑 ${conn.computerId} 报的方案卡来自 ${event.botId}，不是主助理在它单聊里发的，整条丢掉`);
    return;
  }
  const { name, goal, team, platforms, cadence, firstStep, goalTarget, goalUnit } = event;
  // 目标数和单位成对才算有目标，半个目标不落进卡正文。
  const target = goalTarget === undefined || goalUnit === undefined ? {} : { goalTarget, goalUnit };
  const message = await whileRunOpen(deps.db, { runId: event.runId, botId: event.botId, groupId }, (tx) =>
    appendMessage(tx, groupId, {
      kind: "project_offer",
      botId: event.botId,
      name,
      goal,
      team,
      platforms,
      cadence,
      firstStep,
      ...target,
      status: "offered",
      groupId: null,
    }),
  );
  if (message !== null) deps.push.push(conn.ownerId, { type: "message", message });
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
  // 确认和换经手在同一个事务里，跟在 run 还开着的那道检查后面：已经收尾的 run 晚到的确认，不能盖掉用户此后的选择。
  const result = await whileRunOpen(deps.db, { runId: event.runId, botId: event.botId, groupId }, async (tx) => {
    const accepted = await acceptHandoff(tx, { handoffId: event.handoffId, groupId, toBotId: event.botId, at });
    if (accepted === null) return { accepted, task: null };
    return { accepted, task: await setCurrentBot(tx, groupId, event.botId, at) };
  });
  if (result === null) return;
  const { accepted, task } = result;
  if (accepted === null) {
    console.warn(
      `电脑 ${conn.computerId} 报的确认 ${event.handoffId} 不是群 ${event.groupId} 里等 ${event.botId} 接手的交接，整条丢掉`,
    );
    return;
  }
  deps.push.push(conn.ownerId, { type: "handoff_updated", handoff: accepted });
  if (task !== null) deps.push.push(conn.ownerId, { type: "task_updated", task });
}

type DraftCreate = Extract<AgentToControl, { type: "draft_create" }>;
type PlanPropose = Extract<AgentToControl, { type: "plan_propose" }>;
type DraftEditEvent = Extract<AgentToControl, { type: "draft_edit" }>;
type PublishResult = Extract<AgentToControl, { type: "publish_result" }>;

/** 账号不是这个用户的、是只读档、GitHub 和 X 带了图，整条丢掉。运行器那边已经先挡过一道，走到这里的是外部输入。 */
async function onDraftCreate(deps: AgentEventDeps, conn: AgentConnection, event: DraftCreate): Promise<void> {
  const groupId = await resolveRun(deps, conn, event);
  if (groupId === null) return;
  const created = await createDraft(
    deps.db,
    { ownerId: conn.ownerId, groupId, botId: event.botId, runId: event.runId },
    event.draft,
  );
  if (created === null) return;
  deps.push.push(conn.ownerId, { type: "draft_updated", draft: created.draft });
  deps.push.push(conn.ownerId, { type: "message", message: created.message });
}

async function onPlanPropose(deps: AgentEventDeps, conn: AgentConnection, event: PlanPropose): Promise<void> {
  const groupId = await resolveRun(deps, conn, event);
  if (groupId === null) return;
  const proposed = await proposePlan(
    deps.db,
    { ownerId: conn.ownerId, groupId, botId: event.botId, runId: event.runId },
    event.planId,
    event.title,
    event.drafts,
  );
  if (proposed === null) return;
  for (const draft of proposed.drafts) deps.push.push(conn.ownerId, { type: "draft_updated", draft });
  deps.push.push(conn.ownerId, { type: "plan_updated", plan: proposed.plan });
  deps.push.push(conn.ownerId, { type: "message", message: proposed.message });
}

/** 内容没变也推一次：Bot 以为自己改了，卡上至少刷新一遍。 */
async function onDraftEdit(deps: AgentEventDeps, conn: AgentConnection, event: DraftEditEvent): Promise<void> {
  const groupId = await resolveRun(deps, conn, event);
  if (groupId === null) return;
  const draft = await editDraft(
    deps.db,
    { ownerId: conn.ownerId, groupId, botId: event.botId, runId: event.runId },
    event.draftId,
    event.content,
  );
  if (draft !== null) deps.push.push(conn.ownerId, { type: "draft_updated", draft });
}

/**
 * 只认发给这台电脑、还在 publishing、还是 attempt 那一次认领的草稿。重复报的、超时已经记失败的、
 * 重批以后旧那次晚到的，都不再改。
 */
async function onPublishResult(deps: AgentEventDeps, conn: AgentConnection, event: PublishResult): Promise<void> {
  const scope = {
    draftId: event.draftId,
    claimedAt: new Date(event.attempt),
    computer: { ownerId: conn.ownerId, computerId: conn.computerId },
  };
  if (event.result.status === "ok") {
    const { url, externalId } = event.result;
    await publishSucceeded(deps, scope, (platform) => ({ url: trustedPageUrl(platform, url), externalId }));
    return;
  }
  await publishFailed(deps, scope, event.result.reason);
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
