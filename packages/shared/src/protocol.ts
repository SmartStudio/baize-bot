import { z } from "zod";
import { PokerAction, PokerHandId, PokerPersona, PokerReviewHand, PokerSessionId, TablePrompt } from "./poker.js";
import {
  AccountId,
  AccountLogin,
  AccountTier,
  ActionKind,
  BotId,
  BotRole,
  BotTags,
  BrowserPlatform,
  ChecklistItem,
  ComputerKind,
  ComputerId,
  ComputerView,
  ContentPlanId,
  DraftContent,
  DraftId,
  Grant,
  GrantTarget,
  GoalTarget,
  GroupId,
  HandoffId,
  LoginAttemptId,
  LoginFailure,
  MessageId,
  ModelPurpose,
  Platform,
  PublishVia,
  Preference,
  ProjectOfferMember,
  ProjectOfferPlatform,
  PublishFailureReason,
  RoutineBoundary,
  RoutineId,
  RoutineOfferSpec,
  RunId,
  Skill,
  SkillChange,
  TeamOfferMember,
  Timestamp,
  ToolConnection,
  TopicTask,
  UserId,
} from "./domain.js";
import { WorkRetainReason } from "./lane-records.js";
import { ToolView } from "./tool-view.js";
import { McpDiscoveryResult, McpHttpUrl } from "./mcp-discovery.js";

// 控制面和电脑代理之间的 WebSocket 报文。电脑代理出站连接，连上后先发 hello。
export const ApprovalOutcome = z.enum(["approved", "rejected", "voided", "timed_out"]);
export type ApprovalOutcome = z.infer<typeof ApprovalOutcome>;
// 两个方向各一个 discriminatedUnion。加一种报文就在这里加一个分支。

/** 代理连控制面用的那个源，config 的数据面地址只拼在它上面。只在这里校验一次，后面谁都不再判断。 */
export const ControlOrigin = z
  .string()
  .max(256)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
    } catch {
      return false;
    }
  }, "必须是 http(s)://主机[:端口]，不带路径、查询和凭据");
export type ControlOrigin = z.infer<typeof ControlOrigin>;

export const AgentCloseCode = {
  superseded: 4000,
  badHello: 4001,
  accountDeleted: 4002,
  upgradeRequired: 4003,
  displaced: 4004,
} as const;

// 电脑代理 stdout 每行一个状态，桌面端读它。
export const AgentStatusLine = z.discriminatedUnion("type", [
  z.object({ type: z.literal("online") }),
  z.object({ type: z.literal("displaced") }),
  z.object({ type: z.literal("upgrade_required") }),
]);
export type AgentStatusLine = z.infer<typeof AgentStatusLine>;

// 默认由控制面执行；只有本机连接才下发直连需要的凭据。
export const ToolConnectionConfig = z.discriminatedUnion("localOnly", [
  ToolConnection.extend({ localOnly: z.literal(false) }).strict(),
  ToolConnection.extend({ localOnly: z.literal(true), authorization: z.string().nullable() }).strict(),
]);
export type ToolConnectionConfig = z.infer<typeof ToolConnectionConfig>;

export const AccountConfig = z
  .object({
    id: AccountId,
    platform: Platform,
    via: PublishVia,
    handle: z.string().nullable(),
    tier: AccountTier,
    login: AccountLogin,
  })
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
    protocol: z.number().int().nonnegative().default(1),
    // 协议 4 起必填，缺了控制面按坏 hello 关。schema 上可缺是为了让旧代理先撞上协议号检查，拿到要升级的明确关闭码。
    controlOrigin: ControlOrigin.optional(),
    installId: z.string().uuid().default("00000000-0000-0000-0000-000000000000"),
    piSessionVersion: z.number().int().positive().default(1),
    uplinkStream: z.string().min(1).max(128).default("legacy"),
    downApplied: z.number().int().nonnegative().default(0),
    activeRuns: z.array(RunId),
  }),
  z.object({ type: z.literal("downlink_ack"), upTo: z.number().int().nonnegative() }),
  z.object({ type: z.literal("heartbeat"), at: z.string().datetime() }),
  z.object({ type: z.literal("mcp_discovered"), requestId: z.string().uuid(), result: McpDiscoveryResult }),
  // 代理收下一条 config 并换好了运行器，generation 是收下的那条 config 的代际。
  // 控制面只拿它从 config_rejected 里恢复，且只认当前待确认的那一代。
  // 不兼容旧代理：它回的 config_applied 不带 generation，parse 不过整条丢掉。控制面和代理同版一起升。
  z.object({ type: z.literal("config_applied"), generation: z.number().int().positive() }),
  z.object({
    type: z.literal("agent_error"),
    code: z.enum([
      "bad_message",
      "prompt_before_config",
      "unsupported",
      "runner_failed",
      "model_failed",
      // 代理不认这条 config（多半是两边版本对不上），detail 写校验不过的字段路径。
      "config_rejected",
    ]),
    detail: z.string(),
    // config_rejected 时带被拒那条 config 的代际；读不出代际时不带，这时这条连接还没回过带代际的 config_applied 就按当前那一代算，回过之后忽略。
    generation: z.number().int().positive().optional(),
    // 知道是哪个活出的错就带上群号；不带时只有这台电脑恰好一个未结束的 run 才归给它，否则丢弃。
    groupId: GroupId.optional(),
    // 带了就是说这个 run 在代理这头不会再跑、也不会有 run_done，控制面替它收尾。
    runId: RunId.optional(),
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
    type: z.literal("bot_text_done"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    messageId: MessageId,
    text: z.string(),
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
    // 这次触发的消息进没进 Pi 会话：entered 是 agent_settled 报的，消息已经进了会话；dropped 是运行器
    // 没把它交给会话就收尾了（停机、Bot 没了、建会话失败、Pi 在消息进会话前抛错）。控制面只在 entered
    // 时把这次派活记下的没定稿名单确认掉。不带是旧运行器，按 entered 算：它本来就是这么确认的。
    prompt: z.enum(["entered", "dropped"]).optional(),
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
      // attempt 原样带回 browser_login 里的那个，控制面靠它把这次没成归到那一次点击。
      z.object({ login: z.literal("failed"), reason: LoginFailure, attempt: LoginAttemptId }).strict(),
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
    goalTarget: GoalTarget.optional(),
    goalUnit: z.string().min(1).max(8).optional(),
  }),
  // 主助理在单聊里出建队卡，projectGroupId 是要加人的项目群。控制面只收主助理发的、只落在主助理单聊。
  z.object({
    type: z.literal("team_offer"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    projectGroupId: GroupId,
    members: z.array(TeamOfferMember).min(1).max(5),
  }),
  // 主助理提议一条例行。projectGroupId 为 null 是发进执行者的单聊。
  z.object({
    type: z.literal("routine_offer"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    ...RoutineOfferSpec,
    projectGroupId: GroupId.nullable(),
  }),
  // Bot 在单聊里提议记一条偏好。控制面在该 Bot 的单聊里落一张确认卡，用户点了「记住」才写进偏好；
  // 项目群里的静默丢弃。
  z.object({
    type: z.literal("preference_offer"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    text: z.string().min(1).max(200),
    private: z.boolean(),
    sourceMessageId: MessageId.nullable(),
  }),
  // Bot 在项目群的例行里读到一个数报上来，控制面落一条样本。只收这个 run 属于这个项目群的。
  z.object({
    type: z.literal("metric_report"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    value: z.number().finite(),
    label: z.string().max(40),
  }),
  // 主助理在项目群的例行里交一份周复盘。周界由控制面按收到时刻算，同一周再交覆盖。
  z.object({
    type: z.literal("review_submit"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    body: z.string().min(1).max(8000),
  }),
  // 牌友在牌桌 run 里出一手。seq 是它拿到的决策点，桌子换了手或别人先动就按过期拒。
  // say 是随动作带的一句台词，公开显示；牌友其他文字输出一律丢弃（D30）。
  z.object({
    type: z.literal("poker_act"),
    runId: RunId,
    callId: z.string(),
    handId: PokerHandId,
    seq: z.number().int().nonnegative(),
    action: PokerAction,
    say: z.string().max(40).optional(),
  }),
  // 老白在复盘 run 里交一份复盘，哪几手由控制面按筹码变化挑好带在 prompt 里，它只写话（D32）。
  z.object({
    type: z.literal("poker_review"),
    runId: RunId,
    sessionId: PokerSessionId,
    hands: z.array(PokerReviewHand),
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
  // Bot 提议存、装、改或删一条 skill。控制面落一条 skill_offer 消息，生不生效由用户在群里点。
  z.object({
    type: z.literal("skill_offer"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    change: SkillChange,
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
  z.object({
    type: z.literal("work_append"),
    lane: z.object({
      botId: BotId,
      groupId: GroupId,
      stream: z.enum(["chat", "table"]),
      epoch: z.number().int().positive(),
    }),
    runId: RunId.nullable(),
    fromSeq: z.number().int().nonnegative(),
    lines: z.array(z.string()).max(64),
    head: z.string().regex(/^[0-9a-f]{64}$/),
    cause: z.enum(["turn_end", "before_approval", "before_effect", "compact", "settled", "import"]),
  }),
]);
export type AgentToControl = z.infer<typeof AgentToControl>;
export type WorkAppend = Extract<AgentToControl, { type: "work_append" }>;

// 控制面收下 hello 后必须回 welcome。电脑代理只在收到 welcome 时把重连退避清零。
const CancelControlMessage = z
  .object({
    type: z.literal("cancel"),
    runId: RunId.optional(),
    lane: z.object({ botId: BotId, groupId: GroupId }).optional(),
    epoch: z.number().int().positive().optional(),
  })
  .strict();

const ControlToAgentDiscriminatedUnion = z.discriminatedUnion("type", [
  CancelControlMessage,
  z.object({
    type: z.literal("mcp_discover"),
    requestId: z.string().uuid(),
    url: McpHttpUrl,
    authorization: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("welcome"),
    ownerId: UserId,
    kind: ComputerKind,
    serverTime: z.string().datetime(),
    conn: z.number().int().positive(),
    upAcked: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("config"),
    // 这条连接上第几份 config，从 1 起按开始读快照的先后编号。并发重发时后开始的可能先到，
    // 代理丢掉比已应用代际小的，回执带同一个数。
    generation: z.number().int().positive(),
    // preset 是预置牌友或老白的人设 id，运行器据它取长文案；普通 Bot 为 null。
    bots: z.array(
      z.object({
        id: BotId,
        role: BotRole,
        name: z.string(),
        tags: BotTags,
        description: z.string(),
        preset: PokerPersona.nullable(),
      }),
    ),
    // 本机连接只发给本机电脑，其他连接不带凭据。
    tools: z.array(ToolConnectionConfig),
    mcpProxy: z.object({ baseUrl: z.string().url() }),
    hub: z.object({ baseUrl: z.string().url() }),
    // 该用户全部 Bot 的 skill，运行器按 botId 分开落成 SKILL.md。M10 控制面接上前可省。
    skills: z.array(Skill).optional(),
    // 品牌手册由控制面拼成一段文字下发，version 变了运行器才重送给模型；没写过手册是 null。
    brand: z.object({ version: z.number().int().nonnegative(), text: z.string() }).strict().nullable(),
    // 该用户全部 Bot 的偏好，恒带：空也带空数组，运行器靠它对账「之前说过、这里没有的已作废」，理由同 skills。
    preferences: z.array(Preference),
    accounts: z.array(AccountConfig),
    grants: z.array(Grant),
    modelGateway: z.object({ baseUrl: z.string().url(), apiKey: z.string() }),
    // 读 GitHub、X 走控制面的账号代理：`${baseUrl}/<accountId>/<平台路径>`，Bearer 用 modelGateway.apiKey，令牌不下发。
    accountsProxy: z.object({ baseUrl: z.string().url() }),
  }),
  z.object({
    type: z.literal("prompt"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    lane: z.object({
      epoch: z.number().int().positive(),
      heads: z.object({
        chat: z.object({ seq: z.number().int().nonnegative(), head: z.string().regex(/^[0-9a-f]{64}$/) }).optional(),
        table: z.object({ seq: z.number().int().nonnegative(), head: z.string().regex(/^[0-9a-f]{64}$/) }).optional(),
      }),
    }),
    // 触发这次 prompt 的那条群消息：用户发的、队友 @ 的、交接卡或例行写进群里的那条。
    messageId: MessageId,
    text: z.string(),
    // 当前这条是谁说的。队友 @ 来的带发信人，运行器据此署名并提醒「这是队友说的，不是用户」；
    // 例行任务那条是归属人定时发的，没有人在等回复。
    origin: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("user") }),
      z.object({ kind: z.literal("bot"), id: BotId, name: z.string(), tags: BotTags }),
      z.object({ kind: z.literal("routine") }),
      z.object({ kind: z.literal("table") }),
    ]),
    // 牌桌 prompt 带这个，context 恒为空数组、task 为 null、members 为空；messageId 指向隐藏的触发消息。
    table: TablePrompt.nullable(),
    // 例行触发的带这条例行的 id 和边界，运行器的闸门按 boundary 收紧；用户当面派的是 null。
    routine: z.object({ routineId: RoutineId, boundary: RoutineBoundary }).strict().nullable(),
    // solo 是建 Bot 时自动建的单聊群，title 就是 Bot 名；team 是拉了 2 到 6 个 Bot 的群。
    group: z.object({ id: GroupId, number: z.string(), title: z.string(), kind: z.enum(["solo", "team"]) }),
    // settled 为 false 的是 Bot 还在往下说的那条，下一轮它会长。运行器的水位不能把它当看完了。
    // 旧控制面不发 settled，缺省当定稿，新代理配旧控制面时退回原来的行为，而不是整条 prompt parse 不过被丢掉。
    context: z.array(
      z.object({ messageId: MessageId, from: z.string(), text: z.string(), settled: z.boolean().default(true) }),
    ),
    purpose: ModelPurpose,
    projects: z.array(z.object({ groupId: GroupId, title: z.string(), cadence: z.string() }).strict()).optional(),
    // 这条为什么派到你：单聊、被点名、交接目标、你是首席、你是经手、没人点名全员轮流、换电脑后接着上一轮做。
    // 运行器据此在群标签下写一句，全员轮流那种要告诉它无话可说回 (pass)；continuation 的 text 就是整段提示，
    // context、task、members 都是空的，上一轮的对话都在会话里。
    reason: z.enum(["solo", "mentioned", "handoff", "chief", "current", "everyone", "continuation"]),
    // 多 Bot 群带任务卡和成员名单，Bot 靠名单知道能 @ 谁、各自会做什么。单 Bot 群 task 为 null，members 只有它自己。
    task: TopicTask.nullable(),
    members: z.array(
      z.object({
        id: BotId,
        name: z.string(),
        tags: BotTags,
        description: z.string(),
        seat: z.enum(["chief", "member"]),
      }),
    ),
    // 这条 prompt 是为了让它处理一份交接时带上，运行器的 accept_handoff 工具只在带了它时可用。
    handoffId: HandoffId.optional(),
    // 落位那一刻的快照。账号下只有一台、这个群也没选过时为 null，牌桌恒为 null。
    // 升级前压在发件箱里的 prompt 没有这个字段，缺省当 null，不然整条 parse 不过被丢掉，run 一直挂着。
    computer: ComputerView.nullable().default(null),
  }),
  z.object({
    type: z.literal("approval_result"),
    runId: RunId,
    callId: z.string(),
    outcome: ApprovalOutcome,
  }),
  // poker_act 的回执：引擎拒了带中文原因，运行器把它做成工具错误让牌友重试（D24）。
  z.object({
    type: z.literal("poker_result"),
    runId: RunId,
    callId: z.string(),
    result: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true) }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  }),
  z.object({ type: z.literal("pause"), botId: BotId }),
  z.object({ type: z.literal("resume"), botId: BotId }),
  z.object({
    type: z.literal("browser_login"),
    accountId: AccountId,
    platform: BrowserPlatform,
    attempt: LoginAttemptId,
  }),
  // 不开画面，只在后台页上看一眼浏览器是不是已经登上了：人可能在 Bot 的浏览器里登过，账号页不知道。
  // 登上了照 login_state valid 回，没登上什么也不回，账号状态不动。
  z.object({
    type: z.literal("login_check"),
    accountId: AccountId,
    platform: BrowserPlatform,
  }),
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
export const ControlToAgent = ControlToAgentDiscriminatedUnion.refine(
  (message) =>
    message.type !== "cancel" ||
    (message.runId !== undefined && message.lane === undefined && message.epoch === undefined) ||
    (message.runId === undefined && message.lane !== undefined && message.epoch !== undefined),
  { message: "cancel 必须指定一个 run 或带代际的道" },
);
export type ControlToAgent = z.infer<typeof ControlToAgent>;

export const AGENT_PROTOCOL = 4;
export const MIN_AGENT_PROTOCOL = 4;

export const UPLINK_DELIVERY = {
  hello: "bare",
  heartbeat: "bare",
  // 结果只供正在等待的 HTTP 请求使用；丢失由用户重试，不能进入代理磁盘发件箱。
  mcp_discovered: "bare",
  config_applied: "bare",
  downlink_ack: "bare",
  bot_text: "bare",
  bot_text_done: "reliable",
  agent_error: "reliable",
  bot_tool_call: "reliable",
  run_done: "reliable",
  approval_request: "reliable",
  login_state: "reliable",
  publish_result: "reliable",
  draft_create: "reliable",
  draft_edit: "reliable",
  plan_propose: "reliable",
  project_offer: "reliable",
  team_offer: "reliable",
  routine_offer: "reliable",
  preference_offer: "reliable",
  metric_report: "reliable",
  review_submit: "reliable",
  poker_act: "reliable",
  poker_review: "reliable",
  set_cadence: "reliable",
  approval_abandoned: "reliable",
  task_checklist: "reliable",
  mention: "reliable",
  skill_offer: "reliable",
  work_append: "reliable",
  handoff: "reliable",
  handoff_accept: "reliable",
  set_chief: "reliable",
} as const satisfies Record<AgentToControl["type"], "bare" | "reliable">;

export const DOWNLINK_DELIVERY = {
  welcome: "bare",
  config: "bare",
  pause: "bare",
  resume: "bare",
  // 带明文凭据，不能进入 agent_outbox 或代理的 .agent/downlink.json；丢失让 HTTP 请求超时。
  mcp_discover: "bare",
  cancel: "reliable",
  prompt: "reliable",
  approval_result: "reliable",
  poker_result: "reliable",
  browser_login: "reliable",
  // 丢了下一轮发布循环再发一次，不值得进发件箱。
  login_check: "bare",
  publish_draft: "reliable",
} as const satisfies Record<ControlToAgent["type"], "bare" | "reliable">;

export const RUN_CLOSED_ACCEPTS: ReadonlySet<AgentToControl["type"]> = new Set([
  "run_done",
  "bot_text_done",
  "bot_tool_call",
  "work_append",
]);
export const UplinkRejectionCode = z.enum([
  "stale_epoch",
  "not_holder",
  "run_closed",
  "seq_mismatch",
  "head_mismatch",
  "invalid",
]);
export type UplinkRejectionCode = z.infer<typeof UplinkRejectionCode>;
export const UplinkRejection = z.object({
  seq: z.number().int().positive(),
  code: UplinkRejectionCode,
  reason: WorkRetainReason.optional(),
  lineIndex: z.number().int().nonnegative().optional(),
  replayReason: WorkRetainReason.exclude(["tool_list_changed"]).optional(),
  head: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  runId: RunId.optional(),
  nextSeq: z.number().int().nonnegative().optional(),
  lane: z
    .object({ botId: BotId, groupId: GroupId, stream: z.enum(["chat", "table"]), epoch: z.number().int().positive() })
    .optional(),
});
export type UplinkRejection = z.infer<typeof UplinkRejection>;

/** 控制面 /agent 收的单帧上限。超限的可靠帧被关后重连照样重发，所以发送方要先按它切，不能等控制面拒。 */
export const AGENT_FRAME_MAX_BYTES = 16 * 1024 * 1024;

export const UplinkFrame = z.object({
  type: z.literal("uplink"),
  conn: z.number().int().positive(),
  stream: z.string().min(1).max(128),
  seq: z.number().int().positive(),
  body: AgentToControl.refine((body) => UPLINK_DELIVERY[body.type] === "reliable"),
});
export type UplinkFrame = z.infer<typeof UplinkFrame>;
export const UplinkHeader = UplinkFrame.omit({ body: true }).extend({ body: z.unknown() });
export const UplinkAck = z.object({
  type: z.literal("uplink_ack"),
  upTo: z.number().int().nonnegative(),
  rejected: z.array(UplinkRejection),
});
export type UplinkAck = z.infer<typeof UplinkAck>;
export const DownlinkFrame = z.object({
  type: z.literal("downlink"),
  seq: z.number().int().positive(),
  body: ControlToAgent.refine((body) => DOWNLINK_DELIVERY[body.type] === "reliable"),
});
export type DownlinkFrame = z.infer<typeof DownlinkFrame>;
export const BareUplinkFrame = z.object({
  conn: z.number().int().positive(),
  body: AgentToControl.refine(
    (body) =>
      UPLINK_DELIVERY[body.type] === "bare" && body.type !== "hello" && (body.type !== "bot_text" || !body.done),
  ),
});
export type BareUplinkFrame = z.infer<typeof BareUplinkFrame>;
