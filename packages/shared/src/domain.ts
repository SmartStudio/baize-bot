import { z } from "zod";

// 对象模型。依据 spec/规格.md 第一部分。每个对象一个 zod schema，类型从 schema 推导。
// 状态一律用字面量联合，不用布尔组合。

const id = (brand: string) => z.string().min(1).brand(brand);

export const UserId = id("UserId");
export const ComputerId = id("ComputerId");
export const DesktopId = id("DesktopId");
export const BotId = id("BotId");
export const GroupId = id("GroupId");
export const TaskId = id("TaskId");
export const MessageId = id("MessageId");
export const ApprovalId = id("ApprovalId");
export const HandoffId = id("HandoffId");
export const ToolConnectionId = id("ToolConnectionId");
export const SkillId = id("SkillId");
export const RoutineId = id("RoutineId");
export const RunId = id("RunId");

export type UserId = z.infer<typeof UserId>;
export type ComputerId = z.infer<typeof ComputerId>;
export type DesktopId = z.infer<typeof DesktopId>;
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

export const DesktopStatus = z.enum(["idle", "working", "taken_over"]);
export type DesktopStatus = z.infer<typeof DesktopStatus>;

export const Desktop = z.object({
  id: DesktopId,
  computerId: ComputerId,
  botId: BotId,
  status: DesktopStatus,
  streamUrl: z.string().nullable(),
});
export type Desktop = z.infer<typeof Desktop>;

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
  createdAt: Timestamp,
});
export type Group = z.infer<typeof Group>;

export const ApprovalKind = z.enum(["send_external", "change_production_data", "pay"]);
export const ApprovalStatus = z.enum(["pending", "approved", "rejected"]);

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
});
export type Handoff = z.infer<typeof Handoff>;

export const ToolCallStatus = z.enum(["running", "ok", "failed", "blocked"]);

// 群里的一条记录。kind 决定其余字段。
export const MessageBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), text: z.string() }),
  z.object({ kind: z.literal("bot"), botId: BotId, text: z.string(), streaming: z.boolean() }),
  z.object({ kind: z.literal("system"), text: z.string() }),
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
  z.object({ kind: z.literal("cost"), runId: RunId, steps: z.number().int(), amount: z.number() }),
]);
export type MessageBody = z.infer<typeof MessageBody>;

export const Message = z.object({
  id: MessageId,
  groupId: GroupId,
  body: MessageBody,
  createdAt: Timestamp,
});
export type Message = z.infer<typeof Message>;

export const ToolOperation = z.object({
  name: z.string(),
  needsApproval: z.boolean(),
});

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

export const SkillSource = z.enum(["chat", "routine", "taught"]);

export const Skill = z.object({
  id: SkillId,
  botId: BotId,
  name: z.string().min(1),
  source: SkillSource,
  steps: z.array(z.string()),
  useCount: z.number().int().nonnegative(),
});
export type Skill = z.infer<typeof Skill>;

export const Trigger = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cron"), expr: z.string() }),
  z.object({ kind: z.literal("webhook"), token: z.string() }),
]);
export const OnFailure = z.enum(["stop_and_tell", "retry_next_time"]);
export const RoutineRunStatus = z.enum(["ok", "failed", "stopped"]);

export const RoutineRun = z.object({
  startedAt: Timestamp,
  status: RoutineRunStatus,
  note: z.string(),
});

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

export const UsageRecord = z.object({
  runId: RunId,
  botId: BotId,
  groupId: GroupId,
  startedAt: Timestamp,
  endedAt: Timestamp,
  steps: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  amount: z.number(),
});
export type UsageRecord = z.infer<typeof UsageRecord>;
