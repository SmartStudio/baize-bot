import type { BotId, Message } from "@baize/shared";

export type Turn =
  | { kind: "user"; message: Message }
  | { kind: "bot"; botId: BotId; items: Message[] }
  | { kind: "system"; message: Message };

export const turnsOf = (messages: Message[]): Turn[] => {
  const turns: Turn[] = [];

  for (const message of messages) {
    const body = message.body;
    const previous = turns.at(-1);

    switch (body.kind) {
      case "user":
        turns.push({ kind: "user", message });
        break;
      case "bot":
      case "tool_call":
      case "skill_offer":
        if (previous?.kind === "bot" && previous.botId === body.botId) previous.items.push(message);
        else turns.push({ kind: "bot", botId: body.botId, items: [message] });
        break;
      case "approval":
      case "handoff":
      case "project_offer":
      case "draft":
      case "plan":
        if (previous?.kind === "bot") previous.items.push(message);
        else turns.push({ kind: "system", message });
        break;
      case "system":
        turns.push({ kind: "system", message });
        break;
      case "cost":
        break;
      default: {
        const unreachable: never = body;
        return unreachable;
      }
    }
  }

  return turns;
};
