import { z } from "zod";
import {
  Approval,
  Bot,
  BotHue,
  BotId,
  ChecklistItem,
  Group,
  GroupId,
  Handoff,
  Message,
  MessageId,
  OnFailure,
  Routine,
  RunId,
  RoutineId,
  Skill,
  SkillId,
  SkillName,
  SkillSteps,
  TaskStatus,
  Timestamp,
  ToolConnection,
  ToolOperation,
  TopicTask,
  User,
} from "./domain.js";

// 控制面 HTTP API 的请求和响应。web 和 control-plane 都只认这里的 schema。
// 路径和方法写在每个条目的注释里。所有接口的错误响应是 { error: string }。

export const ApiError = z.object({ error: z.string() });

// POST /api/auth/login
export const LoginRequest = z.object({ email: z.string().email(), password: z.string().min(1) });
export const LoginResponse = z.object({ user: User });

// POST /api/auth/logout 无请求体，响应 204。
// GET /api/me
export const MeResponse = z.object({ user: User });

// GET /api/computer  响应是 domain 里的 Computer。首次登录时建出来，状态先是 creating。
// GET /api/bots  侧栏需要每个 Bot 的单 Bot 群和最近一条消息。
export const BotListItem = z.object({
  bot: Bot,
  groupId: GroupId,
  lastMessage: Message.nullable(),
  pendingApprovals: z.number().int().nonnegative(),
  pendingHandoffs: z.number().int().nonnegative(),
});
export type BotListItem = z.infer<typeof BotListItem>;
export const BotListResponse = z.object({ items: z.array(BotListItem) });

// POST /api/bots  建 Bot 时同步建它的单 Bot 群。全部字段可省，省了系统起名。
export const CreateBotRequest = z.object({
  name: z.string().min(1).max(20).optional(),
  tag: z.string().max(20).optional(),
  description: z.string().optional(),
  hue: BotHue.optional(),
});
export const CreateBotResponse = z.object({ bot: Bot, group: Group });

// PATCH /api/bots/:id
export const UpdateBotRequest = CreateBotRequest.extend({ notify: z.boolean().optional() });
export const UpdateBotResponse = z.object({ bot: Bot });

// DELETE /api/bots/:id 响应 204。

// POST /api/groups  建群同时建主题任务，编号由系统分配。单 Bot 群不走这里，建 Bot 时自动建。
export const CreateGroupRequest = z.object({
  title: z.string().min(1).max(60),
  botIds: z.array(BotId).min(2).max(6),
  summary: z.string().max(200).optional(),
  dueAt: Timestamp.nullable().optional(),
});
export const CreateGroupResponse = z.object({ group: Group, task: TopicTask });

// GET /api/groups  只列多 Bot 群。单 Bot 群在 /api/bots 里。
export const GroupListItem = z.object({
  group: Group,
  task: TopicTask,
  lastMessage: Message.nullable(),
  pendingApprovals: z.number().int().nonnegative(),
  pendingHandoffs: z.number().int().nonnegative(),
});
export type GroupListItem = z.infer<typeof GroupListItem>;
export const GroupListResponse = z.object({ items: z.array(GroupListItem) });

// GET /api/groups/:id  群顶部的任务卡和成员。
export const GroupResponse = z.object({ group: Group, task: TopicTask, bots: z.array(Bot) });

// PATCH /api/tasks/:id  用户改任务卡。清单整份替换。
export const UpdateTaskRequest = z
  .object({
    title: z.string().min(1).max(60),
    summary: z.string().max(200),
    dueAt: Timestamp.nullable(),
    checklist: z.array(ChecklistItem).max(50),
    status: TaskStatus,
  })
  .partial();
export const UpdateTaskResponse = z.object({ task: TopicTask });

// GET /api/groups/:id/messages?before=<messageId>&limit=50  按时间正序返回。
// approval 和 handoff 类消息的正文只有一个 id，状态在 Approval 或 Handoff 上，所以这一页引用到的都跟着一起回，
// 客户端不用为了画一张卡再发一次请求。
export const MessageListResponse = z.object({
  messages: z.array(Message),
  hasMore: z.boolean(),
  approvals: z.array(Approval),
  handoffs: z.array(Handoff),
});

// POST /api/groups/:id/messages  正文里的「@Bot 名」由服务端解析成 mentions，多 Bot 群按它路由。
export const SendMessageRequest = z.object({ text: z.string().min(1) });
export const SendMessageResponse = z.object({ message: Message });

// POST /api/approvals/:id  归属人点批准或拒绝。别人的审批 404，已经有结论的 409。
export const DecideApprovalRequest = z.object({ decision: z.enum(["approved", "rejected"]) });
export type DecideApprovalRequest = z.infer<typeof DecideApprovalRequest>;
export const DecideApprovalResponse = z.object({ approval: Approval });

// GET /api/bots/:id/routines  该 Bot 的例行任务，每条带最近 20 条运行记录，新的在前。别人的 Bot 404。
export const RoutineListResponse = z.object({ items: z.array(Routine) });

// 建和改例行任务时触发器写这个。webhook 的 token 由控制面发：带着这条例行任务已有的 token 就是保留那个地址，
// 不带或对不上就换一个新的。客户端选不了 token，`/api/hooks/:token` 不要登录，token 撞上就是别人能打你的例行任务。
export const TriggerInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cron"), expr: z.string().min(1).max(100) }),
  z.object({ kind: z.literal("webhook"), token: z.string().optional() }),
]);
export type TriggerInput = z.infer<typeof TriggerInput>;

// POST /api/bots/:id/routines
export const CreateRoutineRequest = z.object({
  name: z.string().min(1).max(40),
  instruction: z.string().min(1).max(4000),
  triggers: z.array(TriggerInput).max(10),
  onFailure: OnFailure,
  enabled: z.boolean().default(true),
});
export type CreateRoutineRequest = z.infer<typeof CreateRoutineRequest>;
export const RoutineResponse = z.object({ routine: Routine });

// PATCH /api/routines/:id  给到的字段整份替换，triggers 给了就是整份替换。别人的 404。
export const UpdateRoutineRequest = CreateRoutineRequest.partial();
export type UpdateRoutineRequest = z.infer<typeof UpdateRoutineRequest>;

// DELETE /api/routines/:id  回 204，运行记录跟着删。
// POST /api/routines/:id/run  试跑一次。和到点触发走同一条路，回 202 与 RoutineResponse，runs 最前面已多一条 running。
// 停用的也能试跑，停用只挡自动触发。
// POST /api/hooks/:token  不要登录，请求体忽略。回 202 空体；token 对不上 404；例行任务停用 409。

// GET /api/bots/:id/skills  该 Bot 会做的活。别人的 Bot 404。
export const SkillListResponse = z.object({ items: z.array(Skill) });

// POST /api/bots/:id/skills  用户在 Web「教它一个」，source 记 taught，回 201。同一 Bot 下名字撞了 409。
export const CreateSkillRequest = z.object({ name: SkillName, steps: SkillSteps });
export type CreateSkillRequest = z.infer<typeof CreateSkillRequest>;
export const SkillResponse = z.object({ skill: Skill });

// PATCH /api/skills/:id  给到的字段整份替换，steps 给了就是整份替换。改名撞了 409，别人的 404。
export const UpdateSkillRequest = CreateSkillRequest.partial();
export type UpdateSkillRequest = z.infer<typeof UpdateSkillRequest>;

// DELETE /api/skills/:id  回 204。
// POST /api/skills/:id/copy  复制给自己的另一个 Bot，来源保留，useCount 归零，回 201 与 SkillResponse。
// 目标 Bot 不是自己的 404，目标 Bot 已有同名 409。
export const CopySkillRequest = z.object({ botId: BotId });
export type CopySkillRequest = z.infer<typeof CopySkillRequest>;

// POST /api/messages/:id/skill-offer  群里那张卡点「存」或「不存」。消息不是 skill_offer 404，已有结论 409。
// save 建 skill 行、把消息 status 改成 saved 并重推那条 message，再推 skill_updated 和新的 config；
// 名字和该 Bot 已有的撞了也是 409，卡留在 offered 让用户先改名。dismiss 只改 status，skill 回 null。
export const DecideSkillOfferRequest = z.object({ decision: z.enum(["save", "dismiss"]) });
export type DecideSkillOfferRequest = z.infer<typeof DecideSkillOfferRequest>;
export const DecideSkillOfferResponse = z.object({ message: Message, skill: Skill.nullable() });

// GET /api/tools  设置的工具页。自己的全部工具连接，operations 带 needsApproval 现值；响应里没有 authorization。
export const ToolListResponse = z.object({ items: z.array(ToolConnection) });

// POST /api/tools  连一个 MCP（Streamable HTTP）。控制面当场 initialize 加 tools/list，连不上或不是 MCP 回 400 并说原因；
// operations 按注解定 needsApproval；assignedBotIds 起始为空。回 201。同名 409。
export const CreateToolRequest = z.object({
  name: z.string().min(1).max(40),
  url: z.string().url(),
  authorization: z.string().min(1).optional(),
});
export type CreateToolRequest = z.infer<typeof CreateToolRequest>;
export const ToolResponse = z.object({ tool: ToolConnection });

// PATCH /api/tools/:id  给到的字段整份替换。operations 只收 name 与 needsApproval，name 不在这条连接上 400；
// assignedBotIds 里不是自己的 Bot 400。改完重发 config。别人的 404。
export const UpdateToolRequest = z.object({
  name: z.string().min(1).max(40).optional(),
  assignedBotIds: z.array(BotId).optional(),
  operations: z.array(ToolOperation.pick({ name: true, needsApproval: true })).optional(),
});
export type UpdateToolRequest = z.infer<typeof UpdateToolRequest>;

// DELETE /api/tools/:id  回 204，重发 config。

// GET /api/usage  设置的用量页。本周从周一 00:00（Asia/Shanghai）起算，weekStartsAt 告诉客户端这一刻。
// 每个自己的 Bot 一行，本周没干活的也在，amount 是 0；删掉的 Bot 留下的 run 只进 total。预算是后续，响应里没有 budget。
export const UsageBotLine = z.object({
  botId: BotId,
  amount: z.number().nonnegative(),
  runs: z.number().int().nonnegative(),
});
export type UsageBotLine = z.infer<typeof UsageBotLine>;
// title 由控制面定：用户派的活取那句话的前 40 字，例行任务派的取「例行 · 名字」，其余取群的主题任务标题。
export const UsageRunItem = z.object({
  runId: RunId,
  botId: BotId.nullable(),
  groupId: GroupId.nullable(),
  title: z.string().max(80),
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
  steps: z.number().int().nonnegative(),
  amount: z.number().nonnegative(),
});
export type UsageRunItem = z.infer<typeof UsageRunItem>;
export const UsageResponse = z.object({
  weekStartsAt: Timestamp,
  total: z.number().nonnegative(),
  bots: z.array(UsageBotLine),
  recent: z.array(UsageRunItem).max(20),
});
export type UsageResponse = z.infer<typeof UsageResponse>;

// GET /api/overnight  「你下线的时候，活没停」。since 是这个用户上一条推送连接断开的时刻，从没连过是 null。
// 每个 Bot 最多一条：since 之后它最新一句话。等你 = 那个群有它发起的待审批或待接手；在干活 = 它有没结束的 run；其余算完成。
// 断开不到 30 分钟又回来，items 给空数组，客户端不弹卡。
export const OvernightStatus = z.enum(["done", "waiting", "working"]);
export type OvernightStatus = z.infer<typeof OvernightStatus>;
export const OvernightItem = z.object({
  botId: BotId,
  groupId: GroupId,
  text: z.string().max(200),
  status: OvernightStatus,
  at: Timestamp,
});
export type OvernightItem = z.infer<typeof OvernightItem>;
export const OvernightResponse = z.object({ since: Timestamp.nullable(), items: z.array(OvernightItem).max(10) });
export type OvernightResponse = z.infer<typeof OvernightResponse>;

// GET /api/settings 和 PATCH /api/settings
export const Settings = z.object({
  theme: z.enum(["light", "dark", "system"]),
  notify: z.boolean(),
  dndFrom: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable(),
  dndTo: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable(),
});
export type Settings = z.infer<typeof Settings>;
export const UpdateSettingsRequest = Settings.partial();

// WebSocket /api/ws  登录后客户端连上，服务端推送。客户端不发报文。
// Bot 流式回复先推一条空正文的 message，随后每段 delta 推一条 message_delta，客户端按 messageId 往上追加。
export const ServerPush = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), message: Message }),
  z.object({
    type: z.literal("message_delta"),
    messageId: MessageId,
    groupId: GroupId,
    delta: z.string(),
    done: z.boolean(),
  }),
  z.object({ type: z.literal("bot_updated"), bot: Bot }),
  z.object({ type: z.literal("bot_deleted"), botId: BotId }),
  z.object({ type: z.literal("group_created"), group: Group, task: TopicTask }),
  z.object({ type: z.literal("task_updated"), task: TopicTask }),
  // 审批新建和有了结论都推这一条。approval 消息的正文只有 approvalId，重推那条 message 一个字都不会变，
  // 结论只能随 Approval 走。新建时先推 approval_updated 再推那条 message。
  z.object({ type: z.literal("approval_updated"), approval: Approval }),
  // 交接同理：新建和确认都推这一条，先推它再推那条 handoff 消息。
  z.object({ type: z.literal("handoff_updated"), handoff: Handoff }),
  // 建、改、每条运行记录的状态变化都推整条例行任务，客户端整条替换。
  z.object({ type: z.literal("routine_updated"), routine: Routine }),
  z.object({ type: z.literal("routine_deleted"), routineId: RoutineId, botId: BotId }),
  // 建、改、复制、`/名` 引用计数加一都推整条 skill，客户端整条替换。删推 skill_deleted。
  z.object({ type: z.literal("skill_updated"), skill: Skill }),
  z.object({ type: z.literal("skill_deleted"), skillId: SkillId, botId: BotId }),
]);
export type ServerPush = z.infer<typeof ServerPush>;
