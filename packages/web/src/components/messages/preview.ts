import type { Message, MessageBody } from "@baize/shared";

export const previewOf = (body: MessageBody): string => {
  switch (body.kind) {
    case "user":
    case "bot":
    case "system":
      return body.text;
    case "tool_call":
      return `${body.tool} · ${body.argsSummary}`;
    case "approval":
      return "等你点头";
    case "handoff":
      return "交接给别的 Bot";
    case "skill_offer":
      return `存成 skill「${body.name}」？`;
    case "cost":
      return `本次花费 ¥${body.amount.toFixed(1)}`;
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
