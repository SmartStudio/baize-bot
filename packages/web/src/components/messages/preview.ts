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
    case "cost":
      return `本次花费 ¥${body.amount.toFixed(1)}`;
  }
};

export const timeOf = (message: Message): string => {
  const at = new Date(message.createdAt);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};
