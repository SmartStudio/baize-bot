import { Bot, BotId, Group, GroupId, TaskId, TopicTask, type ChecklistItem } from "@baize/shared";
import {
  HUES,
  bots,
  groupIdByBotId,
  groups,
  messagesByGroupId,
  nextSuffix,
  nextTaskNumber,
  tasks,
  user,
} from "./store.js";

export const createBot = (input: {
  name?: string | undefined;
  tag?: string | undefined;
  description?: string | undefined;
  hue?: (typeof HUES)[number] | undefined;
}) => {
  const suffix = nextSuffix();
  const botId = BotId.parse(`bot_new_${suffix}`);
  const groupId = GroupId.parse(`grp_new_${suffix}`);
  const bot = Bot.parse({
    id: botId,
    ownerId: user.id,
    role: "member",
    runState: "running",
    name: input.name ?? `新 Bot ${bots.size + 1}`,
    tag: input.tag ?? "",
    description: input.description ?? "",
    hue: input.hue ?? HUES[bots.size % HUES.length] ?? "sky",
    notify: true,
    toolConnectionIds: [],
    createdAt: new Date().toISOString(),
  });
  const group = Group.parse({
    id: groupId,
    ownerId: user.id,
    botIds: [botId],
    taskId: TaskId.parse(`tsk_new_${suffix}`),
    chiefBotId: null,
    createdAt: bot.createdAt,
  });
  bots.set(bot.id, bot);
  groups.set(group.id, group);
  groupIdByBotId.set(bot.id, group.id);
  messagesByGroupId.set(group.id, []);
  return { bot, group };
};

export const createGroup = (input: {
  title: string;
  botIds: BotId[];
  summary?: string | undefined;
  dueAt?: string | null | undefined;
}) => {
  const suffix = nextSuffix();
  const groupId = GroupId.parse(`grp_new_${suffix}`);
  const taskId = TaskId.parse(`tsk_new_${suffix}`);
  const group = Group.parse({
    id: groupId,
    ownerId: user.id,
    botIds: input.botIds,
    taskId,
    chiefBotId: null,
    createdAt: new Date().toISOString(),
  });
  const task = TopicTask.parse({
    id: taskId,
    groupId,
    number: nextTaskNumber(),
    title: input.title,
    summary: input.summary ?? "",
    dueAt: input.dueAt ?? null,
    checklist: [],
    currentBotId: null,
    handled: [],
    status: "active",
    cadence: "",
  });
  groups.set(group.id, group);
  tasks.set(task.id, task);
  messagesByGroupId.set(group.id, []);
  return { group, task };
};

export const writeTask = (id: string, patch: Partial<Record<keyof TopicTask, unknown>>): TopicTask | null => {
  const task = tasks.get(id);
  if (task === undefined) return null;
  const next = TopicTask.parse({ ...task, ...patch });
  tasks.set(next.id, next);
  return next;
};

export const mentionsIn = (groupId: string, text: string): BotId[] => {
  const group = groups.get(groupId);
  if (group === undefined) return [];
  return group.botIds.filter((botId) => {
    const name = bots.get(botId)?.name;
    return name !== undefined && text.includes(`@${name}`);
  });
};

export const responderOf = (groupId: string, mentions: BotId[]): BotId | null => {
  const group = groups.get(groupId);
  if (group === undefined) return null;
  if (group.botIds.length === 1) return group.botIds[0] ?? null;
  return mentions[0] ?? tasks.get(group.taskId)?.currentBotId ?? null;
};

export const assignTask = (groupId: string, botId: BotId): TopicTask | null => {
  const taskId = groups.get(groupId)?.taskId;
  const task = taskId === undefined ? undefined : tasks.get(taskId);
  if (task === undefined || task.currentBotId === botId) return null;
  const now = new Date().toISOString();
  const handled = task.handled.map((record) => (record.to === null ? { ...record, to: now } : record));
  return writeTask(task.id, { currentBotId: botId, handled: [...handled, { botId, from: now, to: null }] });
};

export const tickFirstUndone = (groupId: string, botId: BotId): TopicTask | null => {
  const taskId = groups.get(groupId)?.taskId;
  const task = taskId === undefined ? undefined : tasks.get(taskId);
  if (task === undefined) return null;
  const at = task.checklist.findIndex((item) => !item.done);
  if (at < 0) return null;
  const checklist: ChecklistItem[] = task.checklist.map((item, index) =>
    index === at ? { ...item, done: true, ownerBotId: botId } : item,
  );
  return writeTask(task.id, { checklist });
};
