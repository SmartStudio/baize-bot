import { toolViewText } from "@baize/shared";
import type { Message, MessageBody, SkillChange } from "@baize/shared";

// 卡上只存改成什么，改之前叫什么要从这个 Bot 现在的技能里查。查不到（没拉下来、已经改完或删了）就只写新名。
export const skillOfferTitle = (change: SkillChange, currentName?: string): string => {
  switch (change.op) {
    case "add":
      return change.origin === null
        ? `存成技能「${change.name}」？`
        : `从 ${new URL(change.origin).host} 装技能「${change.name}」？`;
    case "edit":
      return currentName === undefined || currentName === change.name
        ? `改技能「${change.name}」？`
        : `改技能「${currentName}」→「${change.name}」？`;
    case "remove":
      return `删掉技能「${change.name}」？`;
  }
};

export const previewOf = (body: MessageBody): string => {
  switch (body.kind) {
    case "user":
    case "bot":
    case "system":
      return body.text;
    case "tool_call":
      return `${body.tool} · ${toolViewText(body.view)}`;
    case "approval":
      return "等你点头";
    case "handoff":
      return "交接给别的 Bot";
    case "skill_offer":
      return skillOfferTitle(body.change);
    case "preference_offer":
      return `记住「${body.text}」？`;
    case "project_offer":
      return `项目方案「${body.name}」`;
    case "team_offer":
      return "一张建队卡";
    case "routine_offer":
      return `例行「${body.name}」加不加？`;
    case "draft":
      return "一条草稿";
    case "plan":
      return "一份内容计划";
    case "cost":
      return "已完成";
  }
};

export const timeOf = (message: Message): string => {
  const at = new Date(message.createdAt);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};

export type BotActivity = "idle" | "working";

// 「干活中」不用单独存一个字段：最后一条消息还在流、或者工具还在跑，这个 Bot 就在干活。
export const activityOf = (lastMessage: Message | null): BotActivity => {
  const body = lastMessage?.body;
  if (body?.kind === "bot") return body.streaming ? "working" : "idle";
  if (body?.kind === "tool_call") return body.status === "running" ? "working" : "idle";
  return "idle";
};
