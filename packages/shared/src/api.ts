import { z } from "zod";
import { Bot, BotHue, BotId, Group, GroupId, Message, MessageId, User } from "./domain.js";

// 控制面 HTTP API 的请求和响应。web 和 control-plane 都只认这里的 schema。
// 路径和方法写在每个条目的注释里。所有接口的错误响应是 { error: string }。

export const ApiError = z.object({ error: z.string() });

// POST /api/auth/login
export const LoginRequest = z.object({ email: z.string().email(), password: z.string().min(1) });
export const LoginResponse = z.object({ user: User });

// POST /api/auth/logout 无请求体，响应 204。
// GET /api/me
export const MeResponse = z.object({ user: User });

// GET /api/bots  侧栏需要每个 Bot 的单 Bot 群和最近一条消息。
export const BotListItem = z.object({
  bot: Bot,
  groupId: GroupId,
  lastMessage: Message.nullable(),
  pendingApprovals: z.number().int().nonnegative(),
});
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

// GET /api/groups/:id/messages?before=<messageId>&limit=50  按时间正序返回。
export const MessageListResponse = z.object({ messages: z.array(Message), hasMore: z.boolean() });

// POST /api/groups/:id/messages
export const SendMessageRequest = z.object({ text: z.string().min(1) });
export const SendMessageResponse = z.object({ message: Message });

// GET /api/settings 和 PATCH /api/settings
export const Settings = z.object({
  theme: z.enum(["light", "dark", "system"]),
  notify: z.boolean(),
  dndFrom: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  dndTo: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
});
export type Settings = z.infer<typeof Settings>;
export const UpdateSettingsRequest = Settings.partial();

// WebSocket /api/ws  登录后客户端连上，服务端推送。客户端不发报文。
export const ServerPush = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), message: Message }),
  z.object({ type: z.literal("message_delta"), messageId: MessageId, groupId: GroupId, delta: z.string(), done: z.boolean() }),
  z.object({ type: z.literal("bot_updated"), bot: Bot }),
  z.object({ type: z.literal("bot_deleted"), botId: BotId }),
]);
export type ServerPush = z.infer<typeof ServerPush>;
