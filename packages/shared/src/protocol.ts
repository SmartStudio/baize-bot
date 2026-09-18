import { z } from "zod";
import { BotId, ComputerId, GroupId, MessageId, RunId, SiteLogin, ToolConnection, UserId } from "./domain.js";

// 控制面和电脑代理之间的 WebSocket 报文。电脑代理出站连接，连上后先发 hello。
// 两个方向各一个 discriminatedUnion。加一种报文就在这里加一个分支。

export const AgentToControl = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), computerId: ComputerId, token: z.string(), version: z.string() }),
  z.object({ type: z.literal("heartbeat"), at: z.string().datetime() }),
  z.object({ type: z.literal("sites"), sites: z.array(SiteLogin) }),
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
    argsSummary: z.string(),
    status: z.enum(["running", "ok", "failed", "blocked"]),
    durationMs: z.number().nullable(),
  }),
  z.object({
    type: z.literal("run_done"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    steps: z.number().int(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
  }),
  z.object({
    type: z.literal("approval_request"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    callId: z.string(),
    kind: z.enum(["send_external", "change_production_data", "pay"]),
    summary: z.string(),
  }),
]);
export type AgentToControl = z.infer<typeof AgentToControl>;

export const ControlToAgent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), ownerId: UserId, serverTime: z.string().datetime() }),
  z.object({
    type: z.literal("config"),
    bots: z.array(z.object({ id: BotId, name: z.string(), description: z.string() })),
    tools: z.array(ToolConnection),
    modelGateway: z.object({ baseUrl: z.string().url(), apiKey: z.string(), model: z.string() }),
  }),
  z.object({
    type: z.literal("prompt"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    text: z.string(),
    context: z.array(z.object({ from: z.string(), text: z.string() })),
  }),
  z.object({
    type: z.literal("approval_result"),
    runId: RunId,
    callId: z.string(),
    approved: z.boolean(),
  }),
  z.object({ type: z.literal("pause"), botId: BotId }),
  z.object({ type: z.literal("resume"), botId: BotId }),
]);
export type ControlToAgent = z.infer<typeof ControlToAgent>;
