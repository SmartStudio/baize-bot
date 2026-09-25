import { z } from "zod";

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

export const Timestamp = z.string().datetime();

export const User = z.object({
  id: UserId,
  name: z.string().min(1),
  email: z.string().email(),
  teamName: z.string().default(""),
  createdAt: Timestamp,
});
export type User = z.infer<typeof User>;

export const ComputerStatus = z.enum(["creating", "online", "sleeping", "failed"]);
export type ComputerStatus = z.infer<typeof ComputerStatus>;

export const Computer = z.object({
  id: ComputerId,
  ownerId: UserId,
  status: ComputerStatus,
  host: z.string().nullable(),
  idleSince: Timestamp.nullable(),
  lastSeenAt: Timestamp.nullable(),
});
export type Computer = z.infer<typeof Computer>;

// 七个队友色相，来自设计系统 tokens/colors.css 的 --bot-*。
export const BotHue = z.enum(["coral", "tangerine", "lime", "mint", "sky", "violet", "pink"]);
export type BotHue = z.infer<typeof BotHue>;

export const Bot = z.object({
  id: BotId,
  ownerId: UserId,
  name: z.string().min(1).max(20),
  tag: z.string().max(20).default(""),
  description: z.string().default(""),
  hue: BotHue,
  notify: z.boolean().default(true),
  toolConnectionIds: z.array(ToolConnectionId).default([]),
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

export const ApprovalKind = z.enum(["send_external", "change_production_data", "pay"]);
export const ApprovalStatus = z.enum(["pending", "approved", "rejected", "expired"]);

export const Approval = z.object({
  id: ApprovalId,
  groupId: GroupId,
  botId: BotId,
  runId: RunId,
  kind: ApprovalKind,
  summary: z.string(),
  status: ApprovalStatus,
  decidedAt: Timestamp.nullable(),
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
    botId: BotId,
    tool: z.string(),
    argsSummary: z.string(),
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

export const SiteLoginStatus = z.enum(["valid", "expired"]);

export const SiteLogin = z.object({
  domain: z.string(),
  loggedInAt: Timestamp,
  by: z.enum(["user", "bot"]),
  status: SiteLoginStatus,
});
export type SiteLogin = z.infer<typeof SiteLogin>;

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
