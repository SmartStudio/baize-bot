import type {
  AccountLogin as AccountLoginSchema,
  AccountTier as AccountTierSchema,
  ActionKind as ActionKindSchema,
  ApprovalStatus as ApprovalStatusSchema,
  AttachmentMime,
  BotHue,
  BotRole as BotRoleSchema,
  BotRunState as BotRunStateSchema,
  BrandEdit,
  ChecklistItem,
  ComputerKind as ComputerKindSchema,
  ComputerStatus,
  ContentPlanStatus as ContentPlanStatusSchema,
  ControlToAgent,
  DraftContent,
  DraftEdit,
  DraftStatus as DraftStatusSchema,
  GrantTarget,
  HandoffStatus as HandoffStatusSchema,
  LoginFailure as LoginFailureSchema,
  MessageBody,
  MessageId,
  MetricSource,
  ModelPurpose as ModelPurposeSchema,
  OAuthPlatform,
  OnFailure as OnFailureSchema,
  Platform as PlatformSchema,
  PokerBlinds,
  PokerEvent,
  PokerPersona,
  PokerReview,
  PokerSeatNo,
  PokerTableRole,
  PokerTableStatus,
  PublishFailureReason as PublishFailureReasonSchema,
  RoutineBoundary as RoutineBoundarySchema,
  RoutineRunStatus as RoutineRunStatusSchema,
  RoutineState as RoutineStateSchema,
  SkillSource,
  ToolOperation,
  ToolConnectionStatus as ToolConnectionStatusSchema,
  ToolView,
  TaskStatus as TaskStatusSchema,
  Viewer,
} from "@baize/shared";
import type { RetainSnapshot } from "@baize/shared/work-record";
import { sql } from "drizzle-orm";
import type { z } from "zod";
import {
  bigserial,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// shared 只导出了这几个的 schema，没有导出类型，这里从 schema 推回来。
type TaskStatus = z.infer<typeof TaskStatusSchema>;
type ToolConnectionStatus = z.infer<typeof ToolConnectionStatusSchema>;
type AccountLogin = z.infer<typeof AccountLoginSchema>;
type AccountTier = z.infer<typeof AccountTierSchema>;
type LoginFailure = z.infer<typeof LoginFailureSchema>;
type ActionKind = z.infer<typeof ActionKindSchema>;
type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;
type BotRole = z.infer<typeof BotRoleSchema>;
type BotRunState = z.infer<typeof BotRunStateSchema>;
type ComputerKind = z.infer<typeof ComputerKindSchema>;
type ContentPlanStatus = z.infer<typeof ContentPlanStatusSchema>;
type DraftStatus = z.infer<typeof DraftStatusSchema>;
type HandoffStatus = z.infer<typeof HandoffStatusSchema>;
type ModelPurpose = z.infer<typeof ModelPurposeSchema>;
type OnFailure = z.infer<typeof OnFailureSchema>;
type Platform = z.infer<typeof PlatformSchema>;
type PublishFailureReason = z.infer<typeof PublishFailureReasonSchema>;
type RoutineRunStatus = z.infer<typeof RoutineRunStatusSchema>;
type RoutineState = z.infer<typeof RoutineStateSchema>;
type RoutineBoundary = z.infer<typeof RoutineBoundarySchema>;

/**
 * 触发器在库里的样子：shared 的 `Trigger` 加上 cron 的 `lastFiredAt`。
 * 后者是调度器的游标，不出边界，`Routine.parse` 在 rows.ts 里把它剥掉。
 */
export type StoredTrigger =
  | { readonly kind: "cron"; readonly expr: string; readonly lastFiredAt: string | null }
  | { readonly kind: "webhook"; readonly token: string };

/** 牌桌一个座位在库里的样子：座位号、坐着的 Bot（4 号位是用户，为 null）、筹码。筹码跟座位走（D27）。 */
export type StoredPokerSeat = { readonly seat: PokerSeatNo; readonly botId: string | null; readonly stack: number };
export type PokerActResult = Extract<ControlToAgent, { type: "poker_result" }>["result"];
/** abandoned 是扫描器连续推进失败后作废的手：不结算，桌子回 idle，座位筹码退回 seats_start。 */
export type StoredPokerHandStatus = "playing" | "complete" | "abandoned";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: createdAt(),
});

// 每个用户一行，发号用。主题任务编号和队友色相都按用户递增，所以计数器挂在用户上。
export const userCounters = pgTable("user_counters", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  nextTaskNumber: integer("next_task_number").notNull().default(1001),
  nextHueIndex: integer("next_hue_index").notNull().default(0),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const settings = pgTable("settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  theme: text("theme").$type<"light" | "dark" | "system">().notNull().default("system"),
  notify: boolean("notify").notNull().default(true),
  dndFrom: text("dnd_from"),
  dndTo: text("dnd_to"),
  budget: integer("budget"),
  // 本月 80% 提醒发过的那个上海时区月份，形如 2026-10。一个月只发一次靠 WHERE 它不等于本月去抢。
  budgetAlertedMonth: text("budget_alerted_month"),
});

export const bots = pgTable(
  "bots",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<BotRole>().notNull().default("member"),
    runState: text("run_state").$type<BotRunState>().notNull().default("running"),
    name: text("name").notNull(),
    tags: text("tags").array().notNull().default([]),
    description: text("description").notNull().default(""),
    hue: text("hue").$type<BotHue>().notNull(),
    notify: boolean("notify").notNull().default(true),
    // 预置牌友和老白的人设 id。每个用户一套（D36），所以 (owner_id, preset) 唯一。
    preset: text("preset").$type<PokerPersona>(),
    createdAt: createdAt(),
  },
  (t) => [
    index("bots_owner_id_idx").on(t.ownerId),
    uniqueIndex("bots_owner_id_assistant_idx")
      .on(t.ownerId)
      .where(sql`${t.role} = 'assistant'`),
    uniqueIndex("bots_owner_id_preset_idx")
      .on(t.ownerId, t.preset)
      .where(sql`${t.preset} IS NOT NULL`),
  ],
);

export const toolConnections = pgTable(
  "tool_connections",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    authorizationEnc: text("authorization_enc"),
    operations: jsonb("operations").$type<ToolOperation[]>().notNull().default([]),
    status: text("status").$type<ToolConnectionStatus>().notNull().default("ready"),
    // 只在本机的连接，凭据只下发给本机电脑、由运行器直连；其余由控制面代执行。
    localOnly: boolean("local_only").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("tool_connections_owner_id_name_idx").on(t.ownerId, t.name)],
);

export const toolConnectionBots = pgTable(
  "tool_connection_bots",
  {
    toolConnectionId: text("tool_connection_id")
      .notNull()
      .references(() => toolConnections.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.toolConnectionId, t.botId] }), index("tool_connection_bots_bot_id_idx").on(t.botId)],
);

// solo_bot_id 是「建 Bot 时系统自动建的那个单 Bot 群」，非空即该群属于这个 Bot。
// 唯一约束保证一个 Bot 最多一个单 Bot 群，级联删除保证删 Bot 时群、任务、消息一起走。
export const groups = pgTable(
  "groups",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    soloBotId: text("solo_bot_id")
      .unique()
      .references(() => bots.id, { onDelete: "cascade" }),
    chiefBotId: text("chief_bot_id").references(() => bots.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("groups_owner_id_idx").on(t.ownerId)],
);

// 成员顺序是展示顺序，所以单列 position 而不是靠插入顺序。
export const groupMembers = pgTable(
  "group_members",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.botId] }), index("group_members_bot_id_idx").on(t.botId)],
);

export const attachments = pgTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    sha256: text("sha256").notNull(),
    mime: text("mime").$type<AttachmentMime>().notNull(),
    size: integer("size").notNull(),
    bytes: bytea("bytes").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("attachments_owner_bot_group_sha256_idx").on(t.ownerId, t.botId, t.groupId, t.sha256)],
);

// 清单项在库里多存一个勾选时刻，只供项目页数本周勾掉几项，toTask 不往外带。
// 和 checklist 一起整份替换，勾选时刻由控制面按文字从旧清单里接（repo/tasks.ts 的 stampedChecklist），不收外面给的。
export type StoredChecklistItem = ChecklistItem & { readonly doneAt: string | null };

// 群和主题任务一一对应。外键放在任务这边，群不存 taskId，避免两张表互相引用。
export const tasks = pgTable("tasks", {
  id: text("id").primaryKey(),
  groupId: text("group_id")
    .notNull()
    .unique()
    .references(() => groups.id, { onDelete: "cascade" }),
  number: text("number").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull().default(""),
  dueAt: timestamp("due_at", { withTimezone: true }),
  checklist: jsonb("checklist").$type<StoredChecklistItem[]>().notNull().default([]),
  currentBotId: text("current_bot_id").references(() => bots.id, { onDelete: "set null" }),
  handled: jsonb("handled").$type<{ botId: string; from: string; to: string | null }[]>().notNull().default([]),
  status: text("status").$type<TaskStatus>().notNull().default("active"),
  cadence: text("cadence").notNull().default(""),
  // 项目目标（D1、D2）拆成三列而不是一个 jsonb：目标数和截止要参与「本周该到哪」的算术，
  // 三列要么全空要么全有，由 UpdateTaskRequest.goal 整个替换。指标来源是闭合联合，jsonb 存。
  goalTarget: integer("goal_target"),
  goalUnit: text("goal_unit"),
  goalDueAt: timestamp("goal_due_at", { withTimezone: true }),
  metricSource: jsonb("metric_source").$type<MetricSource>(),
});

// 指标采样。每个项目群一条时间序列，source 记这次数是谁报的（github 轮询还是 Bot 的 report_metric）。
// 「本周涨了多少」是读的时候按 sampled_at 回看一周算的，不另存。
export const metricSamples = pgTable(
  "metric_samples",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    value: numeric("value").notNull(),
    source: text("source").notNull(),
    sampledAt: timestamp("sampled_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("metric_samples_group_id_sampled_at_idx").on(t.groupId, t.sampledAt)],
);

// 项目周复盘。一个群一周至多一篇，重跑撞唯一索引就是幂等；写它的 run 删了复盘留着。
export const projectReviews = pgTable(
  "project_reviews",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    weekStart: date("week_start").notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("project_reviews_group_id_week_start_idx").on(t.groupId, t.weekStart)],
);

// seq 是群内消息的唯一排序依据。created_at 在同一事务里会撞在一起，翻页不能靠它。
export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    body: jsonb("body").$type<MessageBody>().notNull(),
    // 只对 kind = 'skill_offer' 的行有意义。正文里没有 source 字段，而来源是上行那一刻按
    // 「这个 run 属不属于例行任务运行」判出来的，要等用户点存才写进 skill 行，中间没有别处能存它。
    // 不出边界，`toMessage` 不读它。
    skillOfferSource: text("skill_offer_source").$type<SkillSource>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    // 每条改这一行的 UPDATE 都在同一句里加一（nextRevision），不先读再写。
    revision: integer("revision").notNull().default(0),
    // 收件人名单，null 是全群可见。空数组在库这一级就禁掉，免得和 null 两种写法。
    visibleTo: jsonb("visible_to").$type<Viewer[]>(),
  },
  (t) => [
    index("messages_group_id_seq_idx").on(t.groupId, t.seq),
    check(
      "messages_visible_to_check",
      sql`${t.visibleTo} IS NULL OR (jsonb_typeof(${t.visibleTo}) = 'array' AND jsonb_array_length(${t.visibleTo}) > 0)`,
    ),
  ],
);

// 每个用户每种电脑至多一台。token 给电脑代理登录 /agent，gateway key 给模型网关认账，两把都是 32 字节随机数，
// 库里只存 sha256：明文只在生成的那一刻存在，比对时按哈希查，所以不能加盐。
export const computers = pgTable(
  "computers",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ComputerKind>().notNull(),
    status: text("status").$type<ComputerStatus>().notNull().default("creating"),
    tokenHash: text("token_hash").notNull(),
    gatewayKeyHash: text("gateway_key_hash").notNull(),
    upStream: text("up_stream"),
    upAcked: integer("up_acked").notNull().default(0),
    downSeq: integer("down_seq").notNull().default(0),
    downApplied: integer("down_applied").notNull().default(0),
    connGen: integer("conn_gen").notNull().default(0),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    installId: text("install_id"),
    host: text("host"),
    idleSince: timestamp("idle_since", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("computers_owner_id_kind_idx").on(t.ownerId, t.kind)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id, { onDelete: "restrict" }),
    platform: text("platform").$type<Platform>().notNull(),
    handle: text("handle"),
    tier: text("tier").$type<AccountTier>().notNull().default("confirm_publish"),
    login: text("login").$type<AccountLogin>().notNull().default("none"),
    loginChangedAt: timestamp("login_changed_at", { withTimezone: true }).notNull().defaultNow(),
    // 浏览器登录的会话是第几代：每次报上来登录成功都加一，valid 重登到 valid 也加。
    // 发布认领时抄一份到 drafts.claimed_login_generation，晚到的 login_expired 只在代次还一样时算数。
    loginGeneration: integer("login_generation").notNull().default(1),
    // 最近一次登录没成：原因和库时钟时刻成对出现，登上时一起清空。
    loginFailure: text("login_failure").$type<LoginFailure>(),
    loginFailedAt: timestamp("login_failed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("accounts_owner_id_idx").on(t.ownerId),
    uniqueIndex("accounts_computer_platform_handle_idx").on(t.computerId, t.platform, t.handle),
    uniqueIndex("accounts_owner_platform_none_idx")
      .on(t.ownerId, t.platform)
      .where(sql`${t.login} = 'none'`),
    check("accounts_xhs_tier_ck", sql`${t.platform} <> 'xiaohongshu' OR ${t.tier} <> 'direct_publish'`),
    check("accounts_handle_ck", sql`(${t.login} = 'none') = (${t.handle} IS NULL)`),
    check("accounts_login_failure_ck", sql`(${t.loginFailure} IS NULL) = (${t.loginFailedAt} IS NULL)`),
  ],
);

export const accountCredentials = pgTable("account_credentials", {
  accountId: text("account_id")
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  accessEnc: text("access_enc").notNull(),
  refreshEnc: text("refresh_enc"),
  accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
  refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }),
  scope: text("scope").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  // 每写一份新凭据（授权、刷新成功）加一。平台不认的结论只算在那一代头上，见 markLoginExpired。
  generation: integer("generation").notNull().default(1),
});

// 发起授权到平台跳回来之间的那一小段。state 防伪造，code_verifier 是 PKCE 的另一半，都只在控制面，
// 回调时按 state、人、平台一条 DELETE ... RETURNING 取走，同一个 state 只能用一次。
// 每次发起授权一行，回调时删掉。没回来的靠两条路收：过期的按 expires_at 清（索引给这条用），
// 同一个人同一个平台只留最新 5 条（见 createOAuthState），表的大小有上限。
export const oauthStates = pgTable(
  "oauth_states",
  {
    state: text("state").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    platform: text("platform").$type<OAuthPlatform>().notNull(),
    codeVerifier: text("code_verifier").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("oauth_states_expires_at_idx").on(table.expiresAt),
    // 发起授权时挤掉这个人这个平台最旧的 state：按 owner、platform 过滤，按过期时刻和 state 倒序取最新几条。
    index("oauth_states_owner_platform_idx").on(
      table.ownerId,
      table.platform,
      table.expiresAt.desc().nullsFirst(),
      table.state.desc().nullsFirst(),
    ),
  ],
);

// 例行任务属于一个 Bot，删 Bot 跟着走。触发器整份存 jsonb：列化的话每加一种触发器就要改一次表，
// 放 jsonb 里触发器的种类只由 shared 的 `Trigger` 定。
// GIN 索引是给 `POST /api/hooks/:token` 用的，那条路不登录，进来只有一个 token，不能全表扫 jsonb。
// token 的全局唯一没有交给数据库约束：它只由控制面的 `randomBytes(16)` 产生，客户端选不了，
// 撞车是 CSPRNG 的 2^-128，单开一张 webhook_tokens 表就要把同一条边存两遍，还得自己保证两边不走散。
export const routines = pgTable(
  "routines",
  {
    id: text("id").primaryKey(),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    instruction: text("instruction").notNull(),
    triggers: jsonb("triggers").$type<StoredTrigger[]>().notNull().default([]),
    onFailure: text("on_failure").$type<OnFailure>().notNull().default("stop_and_tell"),
    groupId: text("group_id").references(() => groups.id, { onDelete: "cascade" }),
    purpose: text("purpose").$type<ModelPurpose>().notNull().default("plan"),
    // 开关从布尔变三态：auto_paused 是连着失败后控制面自己停的，和用户手动 paused 要分开显示、分开恢复。
    state: text("state").$type<RoutineState>().notNull().default("on"),
    boundary: text("boundary").$type<RoutineBoundary>().notNull().default("draft"),
    onToday: boolean("on_today").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("routines_bot_id_idx").on(t.botId),
    index("routines_triggers_idx").using("gin", t.triggers),
    index("routines_group_id_idx").on(t.groupId),
  ],
);

// 一条运行记录。触发那一刻就落 running，收尾时改状态补 note，每个例行任务只留最近 20 条。
// 指向 runs 的那条边存在 runs 那一头（`runs.routine_run_id`），不在这里：见下面那张表的注释。
export const routineRuns = pgTable(
  "routine_runs",
  {
    id: text("id").primaryKey(),
    routineId: text("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    status: text("status").$type<RoutineRunStatus>().notNull().default("running"),
    note: text("note").notNull().default(""),
    // 用户看过这次运行的时刻。首页「例行结果」只列没看过的，POST /api/groups/:id/seen 批量盖章。
    seenAt: timestamp("seen_at", { withTimezone: true }),
  },
  (t) => [index("routine_runs_routine_id_started_at_idx").on(t.routineId, t.startedAt)],
);

// 规格里的用量记录。一次派活一行，ended_at 为空表示还在跑，run_done 靠「只更新 ended_at 为空的那行」做幂等。
// 用量是账：Bot、群、触发消息删了账还要留着，所以这三处归属可空，删的时候置空而不是跟着走。
export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
    botId: text("bot_id").references(() => bots.id, { onDelete: "set null" }),
    groupId: text("group_id").references(() => groups.id, { onDelete: "set null" }),
    computerId: text("computer_id").references(() => computers.id, { onDelete: "set null" }),
    triggerMessageId: text("trigger_message_id").references(() => messages.id, { onDelete: "set null" }),
    // 例行任务发起的活在这里认领。边存在这一头，run 行一生出来就带着它，
    // 上行的 run_done 拿到的就是它，中间没有「派完活再回填」的窗口能让收尾报文扑空。
    // 记录只留 20 条、删例行任务时跟着走，所以这一列置空而不是级联，账要留着。
    routineRunId: text("routine_run_id").references(() => routineRuns.id, { onDelete: "set null" }),
    isRoutine: boolean("is_routine").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    // 账结清的时刻：费用卡和例行记账在一个事务里落库并提交。run_done 先写 ended_at 结束行，结账提交才写这一列；
    // abandonRun 没有账要结，结束行的同一句就写上。ended_at 有值、这一列为空的行只有一种来历：
    // 上一次结账没提交，代理补发 run_done 撞上来时接着结，条件写 WHERE charged_at IS NULL 保证只结一次。
    chargedAt: timestamp("charged_at", { withTimezone: true }),
    steps: integer("steps").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    amount: numeric("amount", { precision: 14, scale: 6 }).notNull().default("0"),
    // 这次 prompt 的上下文里没定稿的行。下一次给同一个 Bot 派活，滑出窗口的这些行接着送，直到定稿那一轮。
    // 派活时就写上，但只有 contextConfirmedAt 有值才作数：没送到、没进会话、执行前被收尾的 run 里那条新定稿
    // 的结论模型没读到，名单却已经把它划掉了，下一次只能接着用更早那份确认过的名单。
    unsettledContext: jsonb("unsettled_context").$type<MessageId[]>(),
    // 运行器报这次触发进了会话（run_done 带 prompt: entered，旧运行器不带也算）的时刻。
    // null 是还没跑完、没送到、没进会话、被 abandon，或迁移前的 run。
    contextConfirmedAt: timestamp("context_confirmed_at", { withTimezone: true }),
    // 这次 prompt 的上下文里读到时已定稿的行。下一次派活的候选是最近几次确认过的 run 的 unsettled_context 并起来、
    // 再减掉任何一次确认过的 run 的这一列：定稿是终态，哪次读到过定稿的字，模型就已经看过结论。
    // 不在名单之间挑「最新的一份」：派活交错、交接延后时各 run 读到的消息集合互不包含，没有一份能盖住别的。
    // 迁移前的 run 是 null，当空。
    settledContext: jsonb("settled_context").$type<MessageId[]>(),
    // 牌桌 run 的产出只给这些人看；普通 run 为 null。
    visibleTo: jsonb("visible_to").$type<Viewer[]>(),
    // 这个 run 在牌桌上扮演什么，普通 run 为 null。上行报文按它放行（table-run-policy）。
    tableRole: text("table_role").$type<PokerTableRole>(),
  },
  (t) => [
    check("runs_table_role_check", sql`${t.tableRole} IS NULL OR ${t.tableRole} IN ('player', 'advisor', 'reviewer')`),
    // 每张桌同时至多一个没收尾的 advisor run 和一个 reviewer run。
    uniqueIndex("runs_table_role_open_idx")
      .on(t.groupId, t.tableRole)
      .where(sql`${t.tableRole} IN ('advisor', 'reviewer') AND ${t.endedAt} IS NULL`),
    // 同一个 Bot 在同一张桌同时至多一个没收尾的牌桌 run。
    uniqueIndex("runs_table_bot_open_idx")
      .on(t.botId, t.groupId)
      .where(sql`${t.tableRole} IS NOT NULL AND ${t.endedAt} IS NULL`),
    index("runs_group_id_started_at_idx").on(t.groupId, t.startedAt),
    // 每次派活取这个 Bot 在这个群最近确认的几份名单，按确认时刻倒着取前几条就停，不扫全群的 run。
    index("runs_context_confirmed_idx")
      .on(t.groupId, t.botId, t.contextConfirmedAt.desc().nullsFirst(), t.startedAt.desc().nullsFirst())
      .where(sql`${t.contextConfirmedAt} IS NOT NULL`),
    index("runs_bot_id_idx").on(t.botId),
    index("runs_owner_id_started_at_idx").on(t.ownerId, t.startedAt),
    index("runs_routine_run_id_idx").on(t.routineRunId),
    index("runs_computer_id_idx").on(t.computerId),
  ],
);

export const laneLeases = pgTable(
  "lane_leases",
  {
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    holderComputerId: text("holder_computer_id")
      .notNull()
      .references(() => computers.id, { onDelete: "cascade" }),
    holderInstallId: text("holder_install_id").notNull(),
    epoch: integer("epoch").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.botId, t.groupId] }), check("lane_leases_epoch_check", sql`${t.epoch} > 0`)],
);

export const workStreams = pgTable(
  "work_streams",
  {
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    stream: text("stream").$type<"chat" | "table">().notNull(),
    nextSeq: integer("next_seq").notNull().default(0),
    head: text("head").notNull().default("0".repeat(64)),
    tailEntryId: text("tail_entry_id"),
    retainSnapshot: jsonb("retain_snapshot").$type<RetainSnapshot>(),
    piSessionVersion: integer("pi_session_version").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.botId, t.groupId, t.stream] }),
    check("work_streams_stream_check", sql`${t.stream} IN ('chat', 'table')`),
    check("work_streams_next_seq_check", sql`${t.nextSeq} >= 0`),
  ],
);

export const workEntries = pgTable(
  "work_entries",
  {
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    stream: text("stream").$type<"chat" | "table">().notNull(),
    seq: integer("seq").notNull(),
    epoch: integer("epoch").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    entryId: text("entry_id").notNull(),
    parentId: text("parent_id"),
    piType: text("pi_type").notNull(),
    retention: text("retention").$type<"verbatim" | "redacted">().notNull(),
    line: text("line").notNull(),
    searchText: text("search_text").notNull(),
    visibleTo: jsonb("visible_to").$type<Viewer[]>(),
  },
  (t) => [
    primaryKey({ columns: [t.botId, t.groupId, t.stream, t.seq] }),
    check("work_entries_stream_check", sql`${t.stream} IN ('chat', 'table')`),
    check("work_entries_retention_check", sql`${t.retention} IN ('verbatim', 'redacted')`),
    check("work_entries_seq_check", sql`${t.seq} >= 0`),
    check(
      "work_entries_visible_to_check",
      sql`${t.visibleTo} IS NULL OR (jsonb_typeof(${t.visibleTo}) = 'array' AND jsonb_array_length(${t.visibleTo}) > 0)`,
    ),
  ],
);

export const grants = pgTable(
  "grants",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    action: text("action").$type<ActionKind>().notNull(),
    target: jsonb("target").$type<GrantTarget>().notNull(),
    scope: text("scope").$type<"project" | "forever">().notNull(),
    groupId: text("group_id").references(() => groups.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("grants_owner_action_target_group_uq").on(t.ownerId, t.action, t.target, t.groupId).nullsNotDistinct(),
    check(
      "grants_scope_group_ck",
      sql`(${t.scope} = 'project' AND ${t.groupId} IS NOT NULL) OR (${t.scope} = 'forever' AND ${t.groupId} IS NULL)`,
    ),
    check("grants_action_ck", sql`${t.action} NOT IN ('spend', 'account_security', 'delete')`),
    check("grants_forever_ck", sql`${t.scope} <> 'forever' OR ${t.action} <> 'write_outside'`),
    index("grants_owner_id_idx").on(t.ownerId),
  ],
);

// 一条等归属人点头的审批。message_id 指向群里那张卡，非空：卡和审批一起生，群里不会出现没有审批的卡。
// (run_id, call_id) 唯一，电脑重发同一条 approval_request 时不多出第二张卡。
// reminded_at 记下 24 小时提醒发过了，没有它每扫一次就重发一遍，跨进程重启也挡不住。
export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    callId: text("call_id").notNull(),
    tool: text("tool").notNull(),
    action: text("action").$type<ActionKind>().notNull(),
    target: jsonb("target").$type<GrantTarget>(),
    view: jsonb("view").$type<ToolView>().notNull(),
    status: text("status").$type<ApprovalStatus>().notNull().default("pending"),
    grantId: text("grant_id").references(() => grants.id, { onDelete: "set null" }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    // 例行和交接触发的审批到这个时刻还没人批就按拒绝处理，用户当面发起的为空、不按时间过期。
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
  },
  (t) => [
    index("approvals_group_id_status_idx").on(t.groupId, t.status),
    uniqueIndex("approvals_run_id_call_id_idx").on(t.runId, t.callId),
    index("approvals_status_deadline_at_idx").on(t.status, t.deadlineAt),
  ],
);

export const contentPlans = pgTable(
  "content_plans",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    botId: text("bot_id").references(() => bots.id, { onDelete: "set null" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    status: text("status").$type<ContentPlanStatus>().notNull().default("pending"),
    createdAt: createdAt(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [index("content_plans_owner_id_status_idx").on(t.ownerId, t.status)],
);

export const drafts = pgTable(
  "drafts",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    botId: text("bot_id").references(() => bots.id, { onDelete: "set null" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    planId: text("plan_id").references(() => contentPlans.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    platform: text("platform").$type<Platform>().notNull(),
    content: jsonb("content").$type<DraftContent>().notNull(),
    contentHash: text("content_hash").notNull(),
    approvedHash: text("approved_hash"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    status: text("status").$type<DraftStatus>().notNull().default("pending"),
    edits: jsonb("edits").$type<DraftEdit[]>().notNull().default([]),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    // 认领那一刻账号的登录会话代次。这列加上之前认领的旧行是 null，结算时退回「账号仍是第 1 代，
    // 且 login_changed_at 不晚于 claimed_at」才记过期。
    claimedLoginGeneration: integer("claimed_login_generation"),
    failure: text("failure").$type<PublishFailureReason>(),
    createdAt: createdAt(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [
    index("drafts_status_scheduled_at_idx").on(t.status, t.scheduledAt),
    index("drafts_owner_id_status_idx").on(t.ownerId, t.status),
    index("drafts_plan_id_idx").on(t.planId),
  ],
);

export const publications = pgTable(
  "publications",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    draftId: text("draft_id")
      .unique()
      .references(() => drafts.id, { onDelete: "set null" }),
    groupId: text("group_id").references(() => groups.id, { onDelete: "set null" }),
    accountId: text("account_id").references(() => accounts.id, { onDelete: "set null" }),
    platform: text("platform").$type<Platform>().notNull(),
    url: text("url").notNull(),
    externalId: text("external_id"),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("publications_group_id_published_at_idx").on(t.groupId, t.publishedAt)],
);

// 一份等目标 Bot 确认的交接报文。和审批同一种形状：message_id 指向群里那张卡，非空，卡和报文一起生；
// reminded_at 记下 24 小时提醒发过了。accepted_at 是接手时刻，经手记录里新那一条的 from 就是它。
// 没有 (run_id, call_id) 那样的唯一键：交接由 Bot 主动发起，同一个 Bot 交两次就是两份报文。
export const handoffs = pgTable(
  "handoffs",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    fromBotId: text("from_bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    toBotId: text("to_bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    done: text("done").notNull(),
    notDone: text("not_done").notNull(),
    next: text("next").notNull(),
    checklistIndex: integer("checklist_index"),
    status: text("status").$type<HandoffStatus>().notNull().default("pending"),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
  },
  (t) => [index("handoffs_group_id_status_idx").on(t.groupId, t.status)],
);

// Bot 会做的一件活，属于一个 Bot，删 Bot 跟着走。步骤整份存 jsonb：它就是一份有序的文本，
// 列化或单开一张步骤表都只是把同一份东西拆开再拼回来。
//
// 唯一索引 `(bot_id, name)` 是「同一 Bot 下名字不重复」的唯一真相源。建、改名、复制、点存四条路
// 都靠插入撞它来判 409，不先查后写：先查后写挡不住并发的两个同名请求，两边都查到没有，两边都插进去。
// 重名必须在库这一级挡死，因为 Pi 按 name 去重，同名的第二条根本不会进系统提示，
// 库里留着它只会让用户看见一条永远跑不起来的活。
// 没有单开 `skills_bot_id_idx`：这个唯一索引的前缀已经覆盖按 bot_id 的查询。
export const skills = pgTable(
  "skills",
  {
    id: text("id").primaryKey(),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    source: text("source").$type<SkillSource>().notNull(),
    steps: jsonb("steps").$type<string[]>().notNull().default([]),
    useCount: integer("use_count").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("skills_bot_id_name_idx").on(t.botId, t.name)],
);

// Bot 记住的用户偏好（D8）。一条一句话，来源消息删了偏好留着；private 只管分享时默认不勾，照样随 config 下发。
export const botPreferences = pgTable(
  "bot_preferences",
  {
    id: text("id").primaryKey(),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    sourceMessageId: text("source_message_id").references(() => messages.id, { onDelete: "set null" }),
    private: boolean("private").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("bot_preferences_bot_id_idx").on(t.botId)],
);

// 品牌手册（D9）。一个用户一本，主键就是 owner_id；version 每次 PUT 加一，运行器据此判断要不要重拼系统提示。
export const brandBooks = pgTable("brand_books", {
  ownerId: text("owner_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  facts: text("facts").notNull().default(""),
  voice: text("voice").notNull().default(""),
  taboo: text("taboo").notNull().default(""),
  assetsDir: text("assets_dir"),
  edits: jsonb("edits").$type<BrandEdit[]>().notNull().default([]),
  version: integer("version").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// 牌桌。一个群就是一张桌，主键就是 group_id。request_id 是建桌请求的幂等键，重发撞唯一索引就回原来那张。
// version 每次桌面有变化加一，poker_table_updated 带它，客户端只认更大的。
export const pokerTables = pgTable(
  "poker_tables",
  {
    groupId: text("group_id")
      .primaryKey()
      .references(() => groups.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    seats: jsonb("seats").$type<StoredPokerSeat[]>().notNull(),
    buttonSeat: integer("button_seat").$type<PokerSeatNo>().notNull(),
    smallBlind: integer("small_blind").notNull(),
    bigBlind: integer("big_blind").notNull(),
    startingStack: integer("starting_stack").notNull(),
    handCount: integer("hand_count").notNull().default(0),
    status: text("status").$type<PokerTableStatus>().notNull().default("idle"),
    version: integer("version").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("poker_tables_owner_id_request_id_idx").on(t.ownerId, t.requestId),
    check("poker_tables_status_check", sql`${t.status} IN ('idle', 'in_hand')`),
  ],
);

// 一场牌：从坐下到「散场看复盘」。ended_at 为空是还没散的那场，一张桌同时只有一场（D33）。复盘写在 review。
export const pokerSessions = pgTable(
  "poker_sessions",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => pokerTables.groupId, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    review: jsonb("review").$type<PokerReview>(),
  },
  (t) => [
    index("poker_sessions_group_id_idx").on(t.groupId),
    uniqueIndex("poker_sessions_group_id_open_idx")
      .on(t.groupId)
      .where(sql`${t.endedAt} IS NULL`),
  ],
);

// 一手牌。seed 加 seats_start、button_seat、blinds 和 poker_events 就能 replay 出整手，所以牌面本身不存。
// seed 永远不出控制面的响应、prompt 和日志。turn_* 是当前轮到的座位和催它的 run（D23 兜底靠 turn_deadline）。
export const pokerHands = pgTable(
  "poker_hands",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => pokerTables.groupId, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => pokerSessions.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    seed: text("seed").notNull(),
    seatsStart: jsonb("seats_start").$type<StoredPokerSeat[]>().notNull(),
    buttonSeat: integer("button_seat").$type<PokerSeatNo>().notNull(),
    blinds: jsonb("blinds").$type<PokerBlinds>().notNull(),
    status: text("status").$type<StoredPokerHandStatus>().notNull().default("playing"),
    turnSeat: integer("turn_seat").$type<PokerSeatNo>(),
    turnRunId: text("turn_run_id").references(() => runs.id, { onDelete: "set null" }),
    turnAttempts: integer("turn_attempts").notNull().default(0),
    turnDeadline: timestamp("turn_deadline", { withTimezone: true }),
    // 当前决策点（事件数为 dispatch_seq）已发出几次牌友 run，首派加重派。换了决策点 seq 对不上就当 0，不用清。
    dispatchSeq: integer("dispatch_seq"),
    dispatchCount: integer("dispatch_count").notNull().default(0),
    version: integer("version").notNull().default(0),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("poker_hands_group_id_number_idx").on(t.groupId, t.number),
    uniqueIndex("poker_hands_group_id_playing_idx")
      .on(t.groupId)
      .where(sql`${t.status} = 'playing'`),
    index("poker_hands_session_id_idx").on(t.sessionId),
    check("poker_hands_status_check", sql`${t.status} IN ('playing', 'complete', 'abandoned')`),
    check("poker_hands_dispatch_check", sql`(${t.dispatchSeq} IS NULL) = (${t.dispatchCount} = 0)`),
  ],
);

// 一手牌的事件日志，seq 从 0 起连续。主键 (hand_id, seq) 就是幂等：同一个决策点写第二次撞主键。
export const pokerEvents = pgTable(
  "poker_events",
  {
    handId: text("hand_id")
      .notNull()
      .references(() => pokerHands.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    event: jsonb("event").$type<PokerEvent>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.handId, t.seq] })],
);

// 「问老白」：每个决策点一次（D31），主键 (hand_id, seq) 保证重复点返回同一条。message_id 是老白答出来那条。
export const pokerHints = pgTable(
  "poker_hints",
  {
    handId: text("hand_id")
      .notNull()
      .references(() => pokerHands.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.handId, t.seq] }), index("poker_hints_run_id_idx").on(t.runId)],
);

// 牌友 poker_act 的回执。主键 (run_id, call_id) 就是幂等：重复的帧撞主键，读回已存的 result 原样回。
// result 为空只在认领它的那个事务里出现，和动作同事务提交，提交后恒非空。
export const pokerActReceipts = pgTable(
  "poker_act_receipts",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    callId: text("call_id").notNull(),
    result: jsonb("result").$type<PokerActResult>(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.callId] })],
);

export const agentOutbox = pgTable(
  "agent_outbox",
  {
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    body: jsonb("body").$type<ControlToAgent>().notNull(),
    runId: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.computerId, t.seq] }), index("agent_outbox_run_id_idx").on(t.runId)],
);
