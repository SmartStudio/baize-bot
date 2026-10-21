import type { Action, Event, HandState, SeatId } from "./engine.js";
import { RANKS, SUITS, type Card } from "./cards.js";
import { describePokerHand, evaluatePokerHand } from "@baize/shared";

// 老白的代码播报（D29），不调模型。narrate 把引擎事件一对一变成一句中文，给牌友和老白看的公开日志用；
// hostLines 是群里那几句。事件日志里只有公开的事，所以只有摊牌会写出底牌，其余句子拿不到别人的牌。

const SUIT_MARK = { s: "♠", h: "♥", d: "♦", c: "♣" } as const;
const STREET_NAME = { flop: "翻牌", turn: "转牌", river: "河牌" } as const;

export function cardText(card: Card): string {
  const rank = card.charAt(0);
  return `${rank === "T" ? "10" : rank}${SUIT_MARK[card.charAt(1) as keyof typeof SUIT_MARK]}`;
}

const SUIT_WORDS = {
  s: ["♠", "♤", "黑桃"],
  h: ["♥", "♡", "红桃", "红心"],
  d: ["♦", "♢", "方块", "方片"],
  c: ["♣", "♧", "梅花", "草花"],
} as const;

/**
 * 牌友台词能不能上桌。台词可以虚张声势，但点名公共牌以外的具体牌或点数一律不公开，
 * 在座和老白的名字先剥掉（「老K」不算点数），带量词的数字（「3号位」「2倍」）也不算。判断只看台词和公共牌、不看底牌，否则「哪些话活下来」本身就泄露底牌。
 */
export function talkRevealsCards(text: string, board: readonly Card[], names: readonly string[]): boolean {
  const flat = names.reduce((rest, name) => (name === "" ? rest : rest.replaceAll(name, "")), text).replace(/\s+/g, "");
  const boardRanks = new Set(board.map((card) => card.charAt(0)));
  const lower = flat.toLowerCase();
  const namesHidden = RANKS.some((rank) =>
    SUITS.some((suit) => {
      if (board.includes(`${rank}${suit}`)) return false;
      const ranks = rank === "T" ? ["10", "t"] : [rank.toLowerCase()];
      const suits = [suit, ...SUIT_WORDS[suit]];
      return ranks.some((r) => suits.some((w) => lower.includes(r + w) || (w.length > 1 && lower.includes(w + r))));
    }),
  );
  if (namesHidden) return true;
  const digitRanks = [...flat.matchAll(/\d+(?![\d号倍个手次成轮块%])/g)].flatMap(([digits]) =>
    digits === "10" ? ["T"] : /^[2-9]$/.test(digits) ? [digits] : [],
  );
  const letterRanks = [...flat.matchAll(/[A-Za-z]+/g)].flatMap(([word]) => (/^[AKQJT]+$/.test(word) ? [...word] : []));
  return [...digitRanks, ...letterRanks].some((rank) => !boardRanks.has(rank));
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

/** 兜底动作的来由，写进老白下一句话里。 */
export type FallbackReason = "超时" | "三次无效";

/**
 * 老白在群里说的话。一手只在关键处开口：开手一句（庄位和盲注）、每发一街一句（公共牌和底池）、结算一句
 * （谁赢、赢多少，摊牌时连同亮出的牌和牌型）。单个动作不播，座位上的状态桌面自己画。
 * from 是这次新落的第一条事件的序号；fallback 不为 null 时 events[from] 是兜底动作，它并进这次的第一句，
 * 这次没有要说的就不提。
 */
export function hostLines(
  state: HandState,
  from: number,
  nameOf: (seatId: SeatId) => string,
  fallback: FallbackReason | null = null,
): string[] {
  const { events } = state;
  const lines: string[] = [];
  let pot = events.slice(0, from).reduce((sum, event) => sum + putOf(event), 0);
  for (let index = from; index < events.length; index++) {
    const event = events[index] as Event;
    if (index === 0) lines.push(openingLine(state, nameOf));
    if (event.kind === "street")
      lines.push(`${STREET_NAME[event.street]}：${event.cards.map(cardText).join(" ")}，底池 ${pot}`);
    if (event.kind === "award") {
      lines.push(settlementLine(state, nameOf));
      break;
    }
    pot += putOf(event);
  }
  const forced = events[from];
  if (fallback !== null && forced?.kind === "action" && lines[0] !== undefined)
    lines[0] = `${nameOf(forced.seatId)}（${fallback}）${actionText(forced.action, forced.put)}，${lines[0]}`;
  return lines;
}

function putOf(event: Event): number {
  if (event.kind === "blind") return event.amount;
  if (event.kind === "action") return event.put;
  return 0;
}

function openingLine(state: HandState, nameOf: (seatId: SeatId) => string): string {
  const [small, big] = state.events.filter((event) => event.kind === "blind");
  const blind = (event: Event | undefined, label: string) =>
    event?.kind === "blind" ? `，${nameOf(event.seatId)}${label} ${event.amount}` : "";
  return `新一手，${nameOf(state.button)}坐庄${blind(small, "小盲")}${blind(big, "大盲")}`;
}

function settlementLine(state: HandState, nameOf: (seatId: SeatId) => string): string {
  const won = new Map<SeatId, number>();
  for (const event of state.events)
    if (event.kind === "award") won.set(event.seatId, (won.get(event.seatId) ?? 0) + event.amount);
  const shown = state.events.filter((event) => event.kind === "showdown");
  if (shown.length === 0)
    return [...won].map(([seatId, amount]) => `其他人都弃牌，${nameOf(seatId)}收下底池 ${amount}`).join("；");
  return `摊牌：${shown
    .map((event) => {
      const amount = won.get(event.seatId);
      const hand = describePokerHand(evaluatePokerHand(event.hole, state.board));
      return `${nameOf(event.seatId)} ${event.hole.map(cardText).join(" ")}（${hand}）${amount === undefined ? "" : `赢 ${amount}`}`;
    })
    .join("；")}`;
}
