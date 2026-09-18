import type { BotHue, ChecklistItem, MessageBody, TaskStatus as TaskStatusSchema } from "@baize/shared";
import type { z } from "zod";
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// shared 只导出了 TaskStatus 的 schema，没有导出类型，这里从 schema 推回来。
type TaskStatus = z.infer<typeof TaskStatusSchema>;

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
