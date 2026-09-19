import type { BotId, Message } from "@baize/shared";

export type Turn =
  | { kind: "user"; message: Message }
  | { kind: "bot"; botId: BotId; items: Message[]; cost: Message | null }
  | { kind: "system"; message: Message; cost: Message | null }
  | { kind: "cost"; message: Message };

const attachCost = (turns: Turn[], message: Message, botId: BotId | undefined): boolean => {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn === undefined) continue;

    if (turn.kind === "user") break;
    if (turn.kind !== "bot") continue;
    if (botId !== undefined && turn.botId !== botId) continue;

    // 同一回合只挂一笔；第二笔不能往更早的同 Bot 回合上挂，宁可做孤儿。
    if (turn.cost !== null) return false;
    turn.cost = message;
    return true;
  }

  const previous = turns.at(-1);
  if (
    previous?.kind === "system" &&
    previous.cost === null &&
    previous.message.body.kind === "system" &&
    previous.message.body.tone === "error"
  ) {
    previous.cost = message;
    return true;
  }

  return false;
};

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
        if (previous?.kind === "bot" && previous.botId === body.botId) {
          previous.items.push(message);
        } else {
          turns.push({ kind: "bot", botId: body.botId, items: [message], cost: null });
        }
        break;
      case "approval":
      case "handoff":
        if (previous?.kind === "bot") {
          previous.items.push(message);
        } else {
          turns.push({ kind: "system", message, cost: null });
        }
        break;
      case "system":
        turns.push({ kind: "system", message, cost: null });
        break;
      case "cost":
        if (!attachCost(turns, message, body.botId)) {
          turns.push({ kind: "cost", message });
        }
        break;
      default: {
        const unreachable: never = body;
        return unreachable;
      }
    }
  }

  return turns;
};
