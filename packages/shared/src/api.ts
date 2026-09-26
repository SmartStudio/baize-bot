import { z } from "zod";
import {
  Account,
  AccountId,
  AccountTier,
  Approval,
  ApprovalScope,
  Bot,
  BotHue,
  BotId,
  ChecklistItem,
  Computer,
  ComputerId,
  ContentPlan,
  Draft,
  DraftContent,
  DraftId,
  Grant,
  GrantId,
  Group,
  GroupId,
  Handoff,
  Message,
  MessageId,
  OnFailure,
  Platform,
  Publication,
  PublicationId,
  BrowserPlatform,
  LoginAttemptId,
  LoginFailure,
  Notice,
  ModelPurpose,
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

// POST /api/register
export const RegisterRequest = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  name: z.string().min(1),
});
export const RegisterResponse = z.object({ user: User });

// POST /api/computers/local、POST /api/computers/remote。token 明文只在这次响应里出现。
export const ComputerTokenResponse = z.object({ computerId: ComputerId, token: z.string() });
export const ComputerListResponse = z.object({ computers: z.array(Computer) });

// POST /api/auth/logout 无请求体，响应 204。
// GET /api/me
export const MeResponse = z.object({ user: User });

// GET /api/computers  响应是 ComputerListResponse。本机和远程各至多一台。
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
export const BotResponse = z.object({ bot: Bot });

// POST /api/bots/:id/pause、POST /api/bots/:id/resume 无请求体，回 BotResponse。

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
    cadence: z.string().max(200),
  })
  .partial();
export const UpdateTaskResponse = z.object({ task: TopicTask });

// GET /api/groups/:id/messages?before=<messageId>&limit=50  按时间正序返回。
// approval 和 handoff 类消息的正文只有一个 id，状态在 Approval 或 Handoff 上，所以这一页引用到的都跟着一起回，
// 客户端不用为了画一张卡再发一次请求。publications 是本页草稿卡和计划卡下草稿的发布记录，按发布时间升序。
export const MessageListResponse = z.object({
  messages: z.array(Message),
  hasMore: z.boolean(),
  approvals: z.array(Approval),
  handoffs: z.array(Handoff),
  drafts: z.array(Draft),
  plans: z.array(ContentPlan),
  publications: z.array(Publication),
});

// POST /api/groups/:id/messages  正文里的「@Bot 名」由服务端解析成 mentions，多 Bot 群按它路由。
export const SendMessageRequest = z.object({ text: z.string().min(1) });
export const SendMessageResponse = z.object({ message: Message });

// POST /api/approvals/:id  归属人点批准或拒绝。别人的审批 404，已经有结论的 409。
export const DecideApprovalRequest = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approved"), scope: ApprovalScope.default("once") }).strict(),
  z.object({ decision: z.literal("rejected") }).strict(),
]);
export type DecideApprovalRequest = z.infer<typeof DecideApprovalRequest>;
export const DecideApprovalResponse = z.object({ approval: Approval, grant: Grant.nullable() });
// GET /api/grants
export const GrantListResponse = z.object({ grants: z.array(Grant) });
// DELETE /api/grants/:id 回 204。

// POST /api/drafts/:id 单条批准或退回。
export const DecideDraftRequest = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve"), content: DraftContent.optional() }).strict(),
  z.object({ decision: z.literal("return") }).strict(),
]);
export type DecideDraftRequest = z.infer<typeof DecideDraftRequest>;
export const DecideDraftResponse = z.object({ draft: Draft });

// POST /api/plans/:id/approve 一次批准整份计划。
export const ApprovePlanRequest = z
  .object({ edits: z.array(z.object({ draftId: DraftId, content: DraftContent }).strict()).max(20) })
  .strict();
export type ApprovePlanRequest = z.infer<typeof ApprovePlanRequest>;
export const ApprovePlanResponse = z.object({ plan: ContentPlan, drafts: z.array(Draft) });
export const ReturnPlanResponse = z.object({ plan: ContentPlan });

// GET /api/accounts
export const AccountListResponse = z.object({ accounts: z.array(Account) });
// POST /api/accounts  建未登录的占位，回 201；这个平台已经有占位就回那一行，200。浏览器平台只能挂本机电脑。
export const CreateAccountRequest = z.object({ platform: BrowserPlatform, computerId: ComputerId }).strict();
export type CreateAccountRequest = z.infer<typeof CreateAccountRequest>;
export const AccountResponse = z.object({ account: Account });
// POST /api/accounts/:id/login  打开登录窗口。attempt 是页面为这一次点击取的号，卡片一开就带着它；
// 控制面原样写进 browser_login 并在 202 里带回。登上随 account_updated 推回来，没成推 login_failed 带同一个号。
// attempt 格式不对 400，电脑不在线 409，别人的账号 404，不走浏览器登录的平台 400。
export const LoginAccountRequest = z.object({ attempt: LoginAttemptId }).strict();
export type LoginAccountRequest = z.infer<typeof LoginAccountRequest>;
export const LoginAccountResponse = z.object({ account: Account, attempt: LoginAttemptId });
export type LoginAccountResponse = z.infer<typeof LoginAccountResponse>;
// GET /api/oauth/:platform/start  浏览器跳过来，302 到 GitHub 或 X 的授权页。平台没配 503。
// GET /api/oauth/:platform/callback  平台跳回来，换令牌、挂账号，302 回 Web 首页，带 ?oauth=<平台>&result=<OAuthResult>。
// 结果只放在跳转地址里，账号本身随 account_updated 推给页面。
export const OAuthResult = z.enum(["connected", "denied", "invalid_state", "failed"]);
export type OAuthResult = z.infer<typeof OAuthResult>;
// PATCH /api/accounts/:id
export const UpdateAccountRequest = z.object({ tier: AccountTier }).strict();
export type UpdateAccountRequest = z.infer<typeof UpdateAccountRequest>;

// GET /api/bots/:id/routines  该 Bot 的例行任务，每条带最近 20 条运行记录，新的在前。别人的 Bot 404。
// GET /api/routines  自己全部 Bot 的例行任务，按建的先后排，形状同上。groupId 为 null 的发进那个 Bot 的单聊。
export const RoutineListResponse = z.object({ items: z.array(Routine) });

// 建和改例行任务时触发器写这个。webhook 的 token 由控制面发：带着这条例行任务已有的 token 就是保留那个地址，
// 不带或对不上就换一个新的。客户端选不了 token，`/api/hooks/:token` 不要登录，token 撞上就是别人能打你的例行任务。
export const TriggerInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cron"), expr: z.string().min(1).max(100) }),
  z.object({ kind: z.literal("webhook"), token: z.string().optional() }),
]);
export type TriggerInput = z.infer<typeof TriggerInput>;

// POST /api/bots/:id/routines  groupId 给了就落库，例行发进那个群；群不是自己的 404，这个 Bot 不在群里 400。
export const CreateRoutineRequest = z.object({
  name: z.string().min(1).max(40),
  instruction: z.string().min(1).max(4000),
  triggers: z.array(TriggerInput).max(10),
  onFailure: OnFailure,
  groupId: GroupId.nullable().optional(),
  purpose: ModelPurpose.optional(),
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

// POST /api/messages/:id/project-offer
export const DecideProjectOfferRequest = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("start"), name: z.string().min(1).max(40).optional() }).strict(),
  z.object({ decision: z.literal("dismiss") }).strict(),
]);
export type DecideProjectOfferRequest = z.infer<typeof DecideProjectOfferRequest>;
// start 时给了 name，群名和卡正文里的 name 都换成它。开始过的卡回项目群和它的任务卡，其余两个都是 null。
export const DecideProjectOfferResponse = z.object({
  message: Message,
  group: Group.nullable(),
  task: TopicTask.nullable(),
});

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

// GET /api/today  首页四栏。服务端把每一行要显示的都拼好、排好，Web 照数组顺序渲染，不再二次关联。
// 等你确认按 since 升序：新来的排在后面，不把已有的行往下挤。
// 挂在待批计划下的稿子只随计划那一项出现，不再单独成一项，所以待办数就是数组长度。
export const TodayPendingItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approval"), since: Timestamp, approval: Approval }).strict(),
  z.object({ kind: z.literal("plan"), since: Timestamp, plan: ContentPlan, drafts: z.array(Draft).max(20) }).strict(),
  z.object({ kind: z.literal("draft"), since: Timestamp, draft: Draft }).strict(),
  z.object({ kind: z.literal("account"), since: Timestamp, account: Account }).strict(),
]);
export type TodayPendingItem = z.infer<typeof TodayPendingItem>;

// 刚做完按 at 降序。title 由服务端取好：发布取稿子标题或正文开头，计划取计划标题，例行取例行名。
export const TodayDoneItem = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("publication"),
      at: Timestamp,
      groupId: GroupId.nullable(),
      title: z.string().min(1).max(80),
      platform: Platform,
      url: z.string().url(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("plan_approved"),
      at: Timestamp,
      groupId: GroupId,
      title: z.string().min(1).max(80),
      draftCount: z.number().int().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("routine"),
      at: Timestamp,
      groupId: GroupId.nullable(),
      title: z.string().min(1).max(80),
      note: z.string().max(200),
    })
    .strict(),
]);
export type TodayDoneItem = z.infer<typeof TodayDoneItem>;

// 进行中一个项目一行，进度是这个项目当前计划里已发出的稿子数对总数，没有计划时两个都是 0。
export const TodayRunningItem = z
  .object({
    groupId: GroupId,
    title: z.string().min(1),
    published: z.number().int().nonnegative(),
    planned: z.number().int().nonnegative(),
  })
  .strict();
export type TodayRunningItem = z.infer<typeof TodayRunningItem>;

// 接下来按 at 升序：排了时间的稿子和下一次要跑的例行。
export const TodayNextItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("draft"), at: Timestamp, draft: Draft }).strict(),
  z
    .object({
      kind: z.literal("routine"),
      at: Timestamp,
      routineId: RoutineId,
      groupId: GroupId.nullable(),
      botId: BotId,
      title: z.string().min(1),
    })
    .strict(),
]);
export type TodayNextItem = z.infer<typeof TodayNextItem>;

// assistantLatest 是主助理单聊里最近一条有字的 Bot 消息，正文截到 200 字；没有主助理或它还没说过话是 null。
export const TodayAssistantLine = z.object({ text: z.string().min(1).max(200), at: Timestamp }).strict();
export type TodayAssistantLine = z.infer<typeof TodayAssistantLine>;

export const TodayResponse = z
  .object({
    assistantGroupId: GroupId.nullable(),
    assistantLatest: TodayAssistantLine.nullable(),
    pending: z.array(TodayPendingItem).max(50),
    done: z.array(TodayDoneItem).max(20),
    running: z.array(TodayRunningItem).max(20),
    next: z.array(TodayNextItem).max(20),
  })
  .strict();
export type TodayResponse = z.infer<typeof TodayResponse>;

// GET /api/projects/:groupId  项目页。项目就是多 Bot 群加它的任务卡，项目 id 就是群 id；别人的群、单 Bot 群都回 404。
// 标题、目标和清单进度 Web 从已有的群和任务卡里读，task_updated 会更新那一份，这里只给那边没有的。
// weekPublished 是本周（周一 00:00 Asia/Shanghai 起）这个群发出了几条。
// 一轮是你说的一句话，连同它之后、你下一句之前群里的其他消息。latestTurn 是最近一轮：said 是你按 createdAt 最后说的那句，
// replies 是它之后的消息，按 createdAt 升序，不含 cost，超过 50 条只给最近的 50 条；你一句都没说过是 null。
// 它直接从库里取，不受群历史分页的窗口限制。olderTurns 是更早的轮数，也就是你说过的句数减一。
// working 是这个群里还没结束的 run，title 的取法和用量页一样。pending 只有这个群的卡，排法同首页。
// plan 是最近批准的那份计划和它的稿子，next 是这个群最近一件排了时间的事。
// achievements 只来自发布记录，不读历史消息，按 at 降序；url 是原帖链接，读不到笔记 id 时是管理页链接。
export const ProjectWorkingItem = z
  .object({ botId: BotId.nullable(), title: z.string().min(1).max(80), since: Timestamp })
  .strict();
export type ProjectWorkingItem = z.infer<typeof ProjectWorkingItem>;
export const ProjectAchievement = z
  .object({
    id: PublicationId,
    at: Timestamp,
    title: z.string().min(1).max(80),
    platform: Platform,
    url: z.string().url(),
  })
  .strict();
export type ProjectAchievement = z.infer<typeof ProjectAchievement>;
export const ProjectRoutineItem = z
  .object({
    routineId: RoutineId,
    botId: BotId,
    name: z.string().min(1),
    enabled: z.boolean(),
    nextAt: Timestamp.nullable(),
  })
  .strict();
export type ProjectRoutineItem = z.infer<typeof ProjectRoutineItem>;
export const ProjectTurn = z.object({ said: Message, replies: z.array(Message).max(50) }).strict();
export type ProjectTurn = z.infer<typeof ProjectTurn>;
export const ProjectResponse = z
  .object({
    groupId: GroupId,
    weekPublished: z.number().int().nonnegative(),
    latestTurn: ProjectTurn.nullable(),
    olderTurns: z.number().int().nonnegative(),
    working: z.array(ProjectWorkingItem).max(20),
    pending: z.array(TodayPendingItem).max(50),
    plan: z
      .object({ plan: ContentPlan, drafts: z.array(Draft).max(20) })
      .strict()
      .nullable(),
    next: TodayNextItem.nullable(),
    achievements: z.array(ProjectAchievement).max(20),
    routines: z.array(ProjectRoutineItem).max(50),
  })
  .strict();
export type ProjectResponse = z.infer<typeof ProjectResponse>;

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
  // 群本身变了（目前只有首席）推整条，客户端整条替换。
  z.object({ type: z.literal("group_updated"), group: Group }),
  // 群回合推进：current 是正在说的，next 是排在后面的。回合结束推 current null、next 空。
  // 没有快照接口：连上 /api/ws 时正在进行的回合各推一条。
  z.object({
    type: z.literal("group_turn"),
    groupId: GroupId,
    epoch: z.number().int().nonnegative(),
    current: BotId.nullable(),
    next: z.array(BotId),
  }),
  z.object({ type: z.literal("task_updated"), task: TopicTask }),
  // 审批新建和有了结论都推这一条。approval 消息的正文只有 approvalId，重推那条 message 一个字都不会变，
  // 结论只能随 Approval 走。新建时先推 approval_updated 再推那条 message。
  z.object({ type: z.literal("approval_updated"), approval: Approval }),
  z.object({ type: z.literal("grant_deleted"), grantId: GrantId }),
  // 交接同理：新建和确认都推这一条，先推它再推那条 handoff 消息。
  z.object({ type: z.literal("handoff_updated"), handoff: Handoff }),
  // 建、改、每条运行记录的状态变化都推整条例行任务，客户端整条替换。
  z.object({ type: z.literal("routine_updated"), routine: Routine }),
  z.object({ type: z.literal("routine_deleted"), routineId: RoutineId, botId: BotId }),
  // 建、改、复制、`/名` 引用计数加一都推整条 skill，客户端整条替换。删推 skill_deleted。
  z.object({ type: z.literal("skill_updated"), skill: Skill }),
  z.object({ type: z.literal("skill_deleted"), skillId: SkillId, botId: BotId }),
  z.object({ type: z.literal("draft_updated"), draft: Draft }),
  z.object({ type: z.literal("plan_updated"), plan: ContentPlan }),
  z.object({ type: z.literal("account_updated"), account: Account }),
  z.object({ type: z.literal("account_deleted"), accountId: AccountId }),
  z.object({ type: z.literal("publication_created"), publication: Publication }),
  z.object({ type: z.literal("computer_updated"), computer: Computer }),
  // 一次登录没成。账号的 login 不变，所以没有 account_updated；attempt 是 POST /api/accounts/:id/login 回的那个。
  z.object({ type: z.literal("login_failed"), accountId: AccountId, attempt: LoginAttemptId, reason: LoginFailure }),
  z.object({ type: z.literal("notify"), notice: Notice }),
]);
export type ServerPush = z.infer<typeof ServerPush>;
