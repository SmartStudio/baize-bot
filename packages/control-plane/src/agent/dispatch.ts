import {
  toolViewText,
  type Approval,
  ApprovalId,
  type AccountId,
  BotId,
  ComputerId,
  RunId,
  UserId,
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
  type RoutineOfferStatus,
  type SkillChange,
  type SkillOfferStatus,
  type TeamOfferStatus,
  type ToolCallStatus,
  type Viewer,
} from "@baize/shared";
import type { Db } from "../db/client.js";
import { and, eq, inArray, lte, type SQL } from "drizzle-orm";
import { approvals as approvalRows, groups, runs } from "../db/schema.js";
import {
  decideApproval,
  latestPendingApproval,
  listApprovals,
  timeOutDueApprovals,
  voidPendingApprovals,
  type AutomaticApproval,
} from "../repo/approvals.js";
import { listAccounts } from "../repo/accounts.js";
import { listBotNames } from "../repo/bots.js";
import { PUBLISHING_TIERS, listDraftsForPage, listPlansForPage } from "../repo/drafts.js";
import { groupsWithQueuedHandoffs, listHandoffs, listQueuedHandoffs } from "../repo/handoffs.js";
import {
  appendMessageIfGroupAlive,
  listGroupBots,
  listMessages,
  messageSeq,
  type Tx,
  type GroupBot,
} from "../repo/messages.js";
import { findChiefBotId, findSoloBotId, groupExists, turnBotMessages } from "../repo/groups.js";
import { pushRoutineUpdated } from "../repo/routines.js";
import { listComputers } from "../repo/computers.js";
import { groupHasOpenRun, lockOwner, lockRuns, shareBotRunsLock } from "../repo/runs.js";
import { pendingLines, recordContext } from "../repo/context-window.js";
import { findTaskByGroup, listProjects, setCurrentBot } from "../repo/tasks.js";
import { PLATFORM_LABEL, titleOf } from "../publish/settle.js";
import type { PushHub } from "../ws/hub.js";
import type { NoticePublisher } from "../notifications.js";
import { enqueueDownlink, lockEnvelopeComputer } from "./envelope.js";
import { computerPreference, lockLaneComputers, placeRun, type ComputerPreference } from "./place-run.js";
import type { AgentHub } from "./hub.js";
import { computerAvailability, computerView, type AvailabilityAgents } from "./computer-availability.js";
import {
  selectAvailable,
  selectionNotice,
  type ComputerSelection,
  type SelectionFailure,
} from "./computer-selection.js";
import type { ComputerRecord } from "../repo/rows.js";
import { GroupTurns, limitReached, type ContinuationRoutine, type SendOutcome, type Speaker } from "./group-turn.js";
import { concealed, log } from "../log.js";
import { routeTargets } from "./routing.js";
import {
  breakContinuation,
  continuationSpeaker,
  DISPATCH_FAILED_BREAK,
  MEMBER_GONE_BREAK,
  pendingContinuation,
  pendingContinuationIds,
  TRIGGER_GONE_BREAK,
  unplacedBreak,
  type ChainBreak,
  type PendingContinuation,
} from "./continuation.js";

/** 送进 prompt 的上下文条数。规格没定，取一屏对话的量。 */
export const CONTEXT_MESSAGES = 20;

/** 一条上下文的正文上限，长消息在这里截断，prompt 不替 Bot 读全文。 */
const CONTEXT_TEXT_LIMIT = 200;

export const NO_TARGET_NOTICE = "这条消息没人接，@ 一个 Bot 派活";

export type DispatchDeps = {
  readonly db: Db;
  readonly push: PushHub;
  readonly agents: AgentHub;
  readonly notifications: NoticePublisher;
  readonly groupTurns?: GroupTurns;
};

export type DispatchOptions = {
  /** 例行任务到点或试跑派的活带着它，往下一路传到 `placeRun`。普通的用户消息不带。 */
  readonly routineRunId?: string | undefined;
  /** 例行任务按保存的用途选模型；普通消息不带，固定走 plan。 */
  readonly purpose?: ModelPurpose | undefined;
  /** 例行任务只派给它所属的 Bot，不走路由规则，换了首席或经手都不改它。普通消息不带。 */
  readonly botId?: BotId | undefined;
  /** 例行派的活带上它是哪条例行、什么边界，运行器按边界收紧闸门。普通消息不带。 */
  readonly routine?: PromptRoutine | undefined;
};

type PromptRoutine = NonNullable<Extract<ControlToAgent, { type: "prompt" }>["routine"]>;

/** failed：给头一位派活抛了错（比如建 run 的事务失败），群里已经留了一句，没人在跑。 */
export type DispatchOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "unplaced"; readonly reason: SelectionFailure }
  | { readonly kind: "no_target" }
  | { readonly kind: "failed" };

/** 这一版派活不要求账号，候选电脑也就不带账号，理由见 README「派到哪台电脑」。 */
export async function computerFor(
  db: Db | Tx,
  agents: AvailabilityAgents,
  ownerId: UserId,
  preference: ComputerPreference,
): Promise<ComputerSelection> {
  const computers = await listComputers(db, ownerId);
  return selectAvailable(computers, await computerAvailability(db, agents, ownerId), preference);
}

/** 派活前替头一位挑中的电脑，连同挑的时候它选的是哪种。 */
type EarlyPick = {
  readonly botId: BotId;
  readonly preference: ComputerPreference;
  readonly computer: ComputerRecord;
};

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
  const mentions = trigger.body.kind === "user" ? (trigger.body.mentions ?? []) : [];
  const [first] = mentions;
  // @ 了好几个也只认第一个当经手。单 Bot 群没有经手可言，它的任务卡也不出边界。
  // 经手换了人就推一条任务卡，不然页面要等到刷新或交接才看到新经手。送出去的任务卡也要是改完经手的那份。
  let task = await findTaskByGroup(deps.db, groupId);
  // 单聊看 groups.solo_bot_id，和运行器收方案卡的口径一致；多 Bot 群删到只剩一个成员仍是多 Bot 群。
  const solo = (await findSoloBotId(deps.db, groupId)) !== null;
  if (!solo && first !== undefined && task !== null && task.currentBotId !== first) {
    task = await setCurrentBot(deps.db, groupId, first, new Date());
    // 被 @ 的那位刚被删掉就不换经手，也就没有任务卡要推。
    if (task?.currentBotId === first) deps.push.push(ownerId, { type: "task_updated", task });
  }
  const owner = options.botId;
  // 例行的运行记录自己会留原因；用户发的消息不能静默，群里要有一句为什么没人接。
  // 群本身没了（单聊随 Bot 级联删掉）就什么都不写，noticeIfGroupAlive 在写的事务里判。
  const noTarget = async (): Promise<DispatchOutcome> => {
    if (owner === undefined) {
      await noticeIfGroupAlive(deps, ownerId, groupId, { kind: "system", tone: "error", text: NO_TARGET_NOTICE });
    }
    return { kind: "no_target" };
  };

  // 设完经手再读名单：被 @ 的那位刚删掉时名单里已经没有它，路由直接落到原经手，不会派给一个不存在的 Bot。
  // 被 @ 的人全在派活途中被删时再路由一次，这回不认 @，只退回组长或经手，不替用户扩到全员；仍没人就留一句，不静默。
  // 例行只派给它自己的 Bot，没有第二次。
  const passes = owner === undefined && mentions.length > 0 ? [mentions, []] : [[]];
  for (const [pass, effectiveMentions] of passes.entries()) {
    const members = await listGroupBots(deps.db, groupId);
    // 名单空有两种：多 Bot 群被删空，群还在，留话给人看；单聊随 Bot 没了，群也没了，没地方留。
    if (members.length === 0) return noTarget();
    // 读完名单到这里之间群可能随账号或单聊 Bot 级联删掉，触发消息跟着没了，群里没地方留话，这一轮就此结束。
    const epoch = await messageSeq(deps.db, trigger.id, { kind: "user" });
    if (epoch === null) return { kind: "no_target" };
    const chiefBotId = await findChiefBotId(deps.db, groupId);
    const currentBotId = (await findTaskByGroup(deps.db, groupId))?.currentBotId ?? null;
    if (pass > 0 && chiefBotId === null && currentBotId === null) break;
    // @ 的人已经不在名单里就当没 @，理由也跟着落到经手那档。
    const mentioned = effectiveMentions.filter((botId) => members.some((member) => member.id === botId));
    const targets =
      owner === undefined
        ? routeTargets({ members, chiefBotId, currentBotId, mentions: mentioned })
        : members.filter((member) => member.id === owner).map((member) => member.id);
    const [firstBotId] = targets;
    if (firstBotId === undefined) break;
    // 按头一位在这个群里选的电脑先挑一次，挑不到就只留一句，不作废审批、不开回合。
    // 选电脑之前账号被删（删号先断代理，这里就选不到电脑），群已随账号没了，提示写不进去也不该写。
    const preference = await computerPreference(deps.db, groupId, firstBotId);
    const selected = await computerFor(deps.db, deps.agents, ownerId, preference);
    if (selected.kind === "failed") {
      await noticeIfGroupAlive(deps, ownerId, groupId, {
        kind: "system",
        tone: "error",
        text: selectionNotice(selected.reason),
      });
      return { kind: "unplaced", reason: selected.reason };
    }
    // 头一位就用这次挑中的电脑。再挑一次的话，两次之间掉线会让它不建 run 就派空，
    // 这里却已经报了 sent，例行就一直停在运行中。后面的人要等前一个跑完才派，到时再挑。
    let early: EarlyPick | null = { botId: firstBotId, preference, computer: selected.computer };
    let voidTargets = trigger.body.kind === "user" && options.routineRunId === undefined ? targets : [];
    const reason = solo
      ? "solo"
      : mentioned.length > 0 || owner !== undefined
        ? "mentioned"
        : chiefBotId !== null
          ? "chief"
          : currentBotId !== null
            ? "current"
            : "everyone";
    const placementFailure: { reason: SelectionFailure | null } = { reason: null };
    const started = await deps.groupTurns.start({
      groupId,
      ownerId,
      epoch,
      members,
      speakers: targets.map((botId) => ({ botId, trigger, reason })),
      botMessages: 0,
      send: async (speaker, includeRecent) => {
        const pick = early?.botId === speaker.botId ? early : null;
        early = null;
        const outcome = await sendSpeaker(deps, ownerId, groupId, speaker, includeRecent, options, pick, voidTargets);
        voidTargets = [];
        if (outcome.unplacedReason !== undefined) placementFailure.reason = outcome.unplacedReason;
        return outcome;
      },
    });
    if (started === "gone") return { kind: "no_target" };
    if (started === "failed") return { kind: "failed" };
    if (placementFailure.reason !== null) return { kind: "unplaced", reason: placementFailure.reason };
    if (started !== "nobody") return { kind: "sent" };
  }
  return noTarget();
}

/**
 * 换电脑后接着做。旧 run 结账或被放弃之后调，没立标记、已经接过的直接返回。
 * 回合还在跑别的就插到最前面；没有回合就按旧 run 的触发消息开一轮，只排它一位。
 */
export async function resumeContinuation(deps: DispatchDeps & { readonly groupTurns: GroupTurns }, runId: RunId) {
  const pending = await pendingContinuation(deps.db, runId);
  if (pending !== null) await startContinuation(deps, pending);
}

/**
 * 补起欠着的接续：控制面启动、电脑 hello、定期补扫都走这里。结账提交后进程没了、内存里的回合丢了排着的接续、
 * 结账后读接续出错，留下的都是标记立着、没有接续的已结束 run，这里一条条捡起来，一条出错不挡后面的。
 * 只起选定那台此刻能派的：重启后电脑是一台台回来的，先回来的那台不能替还没回来的那台把活判成派不出去。
 * 原来的 Bot 已经不在群里的（choice 为 null）不等任何电脑，当场断链收尾。
 */
export async function resumePendingContinuations(
  deps: DispatchDeps & { readonly groupTurns: GroupTurns },
  ownerId?: UserId,
): Promise<number> {
  let started = 0;
  for (const runId of await pendingContinuationIds(deps.db, ownerId)) {
    try {
      const pending = await pendingContinuation(deps.db, runId);
      if (pending === null) continue;
      if (pending.choice !== null) {
        const availability = await computerAvailability(deps.db, deps.agents, pending.ownerId);
        if (!availability.some((one) => one.kind === pending.choice && one.dispatchable)) continue;
      }
      started += 1;
      await startContinuation(deps, pending);
    } catch (error) {
      log.error("换电脑后的接续没起来", { runId, err: concealed(error) });
    }
  }
  return started;
}

async function startContinuation(
  deps: DispatchDeps & { readonly groupTurns: GroupTurns },
  pending: PendingContinuation,
): Promise<void> {
  const { ownerId, groupId, trigger } = pending;
  if (trigger === null) {
    await endChain(deps, ownerId, groupId, pending.runId, TRIGGER_GONE_BREAK);
    return;
  }
  const speaker = continuationSpeaker(pending, trigger);
  if (speaker === null) {
    await endChain(deps, ownerId, groupId, pending.runId, MEMBER_GONE_BREAK);
    return;
  }
  if (deps.groupTurns.queueContinuation(groupId, pending.runId, speaker) === "queued") return;
  const { members, epoch, said } = await breakChainOnError(deps, ownerId, groupId, pending.runId, async () => ({
    members: await listGroupBots(deps.db, groupId),
    epoch: await messageSeq(deps.db, trigger.id, { kind: "bot", botId: pending.botId }),
    said: await turnBotMessages(deps.db, groupId),
  }));
  if (members.length === 0) {
    await endChain(deps, ownerId, groupId, pending.runId, MEMBER_GONE_BREAK);
    return;
  }
  if (epoch === null) {
    await endChain(deps, ownerId, groupId, pending.runId, TRIGGER_GONE_BREAK);
    return;
  }
  // 上面几次读库期间，同一条接续可能已经由另一个触发点开了回合：补扫和结账、hello 会同时捡到它。
  // 这里到 start 写进回合表之间没有 await，再排一次就不会开第二个回合把前一个顶掉。
  if (deps.groupTurns.queueContinuation(groupId, pending.runId, speaker) === "queued") return;
  await deps.groupTurns.start({
    groupId,
    ownerId,
    epoch,
    members,
    speakers: [speaker],
    botMessages: limitReached(said) ? 0 : said,
    send: (next, includeRecent) => sendSpeaker(deps, ownerId, groupId, next, includeRecent, {}, null, []),
  });
}

export async function resumeQueuedHandoffs(
  deps: DispatchDeps & { readonly groupTurns: GroupTurns },
  scope: { readonly ownerId?: UserId; readonly groupId?: GroupId },
): Promise<void> {
  for (const { groupId, ownerId } of await groupsWithQueuedHandoffs(deps.db, scope)) {
    try {
      await startQueuedHandoffs(deps, ownerId, groupId);
    } catch (error) {
      log.error("排着的交接没派出去", { groupId, err: concealed(error) });
    }
  }
}

async function startQueuedHandoffs(
  deps: DispatchDeps & { readonly groupTurns: GroupTurns },
  ownerId: UserId,
  groupId: GroupId,
): Promise<void> {
  if (deps.groupTurns.has(groupId) || (await groupHasOpenRun(deps.db, groupId))) return;
  const botMessages = await turnBotMessages(deps.db, groupId);
  if (limitReached(botMessages)) return;
  const [first] = await listQueuedHandoffs(deps.db, groupId);
  if (first === undefined) return;
  const preference = await computerPreference(deps.db, groupId, first.handoff.toBotId);
  if ((await computerFor(deps.db, deps.agents, ownerId, preference)).kind === "failed") return;
  const members = await listGroupBots(deps.db, groupId);
  const epoch = await messageSeq(deps.db, first.message.id, { kind: "user" });
  if (members.length === 0 || epoch === null) return;
  if (deps.groupTurns.has(groupId)) return;
  await deps.groupTurns.start({
    groupId,
    ownerId,
    epoch,
    members,
    speakers: [],
    botMessages,
    send: (next, includeRecent) => sendSpeaker(deps, ownerId, groupId, next, includeRecent, {}, null, []),
  });
}

/**
 * 接续落行提交之前的这一段抛错：接续没建出来，标记还立着，认领得到就断链收成 failed，错照旧抛给原来的接收方。
 * 提交之后的推送和发件出错不走这里，那时接续已经落了行。
 */
async function breakChainOnError<T>(
  deps: DispatchDeps,
  ownerId: UserId,
  groupId: GroupId,
  fromRunId: RunId,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    await endChain(deps, ownerId, groupId, fromRunId, DISPATCH_FAILED_BREAK).catch((ended: unknown) =>
      log.error("接续没起来，收尾也出错", { runId: fromRunId, groupId, err: concealed(ended) }),
    );
    throw error;
  }
}

/**
 * 链断了：收尾、推例行。收成 failed 的主人多半不在群里，找他一次；stopped 是他自己换下了牌友，不找。
 * 停机期间一律不收：派不出去、读库出错都可能只是停机关掉了连接，标记留着，重启后的补扫再判。
 */
async function endChain(
  deps: DispatchDeps,
  ownerId: UserId,
  groupId: GroupId,
  fromRunId: RunId,
  end: ChainBreak,
): Promise<void> {
  if (deps.agents.closing) return;
  const ended = await breakContinuation(deps.db, fromRunId, end);
  if (ended === null) return;
  await pushRoutineUpdated(deps, ended.routineId);
  if (end.status === "failed")
    await deps.notifications.publish(ownerId, {
      kind: "stuck",
      text: `例行任务「${ended.name}」没跑完：${end.note}`,
      groupId,
    });
}

function continuationOptions(routine: ContinuationRoutine | null): DispatchOptions {
  return routine === null
    ? {}
    : { purpose: routine.purpose, routine: { routineId: routine.routineId, boundary: routine.boundary } };
}

type PromptOrigin = Extract<ControlToAgent, { type: "prompt" }>["origin"];

/** 发信 Bot 已经不在群里时退回 user：报文是它留下的，但没有名字可署。 */
function botOrigin(members: readonly GroupBot[], botId: BotId): PromptOrigin {
  const bot = members.find((member) => member.id === botId);
  return bot === undefined ? { kind: "user" } : { kind: "bot", id: bot.id, name: bot.name, tags: bot.tags };
}

async function sendSpeaker(
  deps: DispatchDeps,
  ownerId: UserId,
  groupId: GroupId,
  speaker: Speaker,
  includeRecent: boolean,
  options: DispatchOptions,
  early: EarlyPick | null,
  voidTargets: readonly BotId[],
): Promise<SendOutcome & { readonly unplacedReason?: SelectionFailure }> {
  const continuation = speaker.continuation;
  // 接续不管排在谁的回合里，都按自己父链的例行配置发；回合的 options 属于回合的发起者。
  const own = continuation === undefined ? options : continuationOptions(continuation.routine);
  const place = () => placeSpeaker(deps, ownerId, groupId, speaker, includeRecent, own, early, voidTargets);
  const placedRun =
    continuation === undefined
      ? await place()
      : await breakChainOnError(deps, ownerId, groupId, continuation.fromRunId, place);
  await publishAutomaticApprovals(deps, placedRun.voided);
  // 跳过的接续要么已经由别处起过（认领不到，收尾是空操作），要么这一位已经不在群里。
  if (placedRun.kind === "skipped" && continuation !== undefined)
    await endChain(deps, ownerId, groupId, continuation.fromRunId, MEMBER_GONE_BREAK);
  if (placedRun.kind === "skipped")
    return (await groupExists(deps.db, groupId)) ? { kind: "skipped" } : { kind: "gone" };
  if (placedRun.kind === "queued")
    for (const computerId of placedRun.flushComputerIds) await deps.agents.flushOutbox(computerId);
  // 停机时派不出去不算结局，不说也不收，理由见 endChain。
  if (placedRun.kind === "unavailable" && continuation !== undefined && deps.agents.closing) return { kind: "stopped" };
  if (placedRun.kind === "unavailable") {
    // 等电脑锁期间租约可能过期、后面的人轮到时电脑可能已经不在，真实选机失败还要传回例行，让它结成 failed 并推 stuck。
    // 接续派不出去就说明白、把标记清掉，例行的运行记录按同一句原因收成失败；不改派到另一台，也不等电脑回来再补起：
    // 用户看到这句自己决定。
    if (continuation !== undefined)
      await endChain(deps, ownerId, groupId, continuation.fromRunId, unplacedBreak(placedRun.reason));
    const written = await noticeIfGroupAlive(deps, ownerId, groupId, {
      kind: "system",
      tone: "error",
      text: selectionNotice(placedRun.reason, { continuation: continuation !== undefined }),
    });
    return written ? { kind: "stopped", unplacedReason: placedRun.reason } : { kind: "gone" };
  }
  return { kind: "sent", runId: placedRun.runId };
}

/** 读齐派这一位要的东西、在一个事务里落行。抛错时事务回滚，什么都没落。 */
async function placeSpeaker(
  deps: DispatchDeps,
  ownerId: UserId,
  groupId: GroupId,
  speaker: Speaker,
  includeRecent: boolean,
  options: DispatchOptions,
  early: EarlyPick | null,
  voidTargets: readonly BotId[],
) {
  // 每派一位都重读成员表：同一回合里排在后面的人等到派活时，前面可能有人已经被删了。
  const members = await listGroupBots(deps.db, groupId);
  // 接续不带群历史、任务卡和名单：上一轮的对话都在运行器的会话里，整段提示就是 continuation.text。
  const continuation = speaker.continuation;
  const contextMessages =
    continuation === undefined ? await contextMessagesFor(deps.db, groupId, speaker, includeRecent) : [];
  const chiefBotId = await findChiefBotId(deps.db, groupId);
  const solo = (await findSoloBotId(deps.db, groupId)) !== null;
  const task = await findTaskByGroup(deps.db, groupId);
  const roster = members.map(({ id, name, tags, description }) => ({
    id,
    name,
    tags,
    description,
    seat: id === chiefBotId ? ("chief" as const) : ("member" as const),
  }));
  const group = {
    id: groupId,
    number: task?.number ?? "",
    title: task?.title ?? "",
    kind: solo ? ("solo" as const) : ("team" as const),
  };
  const origin: PromptOrigin =
    speaker.handoff !== undefined
      ? botOrigin(members, speaker.handoff.fromBotId)
      : speaker.trigger.body.kind === "bot"
        ? botOrigin(members, speaker.trigger.body.botId)
        : { kind: options.routineRunId === undefined && options.routine === undefined ? "user" : "routine" };
  // 只有主助理拿项目清单，它才能把一句「下周多发点小红书」落到某个项目的节奏上。
  const speakerRole = members.find((member) => member.id === speaker.botId)?.role;
  const projects = speakerRole === "assistant" ? await listProjects(deps.db, ownerId) : undefined;
  return deps.db.transaction(async (tx) => {
    await lockOwner(tx, ownerId, "shared");
    for (const botId of [...new Set([speaker.botId, ...voidTargets])].toSorted()) await shareBotRunsLock(tx, botId);
    // 待批范围只能在电脑锁之后读；旧 run 在别的电脑上时也必须按同一顺序锁齐。
    await lockLaneComputers(tx, ownerId);
    const scopes =
      voidTargets.length === 0
        ? []
        : await pendingApprovalDeliveries(
            tx,
            and(inArray(approvalRows.botId, [...voidTargets]), eq(approvalRows.groupId, groupId)),
          );
    const voided: AutomaticApproval[] = [];
    const voidApprovals = async (): Promise<void> => {
      await lockRuns(
        tx,
        scopes.map((scope) => scope.runId),
      );
      for (const botId of voidTargets) {
        voided.push(
          ...(await voidPendingApprovals(
            tx,
            botId,
            groupId,
            new Date(),
            scopes.map((scope) => scope.id),
          )),
        );
      }
      await enqueueAutomaticApprovals(tx, voided, "voided");
    };
    const result = await placeRun(
      tx,
      {
        ownerId,
        botId: speaker.botId,
        groupId,
        triggerMessageId: speaker.trigger.id,
        routineRunId: options.routineRunId,
        ...(continuation === undefined ? {} : { continuesRunId: continuation.fromRunId }),
        ...(speaker.handoff === undefined ? {} : { handoffId: speaker.handoff.id }),
        prompt: async (runId, _messageId, placed) => {
          await voidApprovals();
          // 窗口保留派活前读到的消息，只刷新本次作废后的卡片结论。接续没读窗口，也不记名单，免得把旧 run 没定稿的行划掉。
          const context = await summarizeAll(tx as unknown as Db, ownerId, contextMessages, speaker.botId, members);
          if (continuation === undefined)
            await recordContext(
              tx as unknown as Db,
              runId,
              { kind: "bot", botId: speaker.botId },
              {
                unsettled: context.filter((line) => !line.settled).map((line) => line.messageId),
                settled: context.filter((line) => line.settled).map((line) => line.messageId),
              },
            );
          return {
            type: "prompt",
            botId: speaker.botId,
            groupId,
            messageId: speaker.trigger.id,
            text: continuation?.text ?? speaker.handoff?.text ?? triggerText(speaker.trigger.body),
            origin,
            reason: speaker.reason,
            group,
            context,
            purpose: options.purpose ?? "plan",
            routine: options.routine ?? null,
            table: null,
            task: solo || continuation !== undefined ? null : task,
            members: continuation === undefined ? roster : [],
            ...(projects === undefined ? {} : { projects }),
            ...(speaker.handoff === undefined ? {} : { handoffId: speaker.handoff.id }),
            computer: computerView(
              await computerAvailability(tx, deps.agents, ownerId),
              placed.computerId,
              placed.preference,
            ),
          };
        },
      },
      // 锁里读到的选择和事先挑的时候不一样（中间用户换了），按锁里的重挑。
      async (preference): Promise<ComputerSelection> =>
        early !== null && early.preference === preference
          ? { kind: "selected", computer: early.computer }
          : computerFor(tx, deps.agents, ownerId, preference),
    );
    if (result.kind !== "queued") await voidApprovals();
    // Bot 在派活途中被删了只跳过它；单聊群已级联删掉时另报群没了。接续或交接已经由别处起过了也只跳过。
    if (result.kind === "not_member" || result.kind === "taken") return { kind: "skipped", voided } as const;
    if (result.kind === "unplaced") return { kind: "unavailable", reason: result.reason, voided } as const;
    return { ...result, voided };
  });
}

function triggerText(body: MessageBody): string {
  if (body.kind === "user") return body.text;
  return body.kind === "bot" ? body.text : "";
}

type ContextLine = {
  readonly messageId: Message["id"];
  readonly from: string;
  readonly text: string;
  readonly settled: boolean;
};

/**
 * 窗口前面接着送的上限，留最新的。还没定稿的行每轮都带，永远停在半截的消息、一直没发出去的草稿也占着位置，
 * 超出的最老几条就此不再送。
 */
const CONTEXT_CATCHUP = 10;

/**
 * 最近 20 条，前面再接上这个 Bot 最近几次进了会话的派活读到时没定稿、之后也没有哪次读到它定稿、这次滑出窗口的行。
 * 还没定稿的照送，字没变运行器的水位会挡掉，变了就拼；定稿那一轮整句再拼一次，记成读过定稿，之后不再送。
 */
async function contextMessagesFor(
  db: Db,
  groupId: GroupId,
  speaker: Speaker,
  includeRecent: boolean,
): Promise<Message[]> {
  const viewer: Viewer = { kind: "bot", botId: speaker.botId };
  const window = await recentBodies(db, groupId, speaker.trigger, viewer, includeRecent);
  const inWindow = new Set([speaker.trigger.id, ...window.map(({ id }) => id)]);
  const carried = (await pendingLines(db, groupId, speaker.botId, viewer))
    .filter((message) => !inWindow.has(message.id))
    .slice(-CONTEXT_CATCHUP);
  return [...carried, ...window];
}

async function recentBodies(
  db: Db,
  groupId: GroupId,
  trigger: Message,
  viewer: Viewer,
  includeRecent: boolean,
): Promise<Message[]> {
  const result = await listMessages(db, groupId, viewer, {
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
  /** 建队卡上 existing 那几行指的 Bot 现在叫什么。卡正文只有 botId，删掉的查不到。 */
  readonly botNames: ReadonlyMap<BotId, string>;
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
  const [approvals, handoffs, drafts, plans, accounts, botNames] = await Promise.all([
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
    listBotNames(
      db,
      ownerId,
      bodies.flatMap((body) =>
        body.kind === "team_offer" ? body.members.flatMap((one) => (one.kind === "existing" ? [one.botId] : [])) : [],
      ),
    ),
  ]);
  const cards: CardRows = {
    approvals: byId(approvals),
    handoffs: byId(handoffs),
    drafts: byId(drafts),
    plans: byId(plans),
    publishingAccounts: new Set(
      accounts.filter(({ tier }) => PUBLISHING_TIERS.some((one) => one === tier)).map(({ id }) => id),
    ),
    botNames,
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
  voided: "你发了新消息，这一步作废了",
  timed_out: "10 分钟没人批，按拒绝处理",
};

const TOOL_CALL_OUTCOME: Record<ToolCallStatus, string> = {
  running: "还没跑完",
  ok: "跑完了",
  failed: "没跑成",
  blocked: "被拦下了，没执行",
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

// 卡上提议的那一句和点了之后的结论。装的卡带上从哪装，改名的写出前后两个名字。
function skillOfferSentence(change: SkillChange, status: SkillOfferStatus): string {
  const outcome = (saved: string, dismissed: string): string => ({ offered: "还在等你定", saved, dismissed })[status];
  switch (change.op) {
    case "add":
      return change.origin === null
        ? `提议存成 skill「${change.name}」，${outcome("你存了", "你没存")}`
        : `提议从 ${new URL(change.origin).host} 装 skill「${change.name}」，${outcome("你装了", "你没装")}`;
    case "edit":
      return change.fromName === change.name
        ? `提议改 skill「${change.name}」，${outcome("你改了", "你没改")}`
        : `提议把 skill「${change.fromName}」改成「${change.name}」，${outcome("你改了", "你没改")}`;
    case "remove":
      return `提议删掉 skill「${change.name}」，${outcome("你删了", "你没删")}`;
  }
}

const PREFERENCE_OFFER_OUTCOME: Record<Extract<MessageBody, { kind: "preference_offer" }>["status"], string> = {
  offered: "还在等你定",
  saved: "你让记住了",
  dismissed: "你说不用记",
};

const PROJECT_OFFER_OUTCOME: Record<Extract<MessageBody, { kind: "project_offer" }>["status"], string> = {
  offered: "还在等你点开始",
  started: "你点了开始，项目群建好了",
  dismissed: "你没要",
};

const TEAM_OFFER_OUTCOME: Record<TeamOfferStatus, string> = {
  offered: "还在等你定",
  confirmed: "你确认了，人都拉进群了",
  deferred: "你说先放着，还没定",
  dismissed: "你没要",
};

const ROUTINE_OFFER_OUTCOME: Record<RoutineOfferStatus, string> = {
  offered: "还在等你点加上",
  added: "你点了加上，例行建好了",
  dismissed: "你没要",
};

// 卡停在哪些状态就不会再变，即上下文行的 settled。还会变的标 false，状态一变字就变，运行器的水位会把整句再拼一次。
const APPROVAL_SETTLED: Record<Approval["status"], boolean> = {
  pending: false,
  approved: true,
  rejected: true,
  expired: true,
  voided: true,
  timed_out: true,
};

const HANDOFF_SETTLED: Record<Handoff["status"], boolean> = { pending: false, accepted: true };

// 工具行只有 running 还会变。run 收尾时还停在 running 的会被改成 failed，所以不会永远标没定稿。
const TOOL_CALL_SETTLED: Record<ToolCallStatus, boolean> = { running: false, ok: true, failed: true, blocked: true };

// 发出去之前都还会变：批了的等着发或者改了档再发，退回的和没发出去的 Bot 还能改了再交，改完回到待看。
const DRAFT_SETTLED: Record<Draft["status"], boolean> = {
  pending: false,
  approved: false,
  publishing: false,
  published: true,
  returned: false,
  failed: false,
};

const PLAN_SETTLED: Record<ContentPlan["status"], boolean> = { pending: false, approved: true, returned: true };

const SKILL_OFFER_SETTLED: Record<Extract<MessageBody, { kind: "skill_offer" }>["status"], boolean> = {
  offered: false,
  saved: true,
  dismissed: true,
};

const PREFERENCE_OFFER_SETTLED: Record<Extract<MessageBody, { kind: "preference_offer" }>["status"], boolean> = {
  offered: false,
  saved: true,
  dismissed: true,
};

const PROJECT_OFFER_SETTLED: Record<Extract<MessageBody, { kind: "project_offer" }>["status"], boolean> = {
  offered: false,
  started: true,
  dismissed: true,
};

const TEAM_OFFER_SETTLED: Record<TeamOfferStatus, boolean> = {
  offered: false,
  confirmed: true,
  deferred: false,
  dismissed: true,
};

const ROUTINE_OFFER_SETTLED: Record<RoutineOfferStatus, boolean> = { offered: false, added: true, dismissed: true };

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
  // settled 说的是这一行的字还会不会变，运行器的水位靠它决定下一轮要不要再拼一次。
  const line = (from: string, text: string, settled = true): ContextLine => ({
    messageId: message.id,
    from,
    text,
    settled,
  });
  const who = (botId: BotId | null) => sender(botId, recipient, members);
  switch (body.kind) {
    case "user":
      return line("你", clip(body.text));
    case "bot":
      return line(who(body.botId), clip(body.text), !body.streaming);
    case "system":
      return line("系统", clip(body.text));
    case "tool_call":
      return line(
        who(body.botId),
        `${clip(toolViewText(body.view))}，${TOOL_CALL_OUTCOME[body.status]}`,
        TOOL_CALL_SETTLED[body.status],
      );
    case "cost":
      return null;
    case "approval": {
      const approval = cards.approvals.get(body.approvalId);
      if (approval === undefined) return null;
      return line(
        "系统",
        `${who(approval.botId)}${clip(toolViewText(approval.view))}，${APPROVAL_OUTCOME[approval.status]}`,
        APPROVAL_SETTLED[approval.status],
      );
    }
    case "handoff": {
      const handoff = cards.handoffs.get(body.handoffId);
      if (handoff === undefined) return null;
      const to = who(handoff.toBotId);
      return line(
        "系统",
        `${who(handoff.fromBotId)}把活交给${to}，下一步是「${clip(handoff.next)}」，${HANDOFF_OUTCOME[handoff.status](to)}`,
        HANDOFF_SETTLED[handoff.status],
      );
    }
    case "draft": {
      const draft = cards.drafts.get(body.draftId);
      if (draft === undefined) return null;
      const noun = draft.content.kind === "reply" ? "回复" : "草稿";
      return line(
        "系统",
        `${who(draft.botId)}起草的${noun}「${titleOf(draft)}」（${PLATFORM_LABEL[draft.platform]}），${DRAFT_OUTCOME[draft.status](cards.publishingAccounts.has(draft.accountId))}`,
        DRAFT_SETTLED[draft.status],
      );
    }
    case "plan": {
      const plan = cards.plans.get(body.planId);
      if (plan === undefined) return null;
      return line(
        "系统",
        `${who(plan.botId)}排的内容计划「${plan.title}」共 ${plan.draftIds.length} 篇，${PLAN_OUTCOME[plan.status]}`,
        PLAN_SETTLED[plan.status],
      );
    }
    case "skill_offer":
      return line("系统", skillOfferSentence(body.change, body.status), SKILL_OFFER_SETTLED[body.status]);
    case "preference_offer":
      return line(
        "系统",
        `提议记住「${body.text}」，${PREFERENCE_OFFER_OUTCOME[body.status]}`,
        PREFERENCE_OFFER_SETTLED[body.status],
      );
    case "project_offer":
      return line(
        "系统",
        `${who(body.botId)}出的方案卡「${body.name}」，${PROJECT_OFFER_OUTCOME[body.status]}`,
        PROJECT_OFFER_SETTLED[body.status],
      );
    case "team_offer": {
      const names = body.members.map((one) =>
        one.kind === "new" ? one.name : (cards.botNames.get(one.botId) ?? "已删除的 Bot"),
      );
      return line(
        "系统",
        `${who(body.botId)}提议拉${names.join("、")}进项目群，${TEAM_OFFER_OUTCOME[body.status]}`,
        TEAM_OFFER_SETTLED[body.status],
      );
    }
    case "routine_offer":
      return line(
        "系统",
        `${who(body.botId)}提议的例行「${body.name}」（cron ${body.cron}），${ROUTINE_OFFER_OUTCOME[body.status]}`,
        ROUTINE_OFFER_SETTLED[body.status],
      );
  }
}

/** 收件人看自己只看到自己的名字，看别人带上 tags 才分得清同名的两位。 */
function sender(botId: BotId | null, recipient: BotId, members: readonly GroupBot[]): string {
  const member = botId === null ? undefined : members.find((one) => one.id === botId);
  if (member === undefined) return "别的 Bot";
  if (member.id === recipient) return member.name;
  return member.tags.length === 0 ? member.name : `${member.name} · ${member.tags.join("、")}`;
}

function clip(text: string): string {
  if (text.length <= CONTEXT_TEXT_LIMIT) return text;
  const clipped = text.slice(0, CONTEXT_TEXT_LIMIT);
  // JSONB 拒收孤立代理项，不能把边界上的 emoji 截成半个字符。
  const last = clipped.charCodeAt(clipped.length - 1);
  return `${last >= 0xd800 && last <= 0xdbff ? clipped.slice(0, -1) : clipped}…`;
}

/** 群还在就留一句提示并推送，回 true；群已删就一个字不写，回 false。 */
async function noticeIfGroupAlive(
  deps: DispatchDeps,
  ownerId: UserId,
  groupId: string,
  body: MessageBody,
): Promise<boolean> {
  const message = await appendMessageIfGroupAlive(deps.db, groupId, body);
  if (message === null) return false;
  deps.push.push(ownerId, { type: "message", message });
  return true;
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
  | { readonly kind: "already_decided"; readonly approval: Approval | null }
  | { readonly kind: "scope_not_allowed"; readonly error: string };

type ApprovalDelivery = {
  readonly id: ApprovalId;
  readonly runId: RunId;
  readonly ownerId: UserId;
  readonly botId: BotId;
  readonly computerId: ComputerId | null;
};

async function pendingApprovalDeliveries(tx: Tx, condition: SQL | undefined): Promise<ApprovalDelivery[]> {
  const rows = await tx
    .select({
      id: approvalRows.id,
      runId: approvalRows.runId,
      ownerId: groups.ownerId,
      botId: approvalRows.botId,
      computerId: runs.computerId,
    })
    .from(approvalRows)
    .innerJoin(groups, eq(groups.id, approvalRows.groupId))
    .innerJoin(runs, eq(runs.id, approvalRows.runId))
    .where(and(eq(approvalRows.status, "pending"), condition));
  return rows.map((row) => ({
    id: ApprovalId.parse(row.id),
    runId: RunId.parse(row.runId),
    ownerId: UserId.parse(row.ownerId),
    botId: BotId.parse(row.botId),
    computerId: row.computerId === null ? null : ComputerId.parse(row.computerId),
  }));
}

/** 自动结算也先锁归属人、Bot、电脑，再锁 run 和审批；多台电脑按 id 排，避免切机后反序。 */
async function lockApprovalDeliveries(
  tx: Tx,
  scopes: readonly ApprovalDelivery[],
  extraComputers: readonly ComputerId[] = [],
): Promise<void> {
  for (const ownerId of [...new Set(scopes.map((scope) => scope.ownerId))].toSorted())
    await lockOwner(tx, ownerId, "shared");
  for (const botId of [...new Set(scopes.map((scope) => scope.botId))].toSorted()) await shareBotRunsLock(tx, botId);
  const computers = [
    ...new Set([
      ...extraComputers,
      ...scopes.flatMap((scope) => (scope.computerId === null ? [] : [scope.computerId])),
    ]),
  ].toSorted();
  for (const computerId of computers) await lockEnvelopeComputer(tx, computerId);
}

async function enqueueAutomaticApprovals(
  tx: Tx,
  decided: readonly AutomaticApproval[],
  outcome: "voided" | "timed_out",
): Promise<void> {
  for (const item of decided) {
    if (item.computerId === null) continue;
    await enqueueDownlink(
      tx,
      item.computerId,
      {
        type: "approval_result",
        runId: item.approval.runId,
        callId: item.callId,
        outcome,
      },
      item.approval.runId,
    );
  }
}

async function publishAutomaticApprovals(deps: DispatchDeps, decided: readonly AutomaticApproval[]): Promise<void> {
  for (const computerId of new Set(decided.flatMap((item) => (item.computerId === null ? [] : [item.computerId])))) {
    await deps.agents.flushOutbox(computerId);
  }
  for (const item of decided) deps.push.push(item.ownerId, { type: "approval_updated", approval: item.approval });
}

export async function settleApprovalTimeouts(deps: DispatchDeps, now: Date, approvalId?: ApprovalId): Promise<number> {
  const decided = await deps.db.transaction(async (tx) => {
    const scopes = await pendingApprovalDeliveries(
      tx,
      and(lte(approvalRows.deadlineAt, now), approvalId === undefined ? undefined : eq(approvalRows.id, approvalId)),
    );
    await lockApprovalDeliveries(tx, scopes);
    await lockRuns(
      tx,
      scopes.map((scope) => scope.runId),
    );
    const timedOut = await timeOutDueApprovals(
      tx,
      now,
      scopes.map((scope) => scope.id),
    );
    await enqueueAutomaticApprovals(tx, timedOut, "timed_out");
    return timedOut;
  });
  await publishAutomaticApprovals(deps, decided);
  return decided.length;
}

/** 批准产生授权时，提交后先重发 config 再放行，紧接着的调用才能看到授权。 */
export async function settleApproval(
  deps: DispatchDeps,
  ownerId: UserId,
  approvalId: ApprovalId,
  request: DecideApprovalRequest,
): Promise<SettleResult> {
  const now = new Date();
  const { outcome, timedOut } = await deps.db.transaction(async (tx) => {
    const scopes = await pendingApprovalDeliveries(tx, eq(approvalRows.id, approvalId));
    await lockApprovalDeliveries(tx, scopes);
    await lockRuns(
      tx,
      scopes.map((scope) => scope.runId),
    );
    const result = await decideApproval(tx as unknown as Db, ownerId, approvalId, request, now);
    const expired =
      result.kind === "already_decided"
        ? await timeOutDueApprovals(
            tx,
            now,
            scopes.map((scope) => scope.id),
          )
        : [];
    await enqueueAutomaticApprovals(tx, expired, "timed_out");
    if (result.kind === "already_decided") {
      const [approval] = await listApprovals(tx as unknown as Db, [approvalId]);
      return { outcome: { kind: "already_decided" as const, approval: approval ?? null }, timedOut: expired };
    }
    if (result.kind === "decided" && result.decided.computerId !== null) {
      const decided = result.decided;
      await enqueueDownlink(
        tx,
        result.decided.computerId,
        {
          type: "approval_result",
          runId: decided.runId,
          callId: decided.callId,
          outcome: request.decision,
        },
        decided.runId,
      );
    }
    return { outcome: result, timedOut: expired };
  });
  await publishAutomaticApprovals(deps, timedOut);
  if (outcome.kind !== "decided") return outcome;
  const { decided } = outcome;
  if (decided.grant !== null) await deps.agents.sendConfig(ownerId);
  if (decided.computerId !== null) await deps.agents.flushOutbox(decided.computerId);
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
  const pending = await latestPendingApproval(deps.db, groupId, { kind: "user" });
  if (pending === null) return false;
  const settled = await settleApproval(deps, ownerId, pending, decision);
  return settled.kind === "ok";
}
