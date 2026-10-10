import {
  Bot,
  BotId,
  Group,
  GroupId,
  Message,
  TeamOfferMember,
  type DecideTeamOfferRequest,
  type TodayPendingItem,
  type TopicTask,
} from "@baize/shared";
import { createBot, createGroup } from "./groups.js";
import { appendMessage, findMessage, writeMessageBody } from "./messages.js";
import { bots, groupIdByBotId, groups, messagesByGroupId } from "./store.js";

const GROUP_MAX = 6;
const NAME_MAX = 20;

const assistantChatOf = (): GroupId => {
  const groupId = groupIdByBotId.get("bot_assistant");
  if (groupId === undefined) throw new Error("mock 里没有主助理的单聊，先别删它");
  return GroupId.parse(groupId);
};

/** 主助理在自己的单聊里发一张建队卡，目标是刚建出来的项目群：已有的小服直接提，校对和配图是新请的建议人选。 */
export const seedTeamOffer = (): { message: Message; group: Group; task: TopicTask } => {
  const { group, task } = createGroup({
    title: "公众号开号",
    botIds: [BotId.parse("bot_sales")],
    summary: "每周一篇长文，先把公众号开起来",
    cadence: "每周一篇",
  });
  const members = [
    {
      kind: "existing",
      botId: BotId.parse("bot_service"),
      note: "评论和私信要有人盯，这件事小服已经在做",
      suggested: false,
    },
    {
      kind: "new",
      name: "校对",
      tags: ["校对"],
      description: "把长文里的错字和前后不一致挑出来",
      note: "长文发之前再看一遍，免得错字被读者先看到",
      suggested: true,
    },
    {
      kind: "new",
      name: "配图",
      tags: ["配图"],
      description: "给每篇长文配封面和插图",
      note: "公众号每篇都要封面，小销顾不上",
      suggested: true,
    },
  ].map((member) => TeamOfferMember.parse(member));
  const message = appendMessage(assistantChatOf(), {
    kind: "team_offer",
    botId: BotId.parse("bot_assistant"),
    members,
    status: "offered",
    groupId: group.id,
  });
  return { message, group, task };
};

/** 主助理单聊里一条临时帮手的工具调用，给工具行的渲染用。 */
export const seedHelperTool = (): Message =>
  appendMessage(assistantChatOf(), {
    kind: "tool_call",
    runId: "",
    botId: BotId.parse("bot_assistant"),
    tool: "call_helper",
    view: { kind: "helper", name: "资料员", task: "整理三家竞品的公众号定价", status: "done" },
    status: "ok",
    durationMs: 4200,
  });

// 首页和项目页的「等你」：先放着的卡还在，只是排到别的待办后面。
export const pendingTeamOffers = (): TodayPendingItem[] =>
  [...messagesByGroupId.values()]
    .flat()
    .filter((message) => message.body.kind === "team_offer" && ["offered", "deferred"].includes(message.body.status))
    .map((message) => ({ kind: "team_offer" as const, since: message.createdAt, message }));

export const isDeferredTeamOffer = (item: TodayPendingItem): boolean =>
  item.kind === "team_offer" && item.message.body.kind === "team_offer" && item.message.body.status === "deferred";

// 重名自动避开：后缀从 2 往上试，名字顶满 20 码元就先截掉尾巴。
const freeNameFor = (wanted: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n += 1) {
    const suffix = `${n}`;
    const candidate = `${wanted.slice(0, NAME_MAX - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
};

export type TeamOfferOutcome =
  | { kind: "missing" }
  | { kind: "closed" }
  | { kind: "rejected"; error: string }
  | { kind: "gone"; position: number }
  | { kind: "deferred"; message: Message }
  | { kind: "confirmed"; message: Message; group: Group; created: { bot: Bot; groupId: GroupId }[] };

export const decideTeamOffer = (messageId: string, request: DecideTeamOfferRequest): TeamOfferOutcome => {
  const message = findMessage(messageId);
  const body = message?.body;
  if (message === null || body?.kind !== "team_offer") return { kind: "missing" };
  if (body.status === "confirmed" || body.status === "dismissed") return { kind: "closed" };

  if (request.decision === "defer") {
    if (body.status === "deferred") return { kind: "deferred", message };
    const next = writeMessageBody(message.id, { ...body, status: "deferred" });
    return next === null ? { kind: "missing" } : { kind: "deferred", message: next };
  }

  const group = groups.get(body.groupId);
  if (group === undefined || group.kind !== "team") return { kind: "missing" };
  const picked = [...new Set(request.picked)];
  if (picked.some((index) => index >= body.members.length)) return { kind: "rejected", error: "勾选的人不在卡上" };
  // 勾上的已有人选被删了：卡、群、Bot 都不动，让人重新勾。
  const gone = picked.find((index) => {
    const member = body.members[index];
    return member?.kind === "existing" && !bots.has(member.botId);
  });
  if (gone !== undefined) return { kind: "gone", position: gone + 1 };
  const chosen = picked.flatMap((index) => {
    const member = body.members[index];
    return member === undefined ? [] : [member];
  });
  const joining = chosen.flatMap((member) =>
    member.kind === "existing" && !group.botIds.includes(member.botId) ? [member.botId] : [],
  );
  const fresh = chosen.filter((member) => member.kind === "new");
  if (group.botIds.length + joining.length + fresh.length > GROUP_MAX) {
    return { kind: "rejected", error: `团队最多 ${GROUP_MAX} 个人，加完会超出` };
  }

  const taken = new Set([...bots.values()].map((bot) => bot.name));
  const created = fresh.map((member) => {
    const name = freeNameFor(member.name, taken);
    taken.add(name);
    const made = createBot({ name, tags: member.tags, description: member.description });
    return { bot: made.bot, groupId: made.group.id };
  });
  const botIds = [...group.botIds, ...joining, ...created.map(({ bot }) => bot.id)];
  const grown = Group.parse({ ...group, botIds });
  groups.set(grown.id, grown);
  const settled = writeMessageBody(message.id, { ...body, status: "confirmed" });
  if (settled === null) return { kind: "missing" };
  return { kind: "confirmed", message: settled, group: grown, created };
};
