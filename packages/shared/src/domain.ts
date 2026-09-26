import { z } from "zod";
import { ToolView } from "./tool-view.js";

// 对象模型。依据 spec/规格.md 第二节，这里是各对象「现在」的形状。每个对象一个 zod schema，类型从 schema 推导。
// 状态一律用字面量联合，不用布尔组合。

const id = <B extends string>(_brand: B) => z.string().min(1).brand<B>();
// 运行器直接拿来当目录名的 id（<botDir>/skills/<skillId>/、<botDir>/sessions/<groupId>/），只收一段安全的名字。
const dirId = <B extends string>(brand: B) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .brand(brand);

export const UserId = id("UserId");
export const ComputerId = id("ComputerId");
export const BotId = id("BotId");
export const GroupId = dirId("GroupId");
export const TaskId = id("TaskId");
export const MessageId = id("MessageId");
export const ApprovalId = id("ApprovalId");
export const HandoffId = id("HandoffId");
export const ToolConnectionId = id("ToolConnectionId");
export const SkillId = dirId("SkillId");
export const RoutineId = id("RoutineId");
export const RunId = id("RunId");
export const GrantId = id("GrantId");
export const DraftId = id("DraftId");
export const ContentPlanId = id("ContentPlanId");
export const PublicationId = id("PublicationId");
export const AccountId = id("AccountId");

export type UserId = z.infer<typeof UserId>;
export type ComputerId = z.infer<typeof ComputerId>;
export type BotId = z.infer<typeof BotId>;
export type GroupId = z.infer<typeof GroupId>;
export type TaskId = z.infer<typeof TaskId>;
export type MessageId = z.infer<typeof MessageId>;
export type ApprovalId = z.infer<typeof ApprovalId>;
export type HandoffId = z.infer<typeof HandoffId>;
export type ToolConnectionId = z.infer<typeof ToolConnectionId>;
export type SkillId = z.infer<typeof SkillId>;
export type RoutineId = z.infer<typeof RoutineId>;
export type RunId = z.infer<typeof RunId>;
export type GrantId = z.infer<typeof GrantId>;
export type DraftId = z.infer<typeof DraftId>;
export type ContentPlanId = z.infer<typeof ContentPlanId>;
export type PublicationId = z.infer<typeof PublicationId>;
export type AccountId = z.infer<typeof AccountId>;

export const Timestamp = z.string().datetime();

export const User = z.object({
  id: UserId,
  name: z.string().min(1),
  email: z.string().email(),
  createdAt: Timestamp,
});
export type User = z.infer<typeof User>;

export const ComputerStatus = z.enum(["creating", "online", "sleeping", "failed"]);
export type ComputerStatus = z.infer<typeof ComputerStatus>;
export const ComputerKind = z.enum(["local", "remote"]);
export type ComputerKind = z.infer<typeof ComputerKind>;

export const Computer = z.object({
  id: ComputerId,
  ownerId: UserId,
  kind: ComputerKind,
  status: ComputerStatus,
  host: z.string().nullable(),
  idleSince: Timestamp.nullable(),
  lastSeenAt: Timestamp.nullable(),
});
export type Computer = z.infer<typeof Computer>;

// 七个队友色相，来自设计系统 tokens/colors.css 的 --bot-*。
export const BotHue = z.enum(["coral", "tangerine", "lime", "mint", "sky", "violet", "pink"]);
export type BotHue = z.infer<typeof BotHue>;
export const BotRole = z.enum(["assistant", "member"]);
export type BotRole = z.infer<typeof BotRole>;
export const BotRunState = z.enum(["running", "paused"]);
export type BotRunState = z.infer<typeof BotRunState>;

export const Bot = z.object({
  id: BotId,
  ownerId: UserId,
  role: BotRole,
  name: z.string().min(1).max(20),
  tag: z.string().max(20).default(""),
  description: z.string().default(""),
  hue: BotHue,
  notify: z.boolean().default(true),
  toolConnectionIds: z.array(ToolConnectionId).default([]),
  runState: BotRunState,
  createdAt: Timestamp,
});
export type Bot = z.infer<typeof Bot>;

export const ChecklistItem = z.object({
  text: z.string().min(1),
  done: z.boolean(),
  ownerBotId: BotId.nullable(),
});
export type ChecklistItem = z.infer<typeof ChecklistItem>;

export const HandledRecord = z.object({
  botId: BotId,
  from: Timestamp,
  to: Timestamp.nullable(),
});

export const TaskStatus = z.enum(["active", "done"]);

export const TopicTask = z.object({
  id: TaskId,
  groupId: GroupId,
  number: z.string().regex(/^T-\d{4}$/),
  title: z.string().min(1),
  summary: z.string().default(""),
  cadence: z.string().max(200),
  dueAt: Timestamp.nullable(),
  checklist: z.array(ChecklistItem),
  currentBotId: BotId.nullable(),
  handled: z.array(HandledRecord),
  status: TaskStatus,
});
export type TopicTask = z.infer<typeof TopicTask>;

export const Group = z.object({
  id: GroupId,
  ownerId: UserId,
  botIds: z.array(BotId).min(1).max(6),
  taskId: TaskId,
  // 没人点名时先到谁。和任务卡的 currentBotId 是两件事：经手人随交接换，首席随用户一句话换。单 Bot 群恒为 null。
  chiefBotId: BotId.nullable(),
  createdAt: Timestamp,
});
export type Group = z.infer<typeof Group>;

export const ApprovalStatus = z.enum(["pending", "approved", "rejected", "expired"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const ActionKind = z.enum([
  "read",
  "write_workspace",
  "write_outside",
  "delete",
  "shell",
  "publish",
  "message_person",
  "engage",
  "spend",
  "account_security",
  "install",
  "external_write",
]);
export type ActionKind = z.infer<typeof ActionKind>;

export const Verdict = z.enum(["allow", "ask", "deny"]);
export type Verdict = z.infer<typeof Verdict>;

export const ApprovalScope = z.enum(["once", "project", "forever"]);
export type ApprovalScope = z.infer<typeof ApprovalScope>;

export const GRANTABLE_SCOPES: Readonly<Record<ActionKind, readonly ApprovalScope[]>> = {
  read: ["once", "project", "forever"],
  write_workspace: ["once", "project", "forever"],
  write_outside: ["once", "project"],
  delete: ["once"],
  shell: ["once", "project", "forever"],
  publish: ["once", "project", "forever"],
  message_person: ["once", "project", "forever"],
  engage: ["once", "project", "forever"],
  spend: ["once"],
  account_security: ["once"],
  install: ["once", "project", "forever"],
  external_write: ["once", "project", "forever"],
};

export const GrantTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("account"), accountId: AccountId }).strict(),
  z.object({ kind: z.literal("domain"), domain: z.string().min(1).max(253) }).strict(),
  z.object({ kind: z.literal("path"), computerId: ComputerId, prefix: z.string().startsWith("/").max(1024) }).strict(),
]);
export type GrantTarget = z.infer<typeof GrantTarget>;

export const Grant = z.discriminatedUnion("scope", [
  z
    .object({
      id: GrantId,
      scope: z.literal("project"),
      groupId: GroupId,
      action: ActionKind,
      target: GrantTarget,
      createdAt: Timestamp,
    })
    .strict(),
  z
    .object({
      id: GrantId,
      scope: z.literal("forever"),
      action: ActionKind,
      target: GrantTarget,
      createdAt: Timestamp,
    })
    .strict(),
]);
export type Grant = z.infer<typeof Grant>;

export const Approval = z.object({
  id: ApprovalId,
  groupId: GroupId,
  botId: BotId,
  runId: RunId,
  action: ActionKind,
  target: GrantTarget.nullable(),
  view: ToolView,
  status: ApprovalStatus,
  decidedAt: Timestamp.nullable(),
  grantId: GrantId.nullable(),
});
export type Approval = z.infer<typeof Approval>;

export const HandoffStatus = z.enum(["pending", "accepted"]);

export const Handoff = z.object({
  id: HandoffId,
  groupId: GroupId,
  fromBotId: BotId,
  toBotId: BotId,
  done: z.string(),
  notDone: z.string(),
  next: z.string(),
  checklistIndex: z.number().int().nonnegative().nullable(),
  status: HandoffStatus,
  createdAt: Timestamp,
  // 超时提醒按 createdAt 算，接手时刻单独记：经手记录里那一条的 from 就是它。
  acceptedAt: Timestamp.nullable(),
});
export type Handoff = z.infer<typeof Handoff>;

export const ToolCallStatus = z.enum(["running", "ok", "failed", "blocked"]);
export type ToolCallStatus = z.infer<typeof ToolCallStatus>;

// 来源：对话里 Bot 提议存下的记 chat，例行任务运行里提议的记 routine，用户在 Web 教的记 taught。复制给别的 Bot 保留原来源。
export const SkillSource = z.enum(["chat", "routine", "taught"]);
export type SkillSource = z.infer<typeof SkillSource>;

export const SkillName = z.string().min(1).max(40);
export const SkillSteps = z.array(z.string().min(1).max(500)).min(1).max(20);

// 真相源是控制面的 skills 表。运行器只按 config 落文件，不往回同步。同一 Bot 下名字不重复，Pi 按名字找文件。
export const Skill = z.object({
  id: SkillId,
  botId: BotId,
  name: SkillName,
  source: SkillSource,
  steps: SkillSteps,
  useCount: z.number().int().nonnegative(),
  createdAt: Timestamp,
});
export type Skill = z.infer<typeof Skill>;

// Bot 问「存不存」的那张卡。offered 是还没点，saved 之后 skillId 指向存下的那条，dismissed 是用户说不存。
export const SkillOfferStatus = z.enum(["offered", "saved", "dismissed"]);
export type SkillOfferStatus = z.infer<typeof SkillOfferStatus>;

export const Platform = z.enum(["github", "x", "xiaohongshu"]);
export type Platform = z.infer<typeof Platform>;
export const BrowserPlatform = Platform.extract(["xiaohongshu"]);
export type BrowserPlatform = z.infer<typeof BrowserPlatform>;
export const OAuthPlatform = Platform.extract(["github", "x"]);
export type OAuthPlatform = z.infer<typeof OAuthPlatform>;

export const ProjectOfferStatus = z.enum(["offered", "started", "dismissed"]);
export type ProjectOfferStatus = z.infer<typeof ProjectOfferStatus>;
export const ProjectOfferMember = z
  .object({ name: z.string().min(1).max(20), tag: z.string().max(20), description: z.string().max(200) })
  .strict();
export type ProjectOfferMember = z.infer<typeof ProjectOfferMember>;
export const ProjectOfferPlatform = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("supported"), platform: Platform }).strict(),
  z.object({ kind: z.literal("unsupported"), name: z.string().min(1).max(20) }).strict(),
]);
export type ProjectOfferPlatform = z.infer<typeof ProjectOfferPlatform>;

// 群里的一条记录。kind 决定其余字段。
export const MessageBody = z.discriminatedUnion("kind", [
  // mentions 在写入时从正文里解析出来存下，派活路由只看它，不重新解析正文。可省，省了等于没 @ 人。
  z.object({ kind: z.literal("user"), text: z.string(), mentions: z.array(BotId).optional() }),
  z.object({
    kind: z.literal("bot"),
    botId: BotId,
    text: z.string(),
    streaming: z.boolean(),
    mentions: z.array(BotId).optional(),
  }),
  // tone 是给界面分层用的：error 的那条用户没得到想要的结果，界面把它渲染成醒目的提示卡；不带就是普通说明。
  z.object({ kind: z.literal("system"), text: z.string(), tone: z.enum(["info", "error"]).optional() }),
  z.object({
    kind: z.literal("tool_call"),
    runId: z.union([RunId, z.literal("")]),
    botId: BotId,
    tool: z.string(),
    view: ToolView,
    status: ToolCallStatus,
    durationMs: z.number().nonnegative().nullable(),
  }),
  z.object({ kind: z.literal("approval"), approvalId: ApprovalId }),
  z.object({ kind: z.literal("handoff"), handoffId: HandoffId }),
  // botId 告诉界面这笔账挂在哪个 Bot 的那轮回复底下。早期的行没有它，界面退回到「挂最近一轮」。
  z.object({
    kind: z.literal("cost"),
    runId: RunId,
    botId: BotId.optional(),
    steps: z.number().int(),
    amount: z.number(),
  }),
  // 审批和交接的正文只放 id，状态在别的对象上；这张卡不同，name 和 steps 就在正文里，用户没点存之前它们
  // 不在任何表里。所以状态也随正文走，点了存或不存就改这条消息再重推。存了之后 skillId 指向那条 skill。
  z.object({
    kind: z.literal("skill_offer"),
    botId: BotId,
    name: SkillName,
    steps: SkillSteps.min(2),
    status: SkillOfferStatus,
    skillId: SkillId.nullable(),
  }),
  z.object({
    kind: z.literal("project_offer"),
    botId: BotId,
    name: z.string().min(1).max(40),
    goal: z.string().min(1).max(200),
    team: z.array(ProjectOfferMember).min(1).max(5),
    platforms: z.array(ProjectOfferPlatform).max(6),
    cadence: z.string().max(200),
    firstStep: z.string().min(1).max(200),
    status: ProjectOfferStatus,
    groupId: GroupId.nullable(),
  }),
  z.object({ kind: z.literal("draft"), draftId: DraftId }),
  z.object({ kind: z.literal("plan"), planId: ContentPlanId }),
]);
export type MessageBody = z.infer<typeof MessageBody>;

export const Message = z.object({
  id: MessageId,
  groupId: GroupId,
  body: MessageBody,
  createdAt: Timestamp,
});
export type Message = z.infer<typeof Message>;

// MCP 服务上的一个操作。description 和 inputSchema 是 tools/list 原样带回的，运行器照它注册工具；
// needsApproval 默认按注解定（readOnlyHint 为 true 的不问，其余都问），用户在工具页可改。
export const ToolOperation = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.unknown()),
  needsApproval: z.boolean(),
});
export type ToolOperation = z.infer<typeof ToolOperation>;

export const ToolConnection = z.object({
  id: ToolConnectionId,
  ownerId: UserId,
  name: z.string().min(1),
  url: z.string().url(),
  operations: z.array(ToolOperation),
  assignedBotIds: z.array(BotId),
});
export type ToolConnection = z.infer<typeof ToolConnection>;

export const AccountTier = z.enum(["read_only", "draft", "confirm_publish", "direct_publish"]);
export type AccountTier = z.infer<typeof AccountTier>;
export const AccountLogin = z.enum(["none", "valid", "expired"]);
export type AccountLogin = z.infer<typeof AccountLogin>;
// 一次登录没成，账号本身的 login 不变：window_failed 是登录窗口出错或到点没登上，remote_refused 是远程电脑不许登录。
export const LoginFailure = z.enum(["window_failed", "remote_refused"]);
export type LoginFailure = z.infer<typeof LoginFailure>;

export const Account = z.object({
  id: AccountId,
  ownerId: UserId,
  computerId: ComputerId,
  platform: Platform,
  handle: z.string().min(1).max(100).nullable(),
  tier: AccountTier,
  login: AccountLogin,
  // login 最近一次变的时刻。建占位时等于 createdAt，今天页的过期卡按它写「什么时候过期的」。
  loginChangedAt: Timestamp,
  createdAt: Timestamp,
});
export type Account = z.infer<typeof Account>;

export const PublishFailureReason = z.enum(["login_expired", "page_changed", "error"]);
export type PublishFailureReason = z.infer<typeof PublishFailureReason>;

export const DraftStatus = z.enum(["pending", "approved", "publishing", "published", "returned", "failed"]);
export type DraftStatus = z.infer<typeof DraftStatus>;
export const DraftKind = z.enum(["post", "reply"]);
export type DraftKind = z.infer<typeof DraftKind>;

export const DraftImage = z
  .object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type DraftImage = z.infer<typeof DraftImage>;

export const GithubTarget = z
  .object({ repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), as: z.enum(["issue", "discussion"]) })
  .strict();
export type GithubTarget = z.infer<typeof GithubTarget>;

export const ReplyTarget = z
  .object({ url: z.string().url(), author: z.string().min(1).max(100), quote: z.string().max(2000) })
  .strict();
export type ReplyTarget = z.infer<typeof ReplyTarget>;

export const DraftContent = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("post"),
      title: z.string().min(1).max(100).nullable(),
      text: z.string().min(1).max(10_000),
      images: z.array(DraftImage).max(9),
      github: GithubTarget.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("reply"),
      text: z.string().min(1).max(10_000),
      images: z.array(DraftImage).max(9),
      replyTo: ReplyTarget,
    })
    .strict(),
]);
export type DraftContent = z.infer<typeof DraftContent>;

export const DraftEdit = z.object({ before: z.string(), after: z.string(), at: Timestamp }).strict();
export type DraftEdit = z.infer<typeof DraftEdit>;

export const Draft = z.object({
  id: DraftId,
  groupId: GroupId,
  botId: BotId.nullable(),
  planId: ContentPlanId.nullable(),
  accountId: AccountId,
  platform: Platform,
  content: DraftContent,
  scheduledAt: Timestamp.nullable(),
  status: DraftStatus,
  edits: z.array(DraftEdit).max(50),
  failure: PublishFailureReason.nullable(),
  createdAt: Timestamp,
  decidedAt: Timestamp.nullable(),
});
export type Draft = z.infer<typeof Draft>;

export const ContentPlanStatus = z.enum(["pending", "approved", "returned"]);
export type ContentPlanStatus = z.infer<typeof ContentPlanStatus>;

export const ContentPlan = z.object({
  id: ContentPlanId,
  groupId: GroupId,
  botId: BotId.nullable(),
  title: z.string().min(1).max(60),
  status: ContentPlanStatus,
  draftIds: z.array(DraftId).min(1).max(20),
  createdAt: Timestamp,
  decidedAt: Timestamp.nullable(),
});
export type ContentPlan = z.infer<typeof ContentPlan>;

export const Publication = z.object({
  id: PublicationId,
  draftId: DraftId.nullable(),
  groupId: GroupId.nullable(),
  accountId: AccountId.nullable(),
  platform: Platform,
  url: z.string().url(),
  publishedAt: Timestamp,
});
export type Publication = z.infer<typeof Publication>;

/** stuck 专给电脑掉线：每人一条、不在线时暂存。别的「没办成、要你处理」用 failed，照普通通知走。 */
export const NotifyKind = z.enum(["confirm", "result", "stuck", "failed"]);
export type NotifyKind = z.infer<typeof NotifyKind>;
export const Notice = z
  .object({ kind: NotifyKind, text: z.string().min(1).max(200), groupId: GroupId.nullable(), at: Timestamp })
  .strict();
export type Notice = z.infer<typeof Notice>;

export const ModelPurpose = z.enum(["plan", "fast"]);
export type ModelPurpose = z.infer<typeof ModelPurpose>;
/** 模型网关对外的模型名，控制面按它映射到 GATEWAY_MODELS 里的真实模型。 */
export type GatewayModels = Record<ModelPurpose, string>;
export function gatewayAlias(purpose: ModelPurpose): `baize:${ModelPurpose}` {
  return `baize:${purpose}`;
}

export const Trigger = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cron"), expr: z.string() }),
  z.object({ kind: z.literal("webhook"), token: z.string() }),
]);
export const OnFailure = z.enum(["stop_and_tell", "retry_next_time"]);
export type OnFailure = z.infer<typeof OnFailure>;
export type Trigger = z.infer<typeof Trigger>;
// 触发那一刻就落一条 running 的记录，收尾时改成另外三种之一。运行途中控制面重启，记录就停在 running，
// 用户看得到「这次没跑完」，比收尾时才落记录、跑挂了就没痕迹要强。
export const RoutineRunStatus = z.enum(["running", "ok", "failed", "stopped"]);
export type RoutineRunStatus = z.infer<typeof RoutineRunStatus>;

export const RoutineRun = z.object({
  startedAt: Timestamp,
  status: RoutineRunStatus,
  note: z.string(),
});
export type RoutineRun = z.infer<typeof RoutineRun>;

export const Routine = z.object({
  id: RoutineId,
  botId: BotId,
  groupId: GroupId.nullable(),
  purpose: ModelPurpose,
  name: z.string().min(1),
  instruction: z.string(),
  triggers: z.array(Trigger),
  onFailure: OnFailure,
  enabled: z.boolean(),
  runs: z.array(RoutineRun).max(20),
});
export type Routine = z.infer<typeof Routine>;

// 用量是账，Bot 或群删了账要留着，所以这两个归属可空。
export const UsageRecord = z.object({
  runId: RunId,
  botId: BotId.nullable(),
  groupId: GroupId.nullable(),
  startedAt: Timestamp,
  endedAt: Timestamp,
  steps: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  amount: z.number(),
});
export type UsageRecord = z.infer<typeof UsageRecord>;
