import type { BotHue, BotId, Message, PokerSeatView, PokerTableView } from "@baize/shared";

// 牌桌右栏、老白的建议和一手结束这三块要读的东西。都从整张桌视图和群消息里算，不存状态。

export type Speaker = { readonly name: string; readonly hue: BotHue };
export type LogLine = { readonly id: string; readonly name: string; readonly hue: BotHue; readonly text: string };

// 换下桌的牌友不在座位表里了，他留在记录里的话只剩 botId，认不出名字。
const FORMER_PLAYER: Speaker = { name: "已下桌的牌友", hue: "sky" };

export const formatChips = (amount: number): string => new Intl.NumberFormat("en-US").format(amount);

// 预置牌友不在 GET /api/bots 里，名字和颜色只能取自座位和主持。
const speakersOf = (table: PokerTableView): { bots: Map<BotId, Speaker>; user: Speaker } => {
  const bots = new Map<BotId, Speaker>([[table.host.botId, table.host]]);
  let user: Speaker = { name: "你", hue: "lime" };
  for (const seat of table.seats) {
    if (seat.kind === "bot" && seat.botId !== null) bots.set(seat.botId, seat);
    else user = seat;
  }
  return { bots, user };
};

// 公开的话按发出的时间排，同一时刻保持到达的先后。只有全群可见的才进记录，给你一个人看的（老白的建议）不进。
export const publicLines = (messages: readonly Message[], table: PokerTableView): LogLine[] => {
  const { bots, user } = speakersOf(table);
  return messages
    .flatMap((message, arrived) => {
      const { body } = message;
      if (message.visibleTo !== null || (body.kind !== "bot" && body.kind !== "user") || body.text.trim() === "") {
        return [];
      }
      const speaker = body.kind === "user" ? user : (bots.get(body.botId) ?? FORMER_PLAYER);
      const line: LogLine = { id: message.id, name: speaker.name, hue: speaker.hue, text: body.text };
      return [{ at: Date.parse(message.createdAt), arrived, line }];
    })
    .toSorted((a, b) => a.at - b.at || a.arrived - b.arrived)
    .map(({ line }) => line);
};

export type HintStage = "none" | "idle" | "waiting" | "done" | "failed";

// 提示是挂在决策点上的：seq 对不上当前的事件数，说明是上一个决策点留下的，当没问过。
export const hintStage = (table: PokerTableView): HintStage => {
  const { hand, hint } = table;
  if (hand === null || hand.view.street === "complete") return "none";
  if (hint === null || hint.seq !== hand.view.events.length) return "idle";
  return hint.status;
};

export const hintText = (messages: readonly Message[], table: PokerTableView): string | null => {
  const id = table.hint?.messageId;
  if (id === null || id === undefined) return null;
  const body = messages.find((message) => message.id === id)?.body;
  return body?.kind === "bot" ? body.text : null;
};

/** 这一手你的筹码净变化：赢回来的减去投进去的（盲注加每次动作的投入）。 */
export const netOf = (view: PokerSeatView): number => {
  const paid = view.events.reduce((sum, event) => {
    if (event.kind === "blind" && event.seatId === view.seatId) return sum + event.amount;
    if (event.kind === "action" && event.seatId === view.seatId) return sum + event.put;
    return sum;
  }, 0);
  const won = (view.awards ?? []).reduce((sum, award) => (award.seatId === view.seatId ? sum + award.amount : sum), 0);
  return won - paid;
};

export type HandResult = { readonly tone: "win" | "lose" | "even"; readonly headline: string; readonly detail: string };

export const handResult = (table: PokerTableView): HandResult | null => {
  const view = table.hand?.view;
  if (view === undefined || view.street !== "complete") return null;
  const net = netOf(view);
  const nameOf = (engineSeatId: string): string => {
    if (engineSeatId === view.seatId) return "你";
    return table.seats.find((seat) => seat.engineSeatId === engineSeatId)?.name ?? "对手";
  };
  const taken = new Map<string, number>();
  for (const award of view.awards ?? []) taken.set(award.seatId, (taken.get(award.seatId) ?? 0) + award.amount);
  const detail = [...taken].map(([seatId, amount]) => `${nameOf(seatId)} ${formatChips(amount)}`).join("，");
  if (net > 0) return { tone: "win", headline: `你赢了 ${formatChips(net)} 筹码`, detail: `结算：${detail}` };
  if (net < 0) return { tone: "lose", headline: `你输了 ${formatChips(-net)} 筹码`, detail: `结算：${detail}` };
  return { tone: "even", headline: "这手不输不赢", detail: `结算：${detail}` };
};
