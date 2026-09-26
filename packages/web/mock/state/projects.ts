import { BotId, type Bot, type Group, type Message, type MessageBody } from "@baize/shared";
import { createBot, createGroup } from "./groups.js";
import { findMessage, writeMessageBody } from "./messages.js";
import { groups } from "./store.js";

type OfferBody = Extract<MessageBody, { kind: "project_offer" }>;
type Offer = Omit<OfferBody, "kind" | "botId" | "status" | "groupId">;

const ASSISTANT = BotId.parse("bot_assistant");

const STARS: Offer = {
  name: "推广白泽",
  goal: "白泽的开源仓库年底 1000 星",
  team: [
    { name: "小内", tag: "内容", description: "写 X 帖子和 GitHub 周报，不回评论" },
    { name: "小社", tag: "社区", description: "回 GitHub issue 和评论，不写长文" },
  ],
  platforms: [
    { kind: "supported", platform: "github" },
    { kind: "supported", platform: "x" },
  ],
  cadence: "每周 X 发 5 条，GitHub 周报一篇",
  firstStep: "先把 README 改成一句话讲清楚白泽是什么",
};

const DOUYIN: Offer = {
  name: "抖音起号",
  goal: "抖音号年底 1000 粉",
  team: [
    { name: "阿文", tag: "脚本", description: "写短视频脚本和标题，不剪片" },
    { name: "老周", tag: "数据", description: "每周看一次播放和涨粉，不碰账号" },
  ],
  platforms: [
    { kind: "unsupported", name: "抖音" },
    { kind: "supported", platform: "xiaohongshu" },
  ],
  cadence: "每周 3 条短视频",
  firstStep: "今晚给你 3 条选题，你挑一条",
};

// 控制面由主助理的模型判断这句话是不是要开一个项目；mock 只认带「年底」这种有期限的目标。
export const projectOfferFor = (prompt: string): OfferBody | null => {
  if (!prompt.includes("年底")) return null;
  const offer = prompt.includes("抖音") ? DOUYIN : STARS;
  return { kind: "project_offer", botId: ASSISTANT, ...offer, status: "offered", groupId: null };
};

export type StartResult =
  | { kind: "missing" }
  | { kind: "settled"; message: Message; group: Group | null }
  | { kind: "started"; message: Message; group: Group; members: Bot[]; task: ReturnType<typeof createGroup>["task"] };

// 跟控制面一样只有 offered 的卡能开始，第二次点回卡现在的样子和它建出的群，什么都不再建。
export const startProject = (messageId: string, name: string | undefined): StartResult => {
  const offer = findMessage(messageId);
  if (offer === null || offer.body.kind !== "project_offer") return { kind: "missing" };
  const body = offer.body;
  if (body.status !== "offered") {
    return {
      kind: "settled",
      message: offer,
      group: body.groupId === null ? null : (groups.get(body.groupId) ?? null),
    };
  }
  const members = body.team.map((member) => createBot(member).bot);
  const { group, task } = createGroup({
    title: name ?? body.name,
    botIds: [ASSISTANT, ...members.map((bot) => bot.id)],
    summary: body.goal,
    dueAt: null,
    chiefBotId: ASSISTANT,
    cadence: body.cadence,
    checklist: [{ text: body.firstStep, done: false, ownerBotId: null }],
  });
  const message = writeMessageBody(offer.id, { ...body, status: "started", groupId: group.id });
  if (message === null) throw new Error(`方案卡 ${offer.id} 点完就不见了，mock 状态坏了`);
  return { kind: "started", message, group, members, task };
};
