import { z } from "zod";
import {
  Approval,
  Bot,
  BotHue,
  BotId,
  ChecklistItem,
  Group,
  GroupId,
  Message,
  MessageId,
  TaskStatus,
  Timestamp,
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
// approval 类消息的正文只有 approvalId，状态在 Approval 上，所以这一页引用到的审批跟着一起回，
// 客户端不用为了画一张卡再发一次请求。
export const MessageListResponse = z.object({
  messages: z.array(Message),
  hasMore: z.boolean(),
  approvals: z.array(Approval),
});

// POST /api/groups/:id/messages  正文里的「@Bot 名」由服务端解析成 mentions，多 Bot 群按它路由。
export const SendMessageRequest = z.object({ text: z.string().min(1) });
export const SendMessageResponse = z.object({ message: Message });

// POST /api/approvals/:id  归属人点批准或拒绝。别人的审批 404，已经有结论的 409。
export const DecideApprovalRequest = z.object({ decision: z.enum(["approved", "rejected"]) });
export type DecideApprovalRequest = z.infer<typeof DecideApprovalRequest>;
export const DecideApprovalResponse = z.object({ approval: Approval });

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
]);
export type ServerPush = z.infer<typeof ServerPush>;
