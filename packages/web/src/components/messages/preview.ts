import { toolViewText } from "@baize/shared";
import type { Message, MessageBody } from "@baize/shared";

export const formatAmount = (amount: number): string => amount.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0");

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
      return `存成 skill「${body.name}」？`;
    case "project_offer":
      return `项目方案「${body.name}」`;
    case "draft":
      return "一条草稿";
    case "plan":
      return "一份内容计划";
    case "cost":
      return `本次花费 ¥${formatAmount(body.amount)}`;
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
