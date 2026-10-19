import { shuffledDeck, type Card } from "./cards.js";
import { comparePokerHands, evaluatePokerHand, type PokerHandValue } from "@baize/shared";

// 一手德州从发牌到结算的确定性引擎。纯函数：不读时钟、不读全局随机数，洗牌只看种子，
// 所以种子加动作日志就能重放出同一个状态。apply 返回新状态，不改传入的那份。

export type SeatId = string;

export interface SeatInput {
  readonly id: SeatId;
  readonly stack: number;
}

export interface Blinds {
  readonly small: number;
  readonly big: number;
}

export type SeatStatus = "active" | "folded" | "all_in";

export interface Seat {
  id: SeatId;
  /** 手上还没推进底池的筹码。 */
  stack: number;
  /** 本街已经推进去的。 */
  committed: number;
  /** 整手牌一共推进去的，结算按它分层。 */
  contributed: number;
  status: SeatStatus;
  hole: readonly [Card, Card];
}

export type Street = "preflop" | "flop" | "turn" | "river";

export type Action =
  | { readonly kind: "fold" }
  | { readonly kind: "check" }
  | { readonly kind: "call" }
  /** amount 是本街加到的总额，不是增量。没人下注时就是下注。 */
  | { readonly kind: "raise"; readonly amount: number }
  | { readonly kind: "all_in" };

export interface Award {
  readonly seatId: SeatId;
  readonly amount: number;
  /** 0 是主池，往上是一层层边池。 */
  readonly pot: number;
}

/** 日志只记公开的事，没有底牌发放；底牌由种子推出，摊牌时才作为 showdown 事件公开。 */
export type Event =
  | { readonly kind: "blind"; readonly seatId: SeatId; readonly amount: number }
  | { readonly kind: "action"; readonly seatId: SeatId; readonly action: Action; readonly put: number }
  | { readonly kind: "street"; readonly street: Exclude<Street, "preflop">; readonly cards: readonly Card[] }
  | { readonly kind: "showdown"; readonly seatId: SeatId; readonly hole: readonly [Card, Card] }
  | { readonly kind: "award"; readonly seatId: SeatId; readonly amount: number; readonly pot: number };

export type Phase =
  | {
      kind: "betting";
      street: Street;
      /** 本街还要说话的座位，按说话顺序，第一个就是现在轮到的。 */
      pending: SeatId[];
      /**
       * 本街表过态的座位当时跟到或加到的总额。再轮到时，下注额从那以后涨够一个完整加注才能再加。
       * 用 Map 不用普通对象：座位编号是任意字符串，叫 constructor、__proto__ 时普通对象会读到原型上的东西。
       */
      actedAt: Map<SeatId, number>;
      /** 本街要跟到的总额。 */
      currentBet: number;
      /** 最小加注增量：上一次完整加注的增量，本街还没人加注时是大盲。 */
      minRaise: number;
    }
  | { kind: "complete"; ending: "fold" | "showdown"; awards: Award[] };

export interface HandState {
  readonly seed: string;
  readonly button: SeatId;
  readonly blinds: Blinds;
  seats: Seat[];
  deck: Card[];
  board: Card[];
  phase: Phase;
  events: Event[];
}

export type ActionOption =
  | { readonly kind: "fold" }
  | { readonly kind: "check" }
  | { readonly kind: "call"; readonly amount: number }
  | { readonly kind: "raise"; readonly min: number; readonly max: number }
  | { readonly kind: "all_in"; readonly amount: number };

export type LegalActions =
  | { readonly kind: "complete" }
  | { readonly kind: "waiting"; readonly toAct: SeatId }
  | { readonly kind: "your_turn"; readonly street: Street; readonly toCall: number; readonly options: ActionOption[] };

export function newHand(seed: string, seats: readonly SeatInput[], button: SeatId, blinds: Blinds): HandState {
  if (seats.length < 2 || seats.length > 10) throw new Error("一桌要 2 到 10 个座位");
  if (new Set(seats.map((seat) => seat.id)).size !== seats.length) throw new Error("座位编号重复");
  if (seats.some((seat) => !Number.isSafeInteger(seat.stack) || seat.stack <= 0))
    throw new Error("每个座位开局都要有正整数筹码");
  if (!Number.isSafeInteger(seats.reduce((sum, seat) => sum + seat.stack, 0))) throw new Error("整桌筹码总数太大");
  if (
    !Number.isSafeInteger(blinds.small) ||
    !Number.isSafeInteger(blinds.big) ||
    blinds.small <= 0 ||
    blinds.big < blinds.small
  ) {
    throw new Error("盲注要是正整数，大盲不小于小盲");
  }
  const buttonIndex = seats.findIndex((seat) => seat.id === button);
  if (buttonIndex < 0) throw new Error("按钮不在桌上");

  const deck = shuffledDeck(seed);
  const preflop: Extract<Phase, { kind: "betting" }> = {
    kind: "betting",
    street: "preflop",
    pending: [],
    actedAt: new Map(),
    currentBet: blinds.big,
    minRaise: blinds.big,
  };
  const state: HandState = {
    seed,
    button,
    blinds: { small: blinds.small, big: blinds.big },
    seats: seats.map((seat) => ({
      id: seat.id,
      stack: seat.stack,
      committed: 0,
      contributed: 0,
      status: "active",
      hole: [deck.shift() as Card, deck.shift() as Card],
    })),
    deck,
    board: [],
    phase: preflop,
    events: [],
  };

  // 两人桌按钮就是小盲，翻前先说话、翻后后说话。
  const sbIndex = seats.length === 2 ? buttonIndex : (buttonIndex + 1) % seats.length;
  const bbIndex = (sbIndex + 1) % seats.length;
  for (const [index, amount] of [
    [sbIndex, blinds.small],
    [bbIndex, blinds.big],
  ] as const) {
    const seat = state.seats[index] as Seat;
    const put = putChips(seat, amount);
    state.events.push({ kind: "blind", seatId: seat.id, amount: put });
  }
  // 大盲排在最后，前面的人都只跟不加时大盲还有一次 option。
  preflop.pending = activeAfter(state, bbIndex);
  return advance(state);
}

export function legalActions(state: HandState, seatId: SeatId): LegalActions {
  const phase = state.phase;
  if (phase.kind === "complete") return { kind: "complete" };
  const toAct = phase.pending[0] as SeatId;
  if (toAct !== seatId) return { kind: "waiting", toAct };

  const seat = seatOf(state, seatId);
  const toCall = betToMatch(state, phase, seat) - seat.committed;
  const options: ActionOption[] = [{ kind: "fold" }];
  options.push(toCall === 0 ? { kind: "check" } : { kind: "call", amount: Math.min(toCall, seat.stack) });

  const opponentCanRespond = state.seats.some((other) => other.id !== seatId && other.status === "active");
  const actedAt = phase.actedAt.get(seatId);
  const reopened = actedAt === undefined || phase.currentBet - actedAt >= phase.minRaise;
  const canRaise = opponentCanRespond && reopened && seat.stack > toCall;
  const max = seat.committed + seat.stack;
  const min = phase.currentBet + phase.minRaise;
  if (canRaise && max >= min) options.push({ kind: "raise", min, max });
  if (canRaise || seat.stack <= toCall) options.push({ kind: "all_in", amount: seat.stack });
  return { kind: "your_turn", street: phase.street, toCall, options };
}

export function apply(state: HandState, seatId: SeatId, action: Action): HandState {
  const legal = legalActions(state, seatId);
  if (legal.kind === "complete") throw new Error("这手牌已经结束了");
  if (legal.kind === "waiting") throw new Error(`还没轮到你，现在该 ${legal.toAct} 说话`);
  const option = legal.options.find((candidate) => candidate.kind === action.kind);
  if (option === undefined) throw new Error(REFUSALS[action.kind]);
  if (option.kind === "raise" && action.kind === "raise") {
    if (!Number.isSafeInteger(action.amount)) throw new Error("加注额要是整数");
    if (action.amount < option.min) throw new Error(`加注额不够，最少要加到 ${option.min}`);
    if (action.amount > option.max) throw new Error(`筹码不够，最多只能加到 ${option.max}`);
  }

  const next = structuredClone(state);
  const phase = next.phase as Extract<Phase, { kind: "betting" }>;
  const seat = seatOf(next, seatId);
  const logged: Action = action.kind === "raise" ? { kind: "raise", amount: action.amount } : { kind: action.kind };
  const target =
    logged.kind === "raise"
      ? logged.amount
      : logged.kind === "all_in"
        ? seat.committed + seat.stack
        : seat.committed + legal.toCall;
  const put = logged.kind === "fold" ? 0 : putChips(seat, target - seat.committed);
  if (logged.kind === "fold") seat.status = "folded";
  next.events.push({ kind: "action", seatId, action: logged, put });

  const raisedBy = seat.committed - phase.currentBet;
  if (raisedBy > 0) {
    // 不足一个完整加注的全下不改最小加注增量，也不直接重开加注；几次累计够了由 actedAt 逐人判断。
    if (raisedBy >= phase.minRaise) phase.minRaise = raisedBy;
    phase.currentBet = seat.committed;
    phase.pending = activeAfter(next, next.seats.indexOf(seat)).filter((id) => id !== seatId);
  } else {
    phase.pending = phase.pending.filter((id) => id !== seatId);
  }
  if (logged.kind !== "fold") phase.actedAt.set(seatId, phase.currentBet);
  return advance(next);
}

/** 从种子、开局参数和事件日志重建状态；日志里的每一条都要和重放出来的对上。 */
export function replay(
  seed: string,
  seats: readonly SeatInput[],
  button: SeatId,
  blinds: Blinds,
  events: readonly Event[],
): HandState {
  let state = newHand(seed, seats, button, blinds);
  for (const event of events) {
    if (event.kind === "action") state = apply(state, event.seatId, event.action);
  }
  if (JSON.stringify(state.events) !== JSON.stringify(events)) throw new Error("事件日志和重放结果对不上");
  return state;
}

/** 按投入分层：每一层只有投入够到这一层的未弃牌座位有份，同牌力平分，零头从按钮之后第一位起一人一个。 */
export function settle(state: HandState): Award[] {
  const live = state.seats.filter((seat) => seat.status !== "folded");
  const levels = [...new Set(live.map((seat) => seat.contributed))].toSorted((a, b) => a - b);
  const total = state.seats.reduce((sum, seat) => sum + seat.contributed, 0);
  const hands = new Map<SeatId, PokerHandValue>(
    live.map((seat) => [seat.id, evaluatePokerHand(seat.hole, state.board)]),
  );

  const pots: { amount: number; eligible: Seat[] }[] = [];
  let floor = 0;
  for (const level of levels) {
    const amount = state.seats.reduce(
      (sum, seat) => sum + Math.min(Math.max(seat.contributed - floor, 0), level - floor),
      0,
    );
    pots.push({ amount, eligible: live.filter((seat) => seat.contributed >= level) });
    floor = level;
  }
  // 弃牌者投入超过所有未弃牌者的部分（理论上走不到）并进最上一层，筹码不凭空消失。
  const last = pots[pots.length - 1];
  if (last !== undefined) last.amount += total - pots.reduce((sum, pot) => sum + pot.amount, 0);

  const order = seatsFromButton(state);
  const awards: Award[] = [];
  pots.forEach((pot, index) => {
    if (pot.amount === 0) return;
    const winners = pot.eligible
      .filter((seat) =>
        pot.eligible.every(
          (other) =>
            comparePokerHands(hands.get(seat.id) as PokerHandValue, hands.get(other.id) as PokerHandValue) >= 0,
        ),
      )
      .toSorted((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    const share = Math.floor(pot.amount / winners.length);
    const oddChips = pot.amount % winners.length;
    winners.forEach((winner, rank) => {
      awards.push({ seatId: winner.id, amount: share + (rank < oddChips ? 1 : 0), pot: index });
    });
  });
  return awards;
}

const REFUSALS: Record<Action["kind"], string> = {
  fold: "现在不能弃牌",
  check: "有人下注了，不能过牌，要跟注或弃牌",
  call: "没人下注，不能跟注，可以过牌",
  raise: "现在不能加注",
  all_in: "现在不能全下，已经表过态的人只能跟注或弃牌",
};

function seatOf(state: HandState, seatId: SeatId): Seat {
  const seat = state.seats.find((candidate) => candidate.id === seatId);
  if (seat === undefined) throw new Error(`桌上没有座位 ${seatId}`);
  return seat;
}

function putChips(seat: Seat, amount: number): number {
  const put = Math.min(amount, seat.stack);
  seat.stack -= put;
  seat.committed += put;
  seat.contributed += put;
  if (seat.stack === 0) seat.status = "all_in";
  return put;
}

/**
 * 这个座位要跟到的总额。还有别人能回应时就是本街下注额，短大盲全下也照名义大盲算；
 * 别人都全下或弃了时，只用跟到其余未弃牌者的最高投入，没人能匹配的那部分不算欠。
 */
function betToMatch(state: HandState, phase: Extract<Phase, { kind: "betting" }>, seat: Seat): number {
  const others = state.seats.filter((other) => other !== seat && other.status !== "folded");
  if (others.some((other) => other.status === "active")) return phase.currentBet;
  return Math.max(0, ...others.map((other) => other.committed));
}

/** 从按钮之后第一位开始绕一圈，按钮在最后。 */
function seatsFromButton(state: HandState): SeatId[] {
  const index = state.seats.findIndex((seat) => seat.id === state.button);
  return state.seats.map((_, offset) => (state.seats[(index + 1 + offset) % state.seats.length] as Seat).id);
}

/** 从 index 之后第一位开始绕一圈，还能说话的座位。 */
function activeAfter(state: HandState, index: number): SeatId[] {
  const count = state.seats.length;
  return state.seats
    .map((_, offset) => state.seats[(index + 1 + offset) % count] as Seat)
    .filter((seat) => seat.status === "active")
    .map((seat) => seat.id);
}

const NEXT_STREET: Record<Street, { street: Exclude<Street, "preflop">; cards: number } | null> = {
  preflop: { street: "flop", cards: 3 },
  flop: { street: "turn", cards: 1 },
  turn: { street: "river", cards: 1 },
  river: null,
};

/** 动作落定后推进：只剩一人直接收池，本街没人要说话就发下一街，没人能再下注就一路发到河牌摊牌。 */
function advance(state: HandState): HandState {
  for (;;) {
    const phase = state.phase;
    if (phase.kind === "complete") return state;

    const live = state.seats.filter((seat) => seat.status !== "folded");
    if (live.length === 1) {
      const winner = live[0] as Seat;
      const pot = state.seats.reduce((sum, seat) => sum + seat.contributed, 0);
      return finish(state, "fold", [{ seatId: winner.id, amount: pot, pot: 0 }]);
    }

    const active = state.seats.filter((seat) => seat.status === "active");
    phase.pending = phase.pending.filter((id) => {
      const seat = seatOf(state, id);
      if (seat.status !== "active") return false;
      // 对手全都全下或弃了、自己也不欠钱，就没有再说话的必要。
      return active.length > 1 || seat.committed < betToMatch(state, phase, seat);
    });
    if (phase.pending.length > 0) return state;

    for (const seat of state.seats) seat.committed = 0;
    const next = NEXT_STREET[phase.street];
    if (next === null) {
      for (const id of seatsFromButton(state)) {
        const seat = seatOf(state, id);
        if (seat.status !== "folded") state.events.push({ kind: "showdown", seatId: id, hole: [...seat.hole] });
      }
      return finish(state, "showdown", settle(state));
    }
    const cards = state.deck.splice(0, next.cards);
    state.board.push(...cards);
    state.events.push({ kind: "street", street: next.street, cards });
    const buttonIndex = state.seats.findIndex((seat) => seat.id === state.button);
    state.phase = {
      kind: "betting",
      street: next.street,
      pending: activeAfter(state, buttonIndex),
      actedAt: new Map(),
      currentBet: 0,
      minRaise: state.blinds.big,
    };
  }
}

function finish(state: HandState, ending: "fold" | "showdown", awards: Award[]): HandState {
  for (const award of awards) {
    seatOf(state, award.seatId).stack += award.amount;
    state.events.push({ kind: "award", ...award });
  }
  state.phase = { kind: "complete", ending, awards };
  return state;
}
