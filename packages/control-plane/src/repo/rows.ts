import {
  Approval,
  Bot,
  Computer,
  Group,
  Handoff,
  Message,
  Routine,
  Settings,
  Skill,
  TopicTask,
  UsageRecord,
  User,
} from "@baize/shared";
import type * as schema from "../db/schema.js";

// 数据库行是外部输入。品牌化 ID 和字面量联合只在这里产生，往上全是可信的领域类型。

export function toUser(row: typeof schema.users.$inferSelect): User {
  return User.parse({
    id: row.id,
    name: row.name,
    email: row.email,
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

export function toGroup(row: typeof schema.groups.$inferSelect, botIds: readonly string[], taskId: string): Group {
  return Group.parse({
    id: row.id,
    ownerId: row.ownerId,
    botIds,
    taskId,
    chiefBotId: row.chiefBotId,
    createdAt: row.createdAt.toISOString(),
  });
}

export function toTask(row: typeof schema.tasks.$inferSelect): TopicTask {
  return TopicTask.parse({
    id: row.id,
    groupId: row.groupId,
    number: row.number,
    title: row.title,
    summary: row.summary,
    dueAt: row.dueAt?.toISOString() ?? null,
    checklist: row.checklist,
    currentBotId: row.currentBotId,
    handled: row.handled,
    status: row.status,
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

// tool、callId、messageId 不出边界：domain.ts 的 Approval 只有客户端画卡要用的那几个字段。
export function toApproval(row: typeof schema.approvals.$inferSelect): Approval {
  return Approval.parse({
    id: row.id,
    groupId: row.groupId,
    botId: row.botId,
    runId: row.runId,
    kind: row.kind,
    summary: row.summary,
    status: row.status,
    decidedAt: row.decidedAt?.toISOString() ?? null,
  });
}

// messageId 不出边界，和 Approval 一样：domain.ts 的 Handoff 只有客户端画那张卡要用的字段。
export function toHandoff(row: typeof schema.handoffs.$inferSelect): Handoff {
  return Handoff.parse({
    id: row.id,
    groupId: row.groupId,
    fromBotId: row.fromBotId,
    toBotId: row.toBotId,
    done: row.done,
    notDone: row.notDone,
    next: row.next,
    checklistIndex: row.checklistIndex,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
  });
}

/**
 * 例行任务带最近 20 条运行记录，新的在前。
 * 触发器里 cron 的 `lastFiredAt` 是调度器的游标，`Trigger` 里没有这个字段，`Routine.parse` 顺手把它剥掉。
 */
export function toRoutine(
  row: typeof schema.routines.$inferSelect,
  runs: readonly (typeof schema.routineRuns.$inferSelect)[],
): Routine {
  return Routine.parse({
    id: row.id,
    botId: row.botId,
    name: row.name,
    instruction: row.instruction,
    triggers: row.triggers,
    onFailure: row.onFailure,
    enabled: row.enabled,
    runs: runs.map((run) => ({
      startedAt: run.startedAt.toISOString(),
      status: run.status,
      note: run.note,
    })),
  });
}

export function toSkill(row: typeof schema.skills.$inferSelect): Skill {
  return Skill.parse({
    id: row.id,
    botId: row.botId,
    name: row.name,
    source: row.source,
    steps: row.steps,
    useCount: row.useCount,
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

export function toComputer(row: typeof schema.computers.$inferSelect): Computer {
  return Computer.parse({
    id: row.id,
    ownerId: row.ownerId,
    status: row.status,
    host: row.host,
    idleSince: row.idleSince?.toISOString() ?? null,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
  });
}

export function toUsageRecord(row: typeof schema.runs.$inferSelect): UsageRecord {
  if (row.endedAt === null) throw new Error(`run ${row.id} 还没结束，构不成用量记录`);
  return UsageRecord.parse({
    runId: row.id,
    botId: row.botId,
    groupId: row.groupId,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt.toISOString(),
    steps: row.steps,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    // numeric 在 postgres.js 里是字符串，精度留在库里，出边界时才变成 number。
    amount: Number(row.amount),
  });
}
