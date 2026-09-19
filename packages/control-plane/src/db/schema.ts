import type {
  ApprovalKind as ApprovalKindSchema,
  ApprovalStatus as ApprovalStatusSchema,
  BotHue,
  ChecklistItem,
  ComputerStatus,
  HandoffStatus as HandoffStatusSchema,
  MessageBody,
  OnFailure as OnFailureSchema,
  RoutineRunStatus as RoutineRunStatusSchema,
  SkillSource,
  ToolOperation,
  TaskStatus as TaskStatusSchema,
} from "@baize/shared";
import type { z } from "zod";
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// shared 只导出了这几个的 schema，没有导出类型，这里从 schema 推回来。
type TaskStatus = z.infer<typeof TaskStatusSchema>;
type ApprovalKind = z.infer<typeof ApprovalKindSchema>;
type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;
type HandoffStatus = z.infer<typeof HandoffStatusSchema>;
type OnFailure = z.infer<typeof OnFailureSchema>;
type RoutineRunStatus = z.infer<typeof RoutineRunStatusSchema>;

/**
 * 触发器在库里的样子：shared 的 `Trigger` 加上 cron 的 `lastFiredAt`。
 * 后者是调度器的游标，不出边界，`Routine.parse` 在 rows.ts 里把它剥掉。
 */
export type StoredTrigger =
  | { readonly kind: "cron"; readonly expr: string; readonly lastFiredAt: string | null }
  | { readonly kind: "webhook"; readonly token: string };

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  teamName: text("team_name").notNull().default(""),
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
});

export const bots = pgTable(
  "bots",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tag: text("tag").notNull().default(""),
    description: text("description").notNull().default(""),
    hue: text("hue").$type<BotHue>().notNull(),
    notify: boolean("notify").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("bots_owner_id_idx").on(t.ownerId)],
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
  checklist: jsonb("checklist").$type<ChecklistItem[]>().notNull().default([]),
  currentBotId: text("current_bot_id").references(() => bots.id, { onDelete: "set null" }),
  handled: jsonb("handled").$type<{ botId: string; from: string; to: string | null }[]>().notNull().default([]),
  status: text("status").$type<TaskStatus>().notNull().default("active"),
});

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
  },
  (t) => [index("messages_group_id_seq_idx").on(t.groupId, t.seq)],
);

// 每个用户一台。token 给电脑代理登录 /agent，gateway key 给模型网关认账，两把都是 32 字节随机数，
// 库里只存 sha256：明文只在生成的那一刻存在，比对时按哈希查，所以不能加盐。
export const computers = pgTable("computers", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  status: text("status").$type<ComputerStatus>().notNull().default("creating"),
  tokenHash: text("token_hash").notNull(),
  gatewayKeyHash: text("gateway_key_hash").notNull(),
  host: text("host"),
  idleSince: timestamp("idle_since", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: createdAt(),
});

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
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("routines_bot_id_idx").on(t.botId), index("routines_triggers_idx").using("gin", t.triggers)],
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
    triggerMessageId: text("trigger_message_id").references(() => messages.id, { onDelete: "set null" }),
    // 例行任务发起的活在这里认领。边存在这一头，run 行一生出来就带着它，
    // 上行的 run_done 拿到的就是它，中间没有「派完活再回填」的窗口能让收尾报文扑空。
    // 记录只留 20 条、删例行任务时跟着走，所以这一列置空而不是级联，账要留着。
    routineRunId: text("routine_run_id").references(() => routineRuns.id, { onDelete: "set null" }),
    isRoutine: boolean("is_routine").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    steps: integer("steps").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    amount: numeric("amount", { precision: 14, scale: 6 }).notNull().default("0"),
  },
  (t) => [
    index("runs_group_id_started_at_idx").on(t.groupId, t.startedAt),
    index("runs_bot_id_idx").on(t.botId),
    index("runs_owner_id_started_at_idx").on(t.ownerId, t.startedAt),
    index("runs_routine_run_id_idx").on(t.routineRunId),
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
    kind: text("kind").$type<ApprovalKind>().notNull(),
    summary: text("summary").notNull(),
    status: text("status").$type<ApprovalStatus>().notNull().default("pending"),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
  },
  (t) => [
    index("approvals_group_id_status_idx").on(t.groupId, t.status),
    uniqueIndex("approvals_run_id_call_id_idx").on(t.runId, t.callId),
  ],
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
