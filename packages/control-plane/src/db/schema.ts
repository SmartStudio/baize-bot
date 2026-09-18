import type {
  ApprovalKind as ApprovalKindSchema,
  ApprovalStatus as ApprovalStatusSchema,
  BotHue,
  ChecklistItem,
  ComputerStatus,
  HandoffStatus as HandoffStatusSchema,
  MessageBody,
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

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  teamName: text("team_name").notNull().default(""),
  passwordHash: text("password_hash").notNull(),
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

// 规格里的用量记录。一次派活一行，ended_at 为空表示还在跑，run_done 靠「只更新 ended_at 为空的那行」做幂等。
// 用量是账：Bot、群、触发消息删了账还要留着，所以这三处归属可空，删的时候置空而不是跟着走。
export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    botId: text("bot_id").references(() => bots.id, { onDelete: "set null" }),
    groupId: text("group_id").references(() => groups.id, { onDelete: "set null" }),
    triggerMessageId: text("trigger_message_id").references(() => messages.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    steps: integer("steps").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    amount: numeric("amount", { precision: 14, scale: 6 }).notNull().default("0"),
  },
  (t) => [index("runs_group_id_started_at_idx").on(t.groupId, t.startedAt), index("runs_bot_id_idx").on(t.botId)],
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
