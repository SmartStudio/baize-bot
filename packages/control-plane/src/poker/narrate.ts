import type { Action, Event, SeatId } from "./engine.js";
import type { Card } from "./cards.js";

// 老白的代码播报（D29）：引擎事件一对一变成一句中文，不调模型。事件日志里只有公开的事，
// 所以这里只有 showdown 一种事件会写出底牌，其余句子拿不到别人的牌。

const SUIT_MARK = { s: "♠", h: "♥", d: "♦", c: "♣" } as const;
const STREET_NAME = { flop: "翻牌", turn: "转牌", river: "河牌" } as const;

export function cardText(card: Card): string {
  const rank = card.charAt(0);
  return `${rank === "T" ? "10" : rank}${SUIT_MARK[card.charAt(1) as keyof typeof SUIT_MARK]}`;
}

function actionText(action: Action, put: number): string {
  switch (action.kind) {
    case "fold":
      return "弃牌";
    case "check":
      return "过牌";
    case "call":
      return put > 0 ? `跟注 ${put}` : "跟注";
    case "raise":
      return `加注到 ${action.amount}`;
    case "all_in":
      return `全下 ${put}`;
  }
}

// 播报和牌友、老白看的公开记录里，用户座位一律叫「你」；视图里用户位用的是主人名。
export const seatNamer =
  (seats: readonly { engineSeatId: string; kind: "user" | "bot"; name: string }[]) =>
  (id: SeatId): string => {
    const seat = seats.find((candidate) => candidate.engineSeatId === id);
    if (seat === undefined) return id;
    return seat.kind === "user" ? "你" : seat.name;
  };

export function narrate(event: Event, nameOf: (seatId: SeatId) => string): string {
  switch (event.kind) {
    case "blind":
      return `${nameOf(event.seatId)} 下盲注 ${event.amount}`;
    case "action":
      return `${nameOf(event.seatId)} ${actionText(event.action, event.put)}`;
    case "street":
      return `${STREET_NAME[event.street]}：${event.cards.map(cardText).join(" ")}`;
    case "showdown":
      return `${nameOf(event.seatId)} 亮牌：${event.hole.map(cardText).join(" ")}`;
    case "award":
      return `${nameOf(event.seatId)} 赢下${event.pot === 0 ? "主池" : `边池 ${event.pot}`} ${event.amount}`;
  }
}
