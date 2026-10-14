import {
  toolViewText,
  type Approval,
  ApprovalId,
  type AccountId,
  BotId,
  ComputerId,
  RunId,
  UserId,
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
  type RoutineOfferStatus,
  type TeamOfferStatus,
  type ToolCallStatus,
  type Viewer,
} from "@baize/shared";
import type { Db } from "../db/client.js";
import { and, eq, inArray, lte, sql, type SQL } from "drizzle-orm";
import { approvals as approvalRows, computers as computerRows, groups, runs } from "../db/schema.js";
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
import { listHandoffs } from "../repo/handoffs.js";
import {
  appendMessageIfGroupAlive,
  listGroupBots,
  listMessages,
  messageSeq,
  type Tx,
  type GroupBot,
} from "../repo/messages.js";
import { findChiefBotId, findSoloBotId, groupExists } from "../repo/groups.js";
import { listComputers } from "../repo/computers.js";
import { lockOwner, lockRuns, shareBotRunsLock } from "../repo/runs.js";
import { pendingLines, recordContext } from "../repo/context-window.js";
import { findTaskByGroup, listProjects, setCurrentBot } from "../repo/tasks.js";
import { PLATFORM_LABEL, titleOf } from "../publish/settle.js";
import type { PushHub } from "../ws/hub.js";
import { enqueueDownlink, lockEnvelopeComputer } from "./envelope.js";
import { lockLaneComputers, placeRun } from "./place-run.js";
import type { AgentHub } from "./hub.js";
import {
  selectComputer,
  selectionNotice,
  type ComputerSelection,
  type SelectionFailure,
} from "./computer-selection.js";
import { GroupTurns, type SendOutcome, type Speaker } from "./group-turn.js";
import { routeTargets } from "./routing.js";

/** 送进 prompt 的上下文条数。规格没定，取一屏对话的量。 */
export const CONTEXT_MESSAGES = 20;

/** 一条上下文的正文上限，长消息在这里截断，prompt 不替 Bot 读全文。 */
const CONTEXT_TEXT_LIMIT = 200;

export const NO_TARGET_NOTICE = "这条消息没人接，@ 一个 Bot 派活";

export type DispatchDeps = {
  readonly db: Db;
  readonly push: PushHub;
  readonly agents: AgentHub;
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

/**
 * 这一版派活不要求账号，候选电脑也就不带账号，理由见 README「派到哪台电脑」。
 * 拒了 config 的电脑连着却派不了活，按「不在线」选不中时把真实原因说出来：版本对不上，升级或重启电脑上的白泽就好。
 */
export async function computerFor(
  db: Db,
  agents: Pick<AgentHub, "isOnline" | "configRejected"> & Partial<Pick<AgentHub, "canDeliver">>,
  ownerId: UserId,
): Promise<ComputerSelection> {
  const computers = await listComputers(db, ownerId);
  const liveRows = await db
    .select({ id: computerRows.id })
    .from(computerRows)
    .where(and(eq(computerRows.ownerId, ownerId), sql`${computerRows.leaseUntil} > clock_timestamp()`));
  const live = new Set(liveRows.map((row) => row.id));
  const selectedOnline = selectComputer(
    [],
    computers.map((computer) => ({
      computer:
        agents.isOnline(computer.id) && live.has(computer.id)
          ? { ...computer, status: "online" }
          : computer.status === "online"
            ? { ...computer, status: "sleeping" }
            : computer,
      accounts: [],
    })),
  );
  const selected =
    selectedOnline.kind === "failed" && agents.canDeliver !== undefined
      ? selectComputer(
          [],
          computers.map((computer) => ({
            computer: {
              ...computer,
              status:
                agents.canDeliver!(computer.id) && live.has(computer.id) ? ("online" as const) : ("sleeping" as const),
            },
            accounts: [],
          })),
        )
      : selectedOnline;
  if (selected.kind === "failed" && computers.some((computer) => agents.configRejected(computer.id))) {
    return { kind: "failed", reason: "config_rejected" };
  }
  return selected;
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

  const selected = await computerFor(deps.db, deps.agents, ownerId);
  if (selected.kind === "failed") {
    // 选电脑之前账号被删（删号先断代理，这里就选不到电脑），群已随账号没了，提示写不进去也不该写。
    await noticeIfGroupAlive(deps, ownerId, groupId, {
      kind: "system",
      tone: "error",
      text: selectionNotice(selected.reason),
    });
    return { kind: "unplaced", reason: selected.reason };
  }
  // 头一个 speaker 就用这次选中的电脑。再选一次的话，两次之间掉线会让它不建 run 就派空，
  // 这里却已经报了 sent，例行就一直停在运行中。后面的 speaker 要等前一个跑完才派，到时再选。
  let placed: Computer | null = selected.computer;
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
    if (targets.length === 0) break;
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
      send: async (speaker, includeRecent) => {
        const computer = placed;
        placed = null;
        const outcome = await sendSpeaker(
          deps,
          ownerId,
          groupId,
          speaker,
          includeRecent,
          options,
          computer,
          voidTargets,
        );
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
  placed: Computer | null,
  voidTargets: readonly BotId[],
): Promise<SendOutcome & { readonly unplacedReason?: SelectionFailure }> {
  const selected: ComputerSelection =
    placed === null ? await computerFor(deps.db, deps.agents, ownerId) : { kind: "selected", computer: placed };
  if (selected.kind === "failed") {
    const written = await noticeIfGroupAlive(deps, ownerId, groupId, {
      kind: "system",
      tone: "error",
      text: selectionNotice(selected.reason),
    });
    return written ? { kind: "stopped", unplacedReason: selected.reason } : { kind: "gone" };
  }

  // 每派一位都重读成员表：同一回合里排在后面的人等到派活时，前面可能有人已经被删了。
  const members = await listGroupBots(deps.db, groupId);
  const contextMessages = await contextMessagesFor(deps.db, groupId, speaker, includeRecent);
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
        : { kind: options.routineRunId === undefined ? "user" : "routine" };
  // 只有主助理拿项目清单，它才能把一句「下周多发点小红书」落到某个项目的节奏上。
  const speakerRole = members.find((member) => member.id === speaker.botId)?.role;
  const projects = speakerRole === "assistant" ? await listProjects(deps.db, ownerId) : undefined;
  const placedRun = await deps.db.transaction(async (tx) => {
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
        prompt: async (runId) => {
          await voidApprovals();
          // 窗口保留派活前读到的消息，只刷新本次作废后的卡片结论。
          const context = await summarizeAll(tx as unknown as Db, ownerId, contextMessages, speaker.botId, members);
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
            text: speaker.handoff?.text ?? triggerText(speaker.trigger.body),
            origin,
            reason: speaker.reason,
            group,
            context,
            purpose: options.purpose ?? "plan",
            routine: options.routine ?? null,
            table: null,
            task: solo ? null : task,
            members: roster,
            ...(projects === undefined ? {} : { projects }),
            ...(speaker.handoff === undefined ? {} : { handoffId: speaker.handoff.id }),
          };
        },
      },
      async () => selected,
    );
    if (result.kind !== "queued") await voidApprovals();
    // Bot 在派活途中被删了只跳过它；单聊群已级联删掉时另报群没了。
    if (result.kind === "not_member") return { kind: "skipped", voided } as const;
    if (result.kind === "unplaced") return { kind: "unavailable", reason: result.reason, voided } as const;
    return { ...result, voided };
  });
  await publishAutomaticApprovals(deps, placedRun.voided);
  if (placedRun.kind === "skipped")
    return (await groupExists(deps.db, groupId)) ? { kind: "skipped" } : { kind: "gone" };
  if (placedRun.kind === "queued")
    for (const computerId of placedRun.flushComputerIds) await deps.agents.flushOutbox(computerId);
  if (placedRun.kind === "unavailable") {
    // 等电脑锁期间租约可能过期，真实选机失败还要传回例行，让它结成 failed 并推 stuck。
    const written = await noticeIfGroupAlive(deps, ownerId, groupId, {
      kind: "system",
      tone: "error",
      text: selectionNotice(placedRun.reason),
    });
    return written ? { kind: "stopped", unplacedReason: placedRun.reason } : { kind: "gone" };
  }
  return { kind: "sent", runId: placedRun.runId };
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

const SKILL_OFFER_OUTCOME: Record<Extract<MessageBody, { kind: "skill_offer" }>["status"], string> = {
  offered: "还在等你定",
  saved: "你存了",
  dismissed: "你没存",
};

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
      return line(
        "系统",
        `问过要不要存成 skill「${body.name}」，${SKILL_OFFER_OUTCOME[body.status]}`,
        SKILL_OFFER_SETTLED[body.status],
      );
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
