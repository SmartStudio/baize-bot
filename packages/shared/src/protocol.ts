import { z } from "zod";
import {
  BotId,
  ChecklistItem,
  ComputerId,
  GroupId,
  HandoffId,
  MessageId,
  RunId,
  SiteLogin,
  Skill,
  ToolConnection,
  TopicTask,
  UserId,
} from "./domain.js";

// 控制面和电脑代理之间的 WebSocket 报文。电脑代理出站连接，连上后先发 hello。
// 两个方向各一个 discriminatedUnion。加一种报文就在这里加一个分支。

// 运行器拿这个头去连 MCP。控制面存的是密文，下发时解开。
export const ToolConnectionConfig = ToolConnection.extend({ authorization: z.string().nullable() });
export type ToolConnectionConfig = z.infer<typeof ToolConnectionConfig>;

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
    code: z.enum(["bad_message", "prompt_before_config", "unsupported", "runner_failed"]),
    detail: z.string(),
    // 知道是哪个活出的错就带上群号；不带时控制面退回到这台电脑最近一个未结束的 run。
    groupId: GroupId.optional(),
  }),
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
    kind: z.enum(["send_external", "change_production_data", "pay"]),
    summary: z.string(),
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
]);
export type AgentToControl = z.infer<typeof AgentToControl>;

// 控制面收下 hello 后必须回 welcome。电脑代理只在收到 welcome 时把重连退避清零。
export const ControlToAgent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), ownerId: UserId, serverTime: z.string().datetime() }),
  z.object({
    type: z.literal("config"),
    bots: z.array(z.object({ id: BotId, name: z.string(), description: z.string() })),
    // 只给分配到的 Bot 加载。authorization 只走这条报文，公开的 ToolConnection 不带。
    tools: z.array(ToolConnectionConfig),
    // 该用户全部 Bot 的 skill，运行器按 botId 分开落成 SKILL.md。M10 控制面接上前可省。
    skills: z.array(Skill).optional(),
    modelGateway: z.object({ baseUrl: z.string().url(), apiKey: z.string(), model: z.string() }),
  }),
  z.object({
    type: z.literal("prompt"),
    runId: RunId,
    botId: BotId,
    groupId: GroupId,
    text: z.string(),
    context: z.array(z.object({ from: z.string(), text: z.string() })),
    // 多 Bot 群带任务卡和成员名单，Bot 靠名单知道能 @ 谁。单 Bot 群 task 为 null，members 只有它自己。
    task: TopicTask.nullable(),
    members: z.array(z.object({ id: BotId, name: z.string() })),
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
]);
export type ControlToAgent = z.infer<typeof ControlToAgent>;
