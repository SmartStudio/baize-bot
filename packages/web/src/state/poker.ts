import type {
  BotHue,
  GroupId,
  PokerAction,
  PokerActionOption,
  PokerCard,
  PokerEvent,
  PokerHandId,
  PokerPersona,
  PokerSeatNo,
  PokerSeatStatus,
  PokerTableView,
} from "@baize/shared";
import type { Action, ReadyState } from "./types.js";

// 一张桌一份整视图，推送和接口回的都是整份，都走 poker_table_set。控制面的广播不保证按版本先后到，
// 版本不比手上新的一律丢掉，晚到的旧版才盖不回来。这一行守卫是契约的一部分，poker.test.ts 钉着它。
export const reducePoker = (state: ReadyState, action: Action): ReadyState => {
  if (action.type !== "poker_table_set") return state;
  const known = state.poker[action.table.groupId];
  if (known !== undefined && action.table.version <= known.version) return state;
  return { ...state, poker: { ...state.poker, [action.table.groupId]: action.table } };
};

export const pokerTableOf = (state: ReadyState, groupId: GroupId): PokerTableView | undefined => state.poker[groupId];

// 牌桌群在用户这边只有拉过或推过视图之后才认得出来。进项目页先拉一次视图归单元 13。
export const isPokerTable = (state: ReadyState, groupId: GroupId): boolean =>
  pokerTableOf(state, groupId) !== undefined;

// 控制面的引擎座位 id 是 "1" 到 "4"，Web mock 是 "s1" 到 "s4"。两边都只在末尾带座位号，认不出的当没有。
export const seatNoOfEngineId = (seatId: string): PokerSeatNo | null => {
  const matched = /^s?([1-4])$/.exec(seatId);
  return matched === null ? null : (Number(matched[1]) as PokerSeatNo);
};

const SUIT_SYMBOL = { s: "♠", h: "♥", d: "♦", c: "♣" } as const;

export const cardParts = (card: PokerCard): { rank: string; suit: string; red: boolean } => {
  const suit = card.slice(1) as keyof typeof SUIT_SYMBOL;
  return {
    rank: card.startsWith("T") ? "10" : card.slice(0, 1),
    suit: SUIT_SYMBOL[suit],
    red: suit === "h" || suit === "d",
  };
};

export const cardText = (card: PokerCard): string => {
  const { rank, suit } = cardParts(card);
  return `${rank}${suit}`;
};

export type FeltSeat = {
  seat: PokerSeatNo;
  name: string;
  hue: BotHue;
  persona: PokerPersona | null;
  stack: number;
  committed: number;
  status: PokerSeatStatus;
  /** 有牌在手：画背面（对手）或牌面（你）。弃牌了或没开手就没有。 */
  hasCards: boolean;
  /** 能看到的牌面：你的底牌，或对手摊牌亮出的。对手的底牌永远不会出现在这里。 */
  cards: readonly [PokerCard, PokerCard] | null;
  label: string;
  acting: boolean;
};

export type FeltModel = {
  opponents: FeltSeat[];
  me: FeltSeat | null;
  board: (PokerCard | null)[];
  pot: number;
  streetLabel: string;
};

const STREET_LABEL = { preflop: "翻牌前", flop: "翻牌", turn: "转牌", river: "河牌", complete: "本手结束" } as const;
const BOARD_SLOTS = 5;

const actionLabel = (action: PokerAction, put: number): string => {
  switch (action.kind) {
    case "fold":
      return "弃牌";
    case "check":
      return "过牌";
    case "call":
      return `跟 ${put}`;
    case "raise":
      return `加到 ${action.amount}`;
    case "all_in":
      return "全下";
  }
};

// 标签只留本街最后一个动作：换街的事件一来就清。盲注不算动作。
const lastActionLabels = (events: readonly PokerEvent[]) => {
  const labels = new Map<PokerSeatNo, string>();
  for (const event of events) {
    if (event.kind === "street") labels.clear();
    if (event.kind !== "action") continue;
    const seat = seatNoOfEngineId(event.seatId);
    if (seat !== null) labels.set(seat, actionLabel(event.action, event.put));
  }
  return labels;
};

export const feltOf = (table: PokerTableView | null): FeltModel | null => {
  if (table === null) return null;
  const hand = table.hand;
  const view = hand?.view ?? null;
  const labels = view === null ? new Map<PokerSeatNo, string>() : lastActionLabels(view.events);

  const seatModel = (seat: PokerTableView["seats"][number]): FeltSeat => {
    const engine = view?.seats.find((other) => seatNoOfEngineId(other.seatId) === seat.seat);
    const status = engine?.status ?? "active";
    const own = seat.kind === "user";
    const shown = engine?.shown ?? null;
    const cards = own ? (view?.hole ?? null) : shown;
    const label =
      shown !== null
        ? `亮牌 ${shown.map(cardText).join(" ")}`
        : status === "folded"
          ? "弃牌"
          : (labels.get(seat.seat) ?? "");
    return {
      seat: seat.seat,
      name: seat.name,
      hue: seat.hue,
      persona: seat.persona,
      stack: engine?.stack ?? seat.stack,
      committed: engine?.committed ?? 0,
      status,
      hasCards: view !== null && status !== "folded",
      cards,
      label,
      acting: hand !== null && hand.toAct === seat.seat,
    };
  };

  const seats = [...table.seats].sort((a, b) => a.seat - b.seat);
  const board: (PokerCard | null)[] = Array.from({ length: BOARD_SLOTS }, (_, index) => view?.board[index] ?? null);
  return {
    opponents: seats.filter((seat) => seat.kind === "bot").map(seatModel),
    me: seats.filter((seat) => seat.kind === "user").map(seatModel)[0] ?? null,
    board,
    pot: view?.pot ?? 0,
    streetLabel: view === null ? "" : STREET_LABEL[view.street],
  };
};

export type QuickPick = { id: "min" | "half" | "pot" | "all"; label: string; amount: number };

export type RaiseRange = {
  kind: "raise";
  min: number;
  max: number;
  step: number;
  quick: readonly QuickPick[];
};
export type RaiseSpec = RaiseRange | { kind: "all_in"; amount: number };
export type PassSpec = { kind: "check" } | { kind: "call"; amount: number };

export type ActionBarModel = {
  handId: PokerHandId;
  /** 引擎已落库的事件数，请求带上它，错位了控制面回 409。 */
  seq: number;
  mine: boolean;
  canFold: boolean;
  pass: PassSpec;
  raise: RaiseSpec | null;
};

const QUICK_LABEL = { min: "最小加注", half: "半池", pot: "满池", all: "全下" } as const;

const quickPicks = (range: { min: number; max: number }, currentBet: number, potAfterCall: number): QuickPick[] => {
  const clamp = (amount: number) => Math.min(range.max, Math.max(range.min, amount));
  const raw: [QuickPick["id"], number][] = [
    ["min", range.min],
    ["half", clamp(currentBet + Math.floor(potAfterCall / 2))],
    ["pot", clamp(currentBet + potAfterCall)],
    ["all", range.max],
  ];
  const seen = new Set<number>();
  return raw.flatMap(([id, amount]) => {
    if (seen.has(amount)) return [];
    seen.add(amount);
    return [{ id, label: QUICK_LABEL[id], amount }];
  });
};

export const actionBarOf = (table: PokerTableView): ActionBarModel | null => {
  const hand = table.hand;
  if (hand === null) return null;
  const { view } = hand;
  const { legal } = view;
  if (legal.kind === "complete") return null;
  const base = { handId: hand.id, seq: view.events.length };
  const me = view.seats.find((seat) => seat.seatId === view.seatId);
  const myCommitted = me?.committed ?? 0;

  if (legal.kind === "waiting") {
    // 没轮到你也要画按钮，写什么按桌上现在的最大下注推，免得轮到你时文字一跳。
    const currentBet = Math.max(0, ...view.seats.map((seat) => seat.committed));
    const owed = Math.min(Math.max(0, currentBet - myCommitted), view.stack);
    const pass: PassSpec = owed > 0 ? { kind: "call", amount: owed } : { kind: "check" };
    return { ...base, mine: false, canFold: false, pass, raise: null };
  }

  const { toCall, options } = legal;
  const find = <K extends PokerActionOption["kind"]>(kind: K) =>
    options.find((option): option is Extract<PokerActionOption, { kind: K }> => option.kind === kind);
  const call = find("call");
  const raise = find("raise");
  const allIn = find("all_in");
  const pass: PassSpec = call !== undefined ? { kind: "call", amount: call.amount } : { kind: "check" };

  let raiseSpec: RaiseSpec | null = null;
  if (raise !== undefined) {
    raiseSpec = {
      kind: "raise",
      min: raise.min,
      max: raise.max,
      step: view.blinds.big,
      quick: quickPicks(raise, myCommitted + toCall, view.pot + toCall),
    };
  } else if (allIn !== undefined && allIn.amount > toCall) {
    raiseSpec = { kind: "all_in", amount: allIn.amount };
  }
  return { ...base, mine: true, canFold: find("fold") !== undefined, pass, raise: raiseSpec };
};

export type RaiseCheck = { ok: true; amount: number } | { ok: false; reason: string };

export const raiseCheck = (range: RaiseRange, text: string): RaiseCheck => {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, reason: "加注额要填整数" };
  const amount = Number(trimmed);
  if (amount < range.min) return { ok: false, reason: `最少要加到 ${range.min}` };
  if (amount > range.max) return { ok: false, reason: `筹码不够，最多只能加到 ${range.max}` };
  return { ok: true, amount };
};
