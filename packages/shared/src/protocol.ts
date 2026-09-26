import { z } from "zod";
import {
  AccountId,
  AccountLogin,
  AccountTier,
  ActionKind,
  BotId,
  BotRole,
  BrowserPlatform,
  ChecklistItem,
  ComputerKind,
  ComputerId,
  ContentPlanId,
  DraftContent,
  DraftId,
  Grant,
  GrantTarget,
  GroupId,
  HandoffId,
  LoginFailure,
  MessageId,
  ModelPurpose,
  Platform,
  ProjectOfferMember,
  ProjectOfferPlatform,
  PublishFailureReason,
  RunId,
  Skill,
  Timestamp,
  ToolConnection,
  TopicTask,
  UserId,
} from "./domain.js";
import { ToolView } from "./tool-view.js";

// 控制面和电脑代理之间的 WebSocket 报文。电脑代理出站连接，连上后先发 hello。
// 两个方向各一个 discriminatedUnion。加一种报文就在这里加一个分支。

// 运行器拿这个头去连 MCP。控制面存的是密文，下发时解开。
export const ToolConnectionConfig = ToolConnection.extend({ authorization: z.string().nullable() });
export type ToolConnectionConfig = z.infer<typeof ToolConnectionConfig>;

export const AccountConfig = z
  .object({ id: AccountId, platform: Platform, handle: z.string().nullable(), tier: AccountTier, login: AccountLogin })
  .strict();
export type AccountConfig = z.infer<typeof AccountConfig>;

export const DraftSpec = z
  .object({
    draftId: DraftId,
    accountId: AccountId,
    content: DraftContent,
    scheduledAt: z.string().datetime().nullable(),
  })
  .strict();
export type DraftSpec = z.infer<typeof DraftSpec>;

export const AgentToControl = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    computerId: ComputerId,
    token: z.string(),
    version: z.string(),
    activeRuns: z.array(RunId),
  }),
  z.object({ type: z.literal("heartbeat"), at: z.string().datetime() }),
  z.object({
    type: z.literal("agent_error"),
    code: z.enum(["bad_message", "prompt_before_config", "unsupported", "runner_failed", "model_failed"]),
    detail: z.string(),
    // 知道是哪个活出的错就带上群号；不带时控制面退回到这台电脑最近一个未结束的 run。
    groupId: GroupId.optional(),
  }),
  z.object({
    type: z.literal("bot_text"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    messageId: MessageId,
    delta: z.string(),
    done: z.boolean(),
  }),
  z.object({
    type: z.literal("bot_tool_call"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    callId: z.string(),
    tool: z.string(),
    view: ToolView,
    // blocked 由运行器的审批拦截器按 callId 判定。Pi 的工具结果里被拦下和自身报错都是 isError，推断不出来。
    status: z.enum(["running", "ok", "failed", "blocked"]),
    durationMs: z.number().nullable(),
  }),
  z.object({
    type: z.literal("run_done"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    // 一次 prompt 恰好一份，对应 Pi 的 agent_settled 而不是 agent_end（后者重试时会发多遍）。控制面按 runId 幂等。
    // steps 是这次运行里模型回合数（Pi 的 turn_end 次数），不是工具调用次数。
    steps: z.number().int().nonnegative().max(10_000),
    inputTokens: z.number().int().nonnegative().max(1_000_000_000),
    outputTokens: z.number().int().nonnegative().max(1_000_000_000),
  }),
  z.object({
    type: z.literal("approval_request"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    callId: z.string(),
    tool: z.string(),
    action: ActionKind,
    target: GrantTarget.nullable(),
    view: ToolView,
  }),
  z.object({
    type: z.literal("login_state"),
    accountId: AccountId,
    state: z.discriminatedUnion("login", [
      z.object({ login: z.literal("valid"), handle: z.string().min(1).max(100) }).strict(),
      z.object({ login: z.literal("expired") }).strict(),
      z.object({ login: z.literal("failed"), reason: LoginFailure }).strict(),
    ]),
  }),
  // attempt 原样带回 publish_draft 里的那个；externalId 为 null 是发出去了但没读到平台上的 id。
  z.object({
    type: z.literal("publish_result"),
    draftId: DraftId,
    attempt: Timestamp,
    result: z.discriminatedUnion("status", [
      z.object({ status: z.literal("ok"), url: z.string().url(), externalId: z.string().min(1).nullable() }).strict(),
      z
        .object({
          status: z.literal("failed"),
          reason: PublishFailureReason,
          detail: z.string().max(2000),
        })
        .strict(),
    ]),
  }),
  z.object({
    type: z.literal("draft_create"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    draft: DraftSpec,
  }),
  z.object({
    type: z.literal("draft_edit"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    draftId: DraftId,
    content: DraftContent,
  }),
  z.object({
    type: z.literal("plan_propose"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    planId: ContentPlanId,
    title: z.string().min(1).max(60),
    drafts: z.array(DraftSpec).min(1).max(20),
  }),
  z.object({
    type: z.literal("project_offer"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    name: z.string().min(1).max(40),
    goal: z.string().min(1).max(200),
    team: z.array(ProjectOfferMember).min(1).max(5),
    platforms: z.array(ProjectOfferPlatform).max(6),
    cadence: z.string().max(200),
    firstStep: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("set_cadence"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    projectGroupId: GroupId,
    cadence: z.string().max(200),
  }),
  z.object({
    type: z.literal("approval_abandoned"),
    runId: RunId,
    callId: z.string(),
    reason: z.enum(["stopped", "paused", "disconnected"]),
  }),
  // 运行器的主题任务工具走下面两条。清单整份替换，同一份重发两遍结果不变。
  z.object({
    type: z.literal("task_checklist"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    checklist: z.array(ChecklistItem).max(50),
  }),
  // Bot @ 群里另一个 Bot。控制面存成这个 Bot 的一条消息，只派给被 @ 的那个，不改当前经手。
  z.object({
    type: z.literal("mention"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    targetBotId: BotId,
    text: z.string().min(1).max(2000),
  }),
  // Bot 干完一件多步的活，问用户存不存成 skill。控制面落一条 skill_offer 消息，存不存由用户在群里点。
  z.object({
    type: z.literal("skill_offer"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    name: z.string().min(1).max(40),
    steps: z.array(z.string().min(1).max(500)).min(2).max(20),
  }),
  // 当前经手把活交给同群另一个 Bot。控制面落一条交接报文，给目标派一条带 handoffId 的 prompt。
  z.object({
    type: z.literal("handoff"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    toBotId: BotId,
    done: z.string().max(2000),
    notDone: z.string().max(2000),
    next: z.string().max(2000),
    checklistIndex: z.number().int().nonnegative().nullable(),
  }),
  // 目标 Bot 确认接手。确认之后它才是当前经手，Bot 之间的确认不等于用户的审批。
  z.object({
    type: z.literal("handoff_accept"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    handoffId: HandoffId,
  }),
  // Bot 按用户的话设或卸这个群的首席。目标要是群成员，null 是卸任。控制面写 groups.chief_bot_id，推 group_updated。
  z.object({
    type: z.literal("set_chief"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    targetBotId: BotId.nullable(),
  }),
]);
export type AgentToControl = z.infer<typeof AgentToControl>;

// 控制面收下 hello 后必须回 welcome。电脑代理只在收到 welcome 时把重连退避清零。
export const ControlToAgent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), ownerId: UserId, kind: ComputerKind, serverTime: z.string().datetime() }),
  z.object({
    type: z.literal("config"),
    bots: z.array(z.object({ id: BotId, role: BotRole, name: z.string(), tag: z.string(), description: z.string() })),
    // 只给分配到的 Bot 加载。authorization 只走这条报文，公开的 ToolConnection 不带。
    tools: z.array(ToolConnectionConfig),
    // 该用户全部 Bot 的 skill，运行器按 botId 分开落成 SKILL.md。M10 控制面接上前可省。
    skills: z.array(Skill).optional(),
    accounts: z.array(AccountConfig),
    grants: z.array(Grant),
    modelGateway: z.object({ baseUrl: z.string().url(), apiKey: z.string() }),
  }),
  z.object({
    type: z.literal("prompt"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    // 触发这次 prompt 的那条群消息：用户发的、队友 @ 的、交接卡或例行写进群里的那条。
    messageId: MessageId,
    text: z.string(),
    // 当前这条是谁说的。队友 @ 来的带发信人，运行器据此署名并提醒「这是队友说的，不是用户」；
    // 例行任务那条是归属人定时发的，没有人在等回复。
    origin: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("user") }),
      z.object({ kind: z.literal("bot"), id: BotId, name: z.string(), tag: z.string() }),
      z.object({ kind: z.literal("routine") }),
    ]),
    // solo 是建 Bot 时自动建的单聊群，title 就是 Bot 名；team 是拉了 2 到 6 个 Bot 的群。
    group: z.object({ id: GroupId, number: z.string(), title: z.string(), kind: z.enum(["solo", "team"]) }),
    context: z.array(z.object({ messageId: MessageId, from: z.string(), text: z.string() })),
    purpose: ModelPurpose,
    projects: z.array(z.object({ groupId: GroupId, title: z.string(), cadence: z.string() }).strict()).optional(),
    // 这条为什么派到你：单聊、被点名、交接目标、你是首席、你是经手、没人点名全员轮流。
    // 运行器据此在群标签下写一句，全员轮流那种要告诉它无话可说回 (pass)。
    reason: z.enum(["solo", "mentioned", "handoff", "chief", "current", "everyone"]),
    // 多 Bot 群带任务卡和成员名单，Bot 靠名单知道能 @ 谁、各自会做什么。单 Bot 群 task 为 null，members 只有它自己。
    task: TopicTask.nullable(),
    members: z.array(
      z.object({
        id: BotId,
        name: z.string(),
        tag: z.string(),
        description: z.string(),
        seat: z.enum(["chief", "member"]),
      }),
    ),
    // 这条 prompt 是为了让它处理一份交接时带上，运行器的 accept_handoff 工具只在带了它时可用。
    handoffId: HandoffId.optional(),
  }),
  z.object({
    type: z.literal("approval_result"),
    runId: RunId,
    callId: z.string(),
    approved: z.boolean(),
  }),
  z.object({ type: z.literal("pause"), botId: BotId }),
  z.object({ type: z.literal("resume"), botId: BotId }),
  z.object({ type: z.literal("browser_login"), accountId: AccountId, platform: BrowserPlatform }),
  // attempt 是控制面这一次认领的时刻，一条草稿超时后重批再发，新旧两次靠它分开。
  // botId 是起草的 Bot，配图只认它目录里的拷贝；Bot 删了是 null，这时哪张配图都不认。
  z.object({
    type: z.literal("publish_draft"),
    draftId: DraftId,
    botId: BotId.nullable(),
    accountId: AccountId,
    platform: BrowserPlatform,
    content: DraftContent,
    attempt: Timestamp,
  }),
]);
export type ControlToAgent = z.infer<typeof ControlToAgent>;
