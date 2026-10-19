import { describePokerHand, evaluatePokerHand } from "@baize/shared";
import type {
  BotHue,
  BotShape,
  GroupId,
  PokerAction,
  PokerActionOption,
  PokerCard,
  PokerHandId,
  PokerPersona,
  PokerPosition,
  PokerSeatNo,
  PokerSeatStatus,
  PokerSeatView,
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

export const formatChips = (amount: number): string => new Intl.NumberFormat("en-US").format(amount);

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

export type SeatMarker = "庄" | "小盲" | "大盲";

export type FeltSeat = {
  seat: PokerSeatNo;
  name: string;
  hue: BotHue;
  shape: BotShape;
  persona: PokerPersona | null;
  stack: number;
  /** 这一街已经推到桌上的筹码。一手打完就不画了。 */
  bet: number;
  status: PokerSeatStatus;
  marker: SeatMarker | null;
  /** 有牌在手：画背面（对手）或牌面（你）。弃牌了或没开手就没有。 */
  hasCards: boolean;
  /** 能看到的牌面：你的底牌，或对手摊牌亮出的。对手的底牌永远不会出现在这里。 */
  cards: readonly [PokerCard, PokerCard] | null;
  /** 这一街最后一个动作；一手打完是摊牌的牌型。 */
  label: string;
  /** 这一手从底池拿走的筹码，没赢是 0。 */
  won: number;
  acting: boolean;
};

export type FeltModel = {
  opponents: FeltSeat[];
  me: FeltSeat | null;
  board: (PokerCard | null)[];
  pot: number;
  streetLabel: string;
  /** 轮到牌友时他出牌的最后期限；轮到你或没人要出牌时是 null。 */
  deadline: string | null;
};

const STREET_LABEL = { preflop: "翻牌前", flop: "翻牌", turn: "转牌", river: "河牌", complete: "本手结束" } as const;
const BOARD_SLOTS = 5;
const MARKER: Partial<Record<PokerPosition, SeatMarker>> = { button: "庄", small_blind: "小盲", big_blind: "大盲" };

// 标签只留本街最后一个动作：换街的事件一来就清。盲注不算动作，但算进本街的下注额。
// 标签写的是推完之后本街一共多少，和座位前的筹码数对得上。翻牌前有大盲垫着，加注总是「加注到」；
// 翻牌后本街没人下过注，第一个往里推的是「下注」。
const lastActionLabels = (view: PokerSeatView): Map<string, string> => {
  const labels = new Map<string, string>();
  const street = new Map<string, number>();
  let opened = true;
  for (const event of view.events) {
    if (event.kind === "street") {
      labels.clear();
      street.clear();
      opened = false;
    }
    if (event.kind === "blind") street.set(event.seatId, (street.get(event.seatId) ?? 0) + event.amount);
    if (event.kind !== "action") continue;
    const { action } = event;
    const total = action.kind === "raise" ? action.amount : (street.get(event.seatId) ?? 0) + event.put;
    street.set(event.seatId, total);
    const label = ((): string => {
      switch (action.kind) {
        case "fold":
          return "弃牌";
        case "check":
          return "过牌";
        case "call":
          return `跟 ${formatChips(total)}`;
        case "raise":
          return opened ? `加注到 ${formatChips(total)}` : `下注 ${formatChips(total)}`;
        case "all_in":
          return `全下 ${formatChips(total)}`;
      }
    })();
    if (event.put > 0) opened = true;
    labels.set(event.seatId, label);
  }
  return labels;
};

/** 摊牌亮出来的每家牌型，按引擎座位 id。公共牌不满五张（没摊牌）时是空的。 */
export const showdownHands = (view: PokerSeatView): Map<string, string> => {
  const names = new Map<string, string>();
  if (view.board.length + 2 < 5) return names;
  for (const seat of view.seats) {
    const hole = seat.seatId === view.seatId && seat.shown !== null ? view.hole : seat.shown;
    if (hole !== null) names.set(seat.seatId, describePokerHand(evaluatePokerHand(hole, view.board)));
  }
  return names;
};

export const feltOf = (table: PokerTableView | null): FeltModel | null => {
  if (table === null) return null;
  const hand = table.hand;
  const view = hand?.view ?? null;
  const labels = view === null ? new Map<string, string>() : lastActionLabels(view);
  const complete = view?.street === "complete";
  const handNames = view !== null && complete ? showdownHands(view) : new Map<string, string>();
  const won = new Map<string, number>();
  for (const award of view?.awards ?? []) won.set(award.seatId, (won.get(award.seatId) ?? 0) + award.amount);

  const seatModel = (seat: PokerTableView["seats"][number]): FeltSeat => {
    const engine = view?.seats.find((other) => other.seatId === seat.engineSeatId);
    const status = engine?.status ?? "active";
    const own = seat.kind === "user";
    const shown = engine?.shown ?? null;
    const cards = own ? (view?.hole ?? null) : shown;
    const label =
      handNames.get(seat.engineSeatId) ?? (status === "folded" ? "弃牌" : (labels.get(seat.engineSeatId) ?? ""));
    return {
      seat: seat.seat,
      name: seat.name,
      hue: seat.hue,
      shape: seat.shape,
      persona: seat.persona,
      stack: engine?.stack ?? seat.stack,
      bet: complete ? 0 : (engine?.committed ?? 0),
      status,
      marker: engine === undefined ? null : (MARKER[engine.position] ?? null),
      hasCards: view !== null && status !== "folded",
      cards,
      label,
      won: won.get(seat.engineSeatId) ?? 0,
      acting: hand !== null && hand.toAct === seat.seat,
    };
  };

  const seats = [...table.seats].sort((a, b) => a.seat - b.seat);
  const board: (PokerCard | null)[] = Array.from({ length: BOARD_SLOTS }, (_, index) => view?.board[index] ?? null);
  const actingBot = seats.some((seat) => seat.kind === "bot" && hand?.toAct === seat.seat);
  return {
    opponents: seats.filter((seat) => seat.kind === "bot").map(seatModel),
    me: seats.filter((seat) => seat.kind === "user").map(seatModel)[0] ?? null,
    board,
    pot: view?.pot ?? 0,
    streetLabel: view === null ? "" : STREET_LABEL[view.street],
    deadline: actingBot ? (hand?.deadline ?? null) : null,
  };
};

export type QuickPick = { id: "min" | "half" | "pot" | "all"; label: string; amount: number };

/** 本街还没人下过注时往里推叫「下注」，有人下过了再加叫「加注到」。翻牌前有大盲，总是后者。 */
export type RaiseVerb = "下注" | "加注到";

export type RaiseRange = {
  kind: "raise";
  verb: RaiseVerb;
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

const QUICK_LABEL = { min: "最小", half: "半池", pot: "满池", all: "全下" } as const;

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
    return [{ id, label: `${QUICK_LABEL[id]} ${formatChips(amount)}`, amount }];
  });
};

/** 快捷档点了直接出牌：顶到筹码上限的就是全下，其余按这个数加注。 */
export const quickAction = (range: RaiseRange, pick: QuickPick): PokerAction =>
  pick.amount >= range.max ? { kind: "all_in" } : { kind: "raise", amount: pick.amount };

export const actionBarOf = (table: PokerTableView): ActionBarModel | null => {
  const hand = table.hand;
  if (hand === null) return null;
  const { view } = hand;
  const { legal } = view;
  if (legal.kind === "complete") return null;
  const base = { handId: hand.id, seq: view.events.length };
  const me = view.seats.find((seat) => seat.seatId === view.seatId);
  const myCommitted = me?.committed ?? 0;
  const currentBet = Math.max(0, ...view.seats.map((seat) => seat.committed));

  if (legal.kind === "waiting") {
    // 没轮到你也要画按钮，写什么按桌上现在的最大下注推，免得轮到你时文字一跳。
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
      verb: view.street === "preflop" || currentBet > 0 ? "加注到" : "下注",
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

/** 不通过时 fix 是一键能改成的那个合法数：太小改成最小，太大改成最多；不是整数没法替人猜，是 null。 */
export type RaiseCheck = { ok: true; amount: number } | { ok: false; reason: string; fix: number | null };

export const raiseCheck = (range: RaiseRange, text: string): RaiseCheck => {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, reason: "要填整数", fix: null };
  const amount = Number(trimmed);
  if (amount < range.min) {
    return { ok: false, reason: `最少要${range.verb} ${formatChips(range.min)}`, fix: range.min };
  }
  if (amount > range.max) {
    return { ok: false, reason: `筹码不够，最多只能${range.verb} ${formatChips(range.max)}`, fix: range.max };
  }
  return { ok: true, amount };
};
