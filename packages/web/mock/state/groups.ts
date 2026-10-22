import { Bot, BotId, BotShape, Group, GroupId, TaskId, TopicTask, type ChecklistItem } from "@baize/shared";
import {
  HUES,
  bots,
  checkedAt,
  groupIdByBotId,
  groups,
  messagesByGroupId,
  nextSuffix,
  nextTaskNumber,
  tasks,
  user,
} from "./store.js";
import { metricOf } from "./project-page.js";

export const createBot = (input: {
  name?: string | undefined;
  tags?: string[] | undefined;
  description?: string | undefined;
  hue?: (typeof HUES)[number] | undefined;
  shape?: (typeof BotShape.options)[number] | undefined;
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
    tags: input.tags ?? [],
    description: input.description ?? "",
    hue: input.hue ?? HUES[bots.size % HUES.length] ?? "sky",
    shape: input.shape ?? BotShape.options[bots.size % BotShape.options.length] ?? "pillow",
    notify: true,
    toolConnectionIds: [],
    createdAt: new Date().toISOString(),
  });
  const group = Group.parse({
    id: groupId,
    ownerId: user.id,
    kind: "solo",
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
  chiefBotId?: BotId | null;
  cadence?: string;
  checklist?: ChecklistItem[];
}) => {
  const suffix = nextSuffix();
  const groupId = GroupId.parse(`grp_new_${suffix}`);
  const taskId = TaskId.parse(`tsk_new_${suffix}`);
  const group = Group.parse({
    id: groupId,
    ownerId: user.id,
    kind: "team",
    botIds: input.botIds,
    taskId,
    chiefBotId: input.chiefBotId ?? null,
    createdAt: new Date().toISOString(),
  });
  const task = TopicTask.parse({
    id: taskId,
    groupId,
    number: nextTaskNumber(),
    title: input.title,
    summary: input.summary ?? "",
    dueAt: input.dueAt ?? null,
    checklist: input.checklist ?? [],
    currentBotId: null,
    handled: [],
    status: "active",
    cadence: input.cadence ?? "",
    goal: null,
    metricSource: null,
    metric: null,
  });
  groups.set(group.id, group);
  tasks.set(task.id, task);
  messagesByGroupId.set(group.id, []);
  return { group, task };
};

export const writeTask = (id: string, patch: Partial<Record<keyof TopicTask, unknown>>): TopicTask | null => {
  const task = tasks.get(id);
  if (task === undefined) return null;
  // 指标照控制面 withMetric 每次现算，存着的那份过了周界就旧了。
  const next = TopicTask.parse({ ...task, ...patch, metric: metricOf(task.groupId, new Date()) });
  tasks.set(next.id, next);
  if (patch.checklist !== undefined) {
    const previous = checkedAt.get(next.id) ?? new Map<string, string>();
    const wasDone = new Set(task.checklist.filter((item) => item.done).map((item) => item.text));
    const now = new Date().toISOString();
    checkedAt.set(
      next.id,
      new Map(
        next.checklist.flatMap((item): [string, string][] => {
          if (!item.done) return [];
          if (!wasDone.has(item.text)) return [[item.text, now]];
          const kept = previous.get(item.text);
          return kept === undefined ? [] : [[item.text, kept]];
        }),
      ),
    );
  }
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

// 和控制面 routing.ts 的 routeTargets 同一个口径：@ 的、首席、经手依次往下找，都没有就全员轮流答。
export const respondersOf = (groupId: string, mentions: BotId[]): BotId[] => {
  const group = groups.get(groupId);
  if (group === undefined) return [];
  if (group.kind === "solo") return [group.botIds[0]];
  // 删掉的 Bot 不从群名单里摘，这里只认还在的，删空了就没人接。
  const members = group.botIds.filter((botId) => bots.has(botId));
  const present = (botId: BotId | null | undefined): botId is BotId =>
    botId !== null && botId !== undefined && members.includes(botId);
  const first = mentions.find(present) ?? [group.chiefBotId, tasks.get(group.taskId)?.currentBotId].find(present);
  if (first !== undefined) return [first];
  // @ 的人都删了只退回首席或经手，不替用户扩到全员。
  return mentions.length > 0 ? [] : members;
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
