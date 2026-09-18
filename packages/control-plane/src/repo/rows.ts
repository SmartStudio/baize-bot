import { Bot, Group, Message, Settings, User } from "@baize/shared";
import type * as schema from "../db/schema.js";

// 数据库行是外部输入。品牌化 ID 和字面量联合只在这里产生，往上全是可信的领域类型。

export function toUser(row: typeof schema.users.$inferSelect): User {
  return User.parse({
    id: row.id,
    name: row.name,
    email: row.email,
    teamName: row.teamName,
    createdAt: row.createdAt.toISOString(),
  });
}

export function toBot(row: typeof schema.bots.$inferSelect): Bot {
  return Bot.parse({
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    tag: row.tag,
    description: row.description,
    hue: row.hue,
    notify: row.notify,
    // 工具连接是 M6 的对象，这一版没有表，任何 Bot 都还没分配工具。
    toolConnectionIds: [],
    createdAt: row.createdAt.toISOString(),
  });
}

export function toGroup(
  row: typeof schema.groups.$inferSelect,
  botIds: readonly string[],
  taskId: string,
): Group {
  return Group.parse({
    id: row.id,
    ownerId: row.ownerId,
    botIds,
    taskId,
    createdAt: row.createdAt.toISOString(),
  });
}


export function toMessage(row: typeof schema.messages.$inferSelect): Message {
  return Message.parse({
    id: row.id,
    groupId: row.groupId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  });
}

export function toSettings(row: typeof schema.settings.$inferSelect): Settings {
  return Settings.parse({
    theme: row.theme,
    notify: row.notify,
    dndFrom: row.dndFrom,
    dndTo: row.dndTo,
  });
}
