import {
  BotId,
  GroupId,
  Message,
  MessageId,
  POKER_PERSONAS,
  PokerHandId,
  PokerSessionId,
  PokerTableView,
  type PokerAction,
  type PokerAward,
  type PokerCard,
  type PokerEvent,
  type PokerPersona,
  type PokerReview,
  type PokerSeatView,
  type PokerStats,
  type PokerStreet,
  type ServerPush,
  type Viewer,
} from "@baize/shared";
import { currentGeneration, messagesByGroupId, nextSuffix, user } from "./store.js";

// 牌桌的 mock：一手固定的剧本，照原型 HAND 的四步（翻牌前、翻牌、转牌、河牌）。
// 你坐 4 号位按钮，拿 A♠ K♦，1 号位拿 K♥ Q♣，河牌摊牌你的踢脚大。牌友的回应排成任务队，
// 每次只跑队头一条，和控制面「牌友一回合一条动作」同一个节奏；每条之后桌子版本加一。
// 视图只拼你看得到的东西：对手底牌只在摊牌那一刻随 showdown 事件公开。

export const POKER_START_STACK = 2000;
export const POKER_BLINDS = { small: 10, big: 20 } as const;
export const POKER_BOT_DEADLINE_MS = 60_000;

type SeatNo = 1 | 2 | 3 | 4;
type BotSeatNo = 1 | 2 | 3;
const USER_SEAT: SeatNo = 4;
const SEAT_NOS: readonly SeatNo[] = [1, 2, 3, 4];
const HOST_PERSONA: PokerPersona = "laobai";
const DEFAULT_PERSONAS: Record<BotSeatNo, PokerPersona> = { 1: "leopard", 2: "jasmine", 3: "dalu" };

// 牌友回合的间隔：数字是每条动作隔多少毫秒，null 是挂起，等测试入口 tick 才走。
export const pokerTiming: { botTurnMs: number | null } = { botTurnMs: 600 };

const HOLE: Record<SeatNo, readonly [PokerCard, PokerCard]> = {
  1: ["Kh", "Qc"],
  2: ["7d", "2c"],
  3: ["Jc", "Td"],
  4: ["As", "Kd"],
};
const BOARD: readonly PokerCard[] = ["Ks", "9h", "4c", "2d", "7s"];
type LaterStreet = Exclude<PokerStreet, "preflop">;
const STREET_CARDS: Record<LaterStreet, readonly [number, number]> = { flop: [0, 3], turn: [3, 4], river: [4, 5] };
const NEXT_STREET: Record<PokerStreet, LaterStreet | null> = {
  preflop: "flop",
  flop: "turn",
  turn: "river",
  river: null,
};
const STREET_NAME: Record<PokerStreet, string> = { preflop: "翻牌前", flop: "翻牌", turn: "转牌", river: "河牌" };
const POSITION: Record<SeatNo, PokerSeatView["position"]> = {
  1: "small_blind",
  2: "big_blind",
  3: "under_the_gun",
  4: "button",
};
// 引擎 describeHand 对这手牌的输出，按公共牌张数查（scratch 脚本拿真引擎逐步对过）。
const SUMMARY_BY_BOARD: Record<number, string> = { 0: "A K 不同花", 3: "一对 K", 4: "一对 K", 5: "一对 K" };
// 摊牌时谁的牌大，前面的赢。整个剧本里到得了摊牌的只有 4 号和 1 号，其余两家只为分层结算兜底。
const STRENGTH_ORDER: readonly SeatNo[] = [4, 1, 2, 3];

const SUITS: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };
const cardText = (card: PokerCard): string =>
  `${card.startsWith("T") ? "10" : card.charAt(0)}${SUITS[card.charAt(1)] ?? ""}`;
const cardsText = (cards: readonly PokerCard[]): string => cards.map(cardText).join(" ");

export class PokerMockError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "PokerMockError";
    this.status = status;
  }
}

type Emit = (event: ServerPush) => void;

type HandSeat = {
  no: SeatNo;
  stack: number;
  committed: number;
  contributed: number;
  status: "active" | "folded" | "all_in";
};

type Move = "fold" | "check" | "call" | { raise: number };

// play、hint、review 是要等一拍才发生的，close 是收一条街，前一条跑完当场接着跑。
type Job =
  | { kind: "play"; seat: BotSeatNo; move: Move; say: string | null }
  | { kind: "close" }
  | { kind: "hint"; seq: number }
  | { kind: "review" };

type MockHand = {
  id: PokerHandId;
  number: number;
  startStacks: Record<SeatNo, number>;
  seats: HandSeat[];
  board: PokerCard[];
  events: PokerEvent[];
  street: PokerStreet | "complete";
  currentBet: number;
  minRaise: number;
  awards: PokerAward[] | null;
  deadline: string | null;
  userFoldStreet: PokerStreet | null;
};

type TableSeat = { seat: SeatNo; persona: PokerPersona | null; stack: number };

type HandRecord = {
  number: number;
  delta: number;
  foldStreet: PokerStreet | null;
  opponent: string;
};

type Session = { id: PokerSessionId; handCount: number; net: number; records: HandRecord[] };

// 最近一场散场后复盘的去向：老白写完之前正文先攥在这里，写好了才落到 lastReview。
type ReviewJob = { sessionId: PokerSessionId; status: "generating" | "failed"; review: PokerReview };

export type MockPokerTable = {
  groupId: GroupId;
  requestId: string;
  seats: TableSeat[];
  version: number;
  session: Session | null;
  hand: MockHand | null;
  handCount: number;
  jobs: Job[];
  hint: PokerTableView["hint"];
  lastReview: PokerReview | null;
  reviewJob: ReviewJob | null;
  stats: PokerStats;
  timer: ReturnType<typeof setTimeout> | null;
};

export const pokerTables = new Map<string, MockPokerTable>();
let tablesGeneration = -1;

const dropTables = (): void => {
  for (const table of pokerTables.values()) if (table.timer !== null) clearTimeout(table.timer);
  pokerTables.clear();
  pokerTiming.botTurnMs = 600;
};

// reseed 推进代数，牌桌跟着清；不用改 seed.ts，也不会留下上一条用例的定时器。
const fresh = (): void => {
  if (tablesGeneration === currentGeneration()) return;
  dropTables();
  tablesGeneration = currentGeneration();
};

export const resetPoker = (): void => {
  dropTables();
  tablesGeneration = currentGeneration();
};

export const pokerTableList = (): MockPokerTable[] => {
  fresh();
  return [...pokerTables.values()];
};

export const pokerTableOf = (groupId: string): MockPokerTable | null => {
  fresh();
  return pokerTables.get(groupId) ?? null;
};

export const pokerTableOfHand = (handId: string): MockPokerTable | null =>
  pokerTableList().find((table) => table.hand?.id === handId) ?? null;

const botIdOf = (persona: PokerPersona): BotId => BotId.parse(`bot_poker_${persona}`);
const engineSeatIdOf = (no: SeatNo): string => `s${no}`;
const seatNoOf = (seatId: string): SeatNo => {
  const found = SEAT_NOS.find((no) => engineSeatIdOf(no) === seatId);
  if (found === undefined) throw new Error(`mock 里没有座位 ${seatId}`);
  return found;
};

const personaAt = (table: MockPokerTable, no: SeatNo): PokerPersona | null =>
  table.seats.find((seat) => seat.seat === no)?.persona ?? null;
const seatName = (table: MockPokerTable, no: SeatNo): string => {
  const persona = personaAt(table, no);
  return persona === null ? user.name : POKER_PERSONAS[persona].name;
};

const handSeat = (hand: MockHand, no: SeatNo): HandSeat => {
  const seat = hand.seats.find((candidate) => candidate.no === no);
  if (seat === undefined) throw new Error(`mock 牌手里没有 ${no} 号位`);
  return seat;
};
const potOf = (hand: MockHand): number => hand.seats.reduce((sum, seat) => sum + seat.contributed, 0);
const isLive = (seat: HandSeat): boolean => seat.status !== "folded";

// 谁在说话：队头是牌友的出牌就是它，否则轮到你，一手结束没人。
const toActOf = (table: MockPokerTable): SeatNo | null => {
  const hand = table.hand;
  if (hand === null || hand.street === "complete") return null;
  const head = table.jobs[0];
  return head?.kind === "play" ? head.seat : USER_SEAT;
};

const post = (
  table: MockPokerTable,
  persona: PokerPersona,
  text: string,
  emit: Emit,
  visibleTo?: Viewer[],
): Message => {
  const message = Message.parse({
    id: MessageId.parse(`msg_poker_${nextSuffix()}`),
    groupId: table.groupId,
    body: { kind: "bot", botId: botIdOf(persona), text, streaming: false },
    createdAt: new Date().toISOString(),
    revision: 0,
    visibleTo: visibleTo ?? null,
  });
  const list = messagesByGroupId.get(table.groupId);
  if (list === undefined) messagesByGroupId.set(table.groupId, [message]);
  else list.push(message);
  emit({ type: "message", message });
  return message;
};

const hostSays = (table: MockPokerTable, text: string, emit: Emit): void => {
  post(table, HOST_PERSONA, text, emit);
};

const legalOf = (table: MockPokerTable, hand: MockHand): PokerSeatView["legal"] => {
  if (hand.street === "complete") return { kind: "complete" };
  const toAct = toActOf(table);
  if (toAct !== USER_SEAT) return { kind: "waiting", toAct: engineSeatIdOf(toAct ?? USER_SEAT) };
  const me = handSeat(hand, USER_SEAT);
  const toCall = hand.currentBet - me.committed;
  const options: Extract<PokerSeatView["legal"], { kind: "your_turn" }>["options"] = [{ kind: "fold" }];
  options.push(toCall === 0 ? { kind: "check" } : { kind: "call", amount: Math.min(toCall, me.stack) });
  const canRaise = hand.seats.some((seat) => seat.no !== USER_SEAT && seat.status === "active") && me.stack > toCall;
  const max = me.committed + me.stack;
  const min = hand.currentBet + hand.minRaise;
  if (canRaise && max >= min) options.push({ kind: "raise", min, max });
  if (canRaise || me.stack <= toCall) options.push({ kind: "all_in", amount: me.stack });
  return { kind: "your_turn", street: hand.street, toCall, options };
};

const seatViewOf = (table: MockPokerTable, hand: MockHand): PokerSeatView => {
  const me = handSeat(hand, USER_SEAT);
  const shown = new Map(
    hand.events.flatMap((event) => (event.kind === "showdown" ? [[event.seatId, event.hole] as const] : [])),
  );
  return structuredClone({
    seatId: engineSeatIdOf(USER_SEAT),
    position: POSITION[USER_SEAT],
    hole: HOLE[USER_SEAT],
    stack: me.stack,
    summary: `你在按钮位，${SUMMARY_BY_BOARD[hand.board.length] ?? "A K 不同花"}`,
    street: hand.street,
    board: hand.board,
    pot: potOf(hand),
    blinds: POKER_BLINDS,
    seats: hand.seats.map((seat) => ({
      seatId: engineSeatIdOf(seat.no),
      position: POSITION[seat.no],
      stack: seat.stack,
      committed: seat.committed,
      status: seat.status,
      shown: shown.get(engineSeatIdOf(seat.no)) ?? null,
    })),
    legal: legalOf(table, hand),
    awards: hand.awards,
    events: hand.events,
  });
};

const reviewStateOf = (table: MockPokerTable): PokerTableView["reviewState"] => {
  if (table.reviewJob !== null) return { sessionId: table.reviewJob.sessionId, status: table.reviewJob.status };
  return table.lastReview === null ? null : { sessionId: table.lastReview.sessionId, status: "done" };
};

// 用户视角的整张桌，过一遍 shared 的 schema：mock 吐出去的形状和控制面是同一份。
export const pokerView = (table: MockPokerTable): PokerTableView => {
  const hand = table.hand;
  const host = POKER_PERSONAS[HOST_PERSONA];
  return PokerTableView.parse({
    groupId: table.groupId,
    status: hand !== null && hand.street !== "complete" ? "in_hand" : "idle",
    version: table.version,
    seats: table.seats.map(({ seat, persona, stack }) => {
      const engineSeatId = engineSeatIdOf(seat);
      if (persona === null) {
        return {
          seat,
          engineSeatId,
          kind: "user",
          botId: null,
          name: user.name,
          persona: null,
          hue: "lime",
          shape: "pillow",
          stack,
        };
      }
      const card = POKER_PERSONAS[persona];
      return {
        seat,
        engineSeatId,
        kind: "bot",
        botId: botIdOf(persona),
        name: card.name,
        persona,
        hue: card.hue,
        shape: card.shape,
        stack,
      };
    }),
    host: { botId: botIdOf(HOST_PERSONA), name: host.name, hue: host.hue, shape: host.shape },
    session:
      table.session === null
        ? null
        : { id: table.session.id, handCount: table.session.handCount, net: table.session.net },
    hand:
      hand === null
        ? null
        : {
            id: hand.id,
            number: hand.number,
            version: hand.events.length,
            toAct: toActOf(table),
            deadline: hand.deadline,
            view: seatViewOf(table, hand),
          },
    hint: table.hint,
    lastReview: table.lastReview,
    reviewState: reviewStateOf(table),
    stats: table.stats,
  });
};

const putChips = (seat: HandSeat, amount: number): number => {
  const put = Math.max(0, Math.min(amount, seat.stack));
  seat.stack -= put;
  seat.committed += put;
  seat.contributed += put;
  if (seat.stack === 0) seat.status = "all_in";
  return put;
};

const applyAction = (hand: MockHand, no: SeatNo, action: PokerAction): void => {
  const seat = handSeat(hand, no);
  let put = 0;
  if (action.kind === "fold") seat.status = "folded";
  else if (action.kind === "call") put = putChips(seat, hand.currentBet - seat.committed);
  else if (action.kind === "raise") put = putChips(seat, action.amount - seat.committed);
  else if (action.kind === "all_in") put = putChips(seat, seat.stack);
  const raisedBy = seat.committed - hand.currentBet;
  if (raisedBy > 0) {
    if (raisedBy >= hand.minRaise) hand.minRaise = raisedBy;
    hand.currentBet = seat.committed;
  }
  hand.events.push({ kind: "action", seatId: engineSeatIdOf(no), action, put });
};

const deal = (table: MockPokerTable, hand: MockHand, street: LaterStreet, emit: Emit): void => {
  const [from, to] = STREET_CARDS[street];
  const cards = BOARD.slice(from, to);
  for (const seat of hand.seats) seat.committed = 0;
  hand.currentBet = 0;
  hand.minRaise = POKER_BLINDS.big;
  hand.board.push(...cards);
  hand.street = street;
  hand.events.push({ kind: "street", street, cards });
  hostSays(table, `${STREET_NAME[street]} ${cardsText(cards)}。`, emit);
};

// 按投入分层，每层只有投入够到这层的未弃牌座位有份，赢家按 STRENGTH_ORDER 取第一个。
const settleAwards = (hand: MockHand, ending: "fold" | "showdown"): PokerAward[] => {
  const live = hand.seats.filter(isLive);
  const total = potOf(hand);
  const [only] = live;
  if (ending === "fold" && only !== undefined) return [{ seatId: engineSeatIdOf(only.no), amount: total, pot: 0 }];
  const levels = [...new Set(live.map((seat) => seat.contributed))].toSorted((a, b) => a - b);
  const awards: PokerAward[] = [];
  let floor = 0;
  levels.forEach((level, pot) => {
    const amount = hand.seats.reduce(
      (sum, seat) => sum + Math.min(Math.max(seat.contributed - floor, 0), level - floor),
      0,
    );
    const eligible = live.filter((seat) => seat.contributed >= level);
    const winner = STRENGTH_ORDER.find((no) => eligible.some((seat) => seat.no === no));
    if (winner !== undefined && amount > 0) awards.push({ seatId: engineSeatIdOf(winner), amount, pot });
    floor = level;
  });
  const last = awards.at(-1);
  const placed = awards.reduce((sum, award) => sum + award.amount, 0);
  if (last !== undefined && placed < total)
    awards[awards.length - 1] = { ...last, amount: last.amount + total - placed };
  return awards;
};

const finishHand = (table: MockPokerTable, hand: MockHand, ending: "fold" | "showdown", emit: Emit): void => {
  if (ending === "showdown") {
    for (const seat of hand.seats) seat.committed = 0;
    for (const seat of hand.seats.filter(isLive)) {
      hand.events.push({ kind: "showdown", seatId: engineSeatIdOf(seat.no), hole: HOLE[seat.no] });
    }
  }
  const awards = settleAwards(hand, ending);
  for (const award of awards) {
    handSeat(hand, seatNoOf(award.seatId)).stack += award.amount;
    hand.events.push({ kind: "award", ...award });
  }
  hand.awards = awards;
  hand.street = "complete";
  hand.deadline = null;
  table.jobs = table.jobs.filter((job) => job.kind === "review");
  table.hint = null;
  for (const seat of table.seats) seat.stack = handSeat(hand, seat.seat).stack;

  const delta = handSeat(hand, USER_SEAT).stack - hand.startStacks[USER_SEAT];
  if (table.session !== null) {
    table.session.net += delta;
    table.session.records.push({
      number: hand.number,
      delta,
      foldStreet: hand.userFoldStreet,
      opponent: seatName(table, 1),
    });
  }
  if (hand.userFoldStreet !== null) {
    const winner = awards[0] === undefined ? 1 : seatNoOf(awards[0].seatId);
    hostSays(table, `你弃了，${seatName(table, winner)}拿走底池 ${awards[0]?.amount ?? 0}。`, emit);
    return;
  }
  hostSays(
    table,
    `摊牌。${seatName(table, 1)} ${cardsText(HOLE[1])}，你 ${cardsText(HOLE[4])}。都是一对 K，你的踢脚 A 大。`,
    emit,
  );
  hostSays(table, `你赢 ${Math.max(delta, 0)} 筹码。`, emit);
};

const OPENERS: Record<LaterStreet, Job[]> = {
  flop: [
    { kind: "play", seat: 1, move: { raise: 100 }, say: "下 100。" },
    { kind: "play", seat: 3, move: "fold", say: "我不陪了，弃。" },
  ],
  turn: [{ kind: "play", seat: 1, move: "check", say: "过。" }],
  river: [{ kind: "play", seat: 1, move: { raise: 200 }, say: "200。我有 K，你呢？" }],
};

// 收一条街：只剩一人直接收池；河牌或没人能再下注就一路发到摊牌；否则发下一街，牌友先说话。
const closeStreet = (table: MockPokerTable, hand: MockHand, emit: Emit): void => {
  if (hand.street === "complete") return;
  const live = hand.seats.filter(isLive);
  if (live.length === 1) return finishHand(table, hand, "fold", emit);
  const next = NEXT_STREET[hand.street];
  if (next === null || live.filter((seat) => seat.status === "active").length < 2) {
    for (let street = next; street !== null; street = NEXT_STREET[street]) deal(table, hand, street, emit);
    return finishHand(table, hand, "showdown", emit);
  }
  deal(table, hand, next, emit);
  table.jobs.unshift(...OPENERS[next]);
};

const moveAction = (seat: HandSeat, move: Move): PokerAction => {
  if (move === "fold") return { kind: "fold" };
  if (move === "check") return { kind: "check" };
  if (move === "call") return { kind: "call" };
  return move.raise >= seat.committed + seat.stack ? { kind: "all_in" } : { kind: "raise", amount: move.raise };
};

// 队头是收街就当场收，是已经弃牌或全下的座位的出牌就丢掉；剩下要等一拍的留在队头。
const drain = (table: MockPokerTable, emit: Emit): void => {
  const hand = table.hand;
  if (hand === null) return;
  for (;;) {
    const head = table.jobs[0];
    if (head === undefined || hand.street === "complete") return;
    if (head.kind === "close") {
      table.jobs.shift();
      closeStreet(table, hand, emit);
    } else if (head.kind === "play" && handSeat(hand, head.seat).status !== "active") {
      table.jobs.shift();
    } else return;
  }
};

const settleTurn = (table: MockPokerTable, emit: Emit): void => {
  drain(table, emit);
  const hand = table.hand;
  if (hand !== null) {
    const toAct = toActOf(table);
    hand.deadline =
      toAct !== null && toAct !== USER_SEAT ? new Date(Date.now() + POKER_BOT_DEADLINE_MS).toISOString() : null;
  }
  table.version += 1;
};

const HINT_BY_STREET: Record<PokerStreet, (first: string, third: string) => string> = {
  preflop: (first, third) => `A♠ K♦ 是最好的起手牌之一。${first}爱乱加，你加到 180 能把${third}赶走，只剩一个对手。`,
  flop: (first) => `你中了顶对，踢脚是 A，这张牌面上很少有人比你大。跟注让${first}接着诈唬，加注是保护，两样都行。`,
  turn: (first) => `${first}过牌，多半手里的 K 踢脚小，或者什么都没有。下注 150 收一点。`,
  river: (first) => `${first}真有 K 的时候踢脚多半比你小。跟注就够，加注他只会拿更好的牌跟你。`,
};

const hintText = (table: MockPokerTable, street: PokerStreet): string =>
  HINT_BY_STREET[street](seatName(table, 1), seatName(table, 3));

export const pokerHasPendingJob = (table: MockPokerTable): boolean => table.jobs.length > 0;

// 跑队头一条。回 false 是队里已经没有任务。
export const pokerRunNextJob = (table: MockPokerTable, emit: Emit): boolean => {
  const job = table.jobs.shift();
  if (job === undefined) return false;
  const hand = table.hand;
  if (job.kind === "review") {
    if (table.reviewJob !== null) {
      table.lastReview = table.reviewJob.review;
      table.reviewJob = null;
      hostSays(table, "这场的复盘写好了。", emit);
    }
  } else if (job.kind === "hint" && hand !== null && hand.street !== "complete") {
    const message = post(table, HOST_PERSONA, hintText(table, hand.street), emit, [{ kind: "user" }]);
    table.hint = { seq: job.seq, status: "done", messageId: message.id };
  } else if (job.kind === "play" && hand !== null) {
    const seat = handSeat(hand, job.seat);
    if (seat.status === "active" && hand.street !== "complete") {
      applyAction(hand, job.seat, moveAction(seat, job.move));
      const persona = personaAt(table, job.seat);
      if (job.say !== null && persona !== null) post(table, persona, job.say, emit);
    }
  }
  settleTurn(table, emit);
  return true;
};

const pushView = (table: MockPokerTable, emit: Emit): void => {
  emit({ type: "poker_table_updated", table: pokerView(table) });
};

// 排下一拍：队头有活、没挂起、桌子还是这一代的才排。
const schedule = (table: MockPokerTable, emit: Emit): void => {
  if (table.timer !== null) clearTimeout(table.timer);
  table.timer = null;
  const ms = pokerTiming.botTurnMs;
  if (table.jobs.length === 0 || ms === null) return;
  const generation = tablesGeneration;
  table.timer = setTimeout(() => {
    table.timer = null;
    if (generation !== currentGeneration() || pokerTables.get(table.groupId) !== table) return;
    pokerStep(table, emit);
  }, ms);
};

// 跑一拍，推新视图，再排下一拍。路由和测试入口 tick 都走这一条。
export const pokerStep = (table: MockPokerTable, emit: Emit): boolean => {
  const ran = pokerRunNextJob(table, emit);
  if (ran) {
    pushView(table, emit);
    schedule(table, emit);
  }
  return ran;
};

// 变更之后统一收口：推整张桌，排下一拍。
export const pokerPublish = (table: MockPokerTable, emit: Emit): void => {
  pushView(table, emit);
  schedule(table, emit);
};

export const pokerCreateTable = (requestId: string): { table: MockPokerTable; created: boolean } => {
  fresh();
  const existing = [...pokerTables.values()].find((table) => table.requestId === requestId);
  if (existing !== undefined) return { table: existing, created: false };
  const groupId = GroupId.parse(`grp_poker_${nextSuffix()}`);
  const table: MockPokerTable = {
    groupId,
    requestId,
    seats: [
      { seat: 1, persona: DEFAULT_PERSONAS[1], stack: POKER_START_STACK },
      { seat: 2, persona: DEFAULT_PERSONAS[2], stack: POKER_START_STACK },
      { seat: 3, persona: DEFAULT_PERSONAS[3], stack: POKER_START_STACK },
      { seat: 4, persona: null, stack: POKER_START_STACK },
    ],
    version: 1,
    session: null,
    hand: null,
    handCount: 0,
    jobs: [],
    hint: null,
    lastReview: null,
    reviewJob: null,
    stats: { sessions: 0, sessionsWon: 0, net: 0 },
    timer: null,
  };
  pokerTables.set(groupId, table);
  messagesByGroupId.set(groupId, []);
  return { table, created: true };
};

const inHand = (table: MockPokerTable): boolean => table.hand !== null && table.hand.street !== "complete";

export const pokerStartHand = (table: MockPokerTable, emit: Emit): void => {
  if (inHand(table)) throw new PokerMockError(409, "这桌正在打一手");
  for (const seat of table.seats) if (seat.stack <= 0) seat.stack = POKER_START_STACK;
  table.session ??= { id: PokerSessionId.parse(`ses_poker_${nextSuffix()}`), handCount: 0, net: 0, records: [] };
  // 和控制面一样，打着的这手也算进这一场的手数。
  table.session.handCount += 1;
  table.handCount += 1;
  table.hint = null;
  const seats: HandSeat[] = table.seats.map((seat) => ({
    no: seat.seat,
    stack: seat.stack,
    committed: 0,
    contributed: 0,
    status: "active",
  }));
  const hand: MockHand = {
    id: PokerHandId.parse(`hand_${table.groupId}_${table.handCount}`),
    number: table.handCount,
    startStacks: { 1: seats[0]?.stack ?? 0, 2: seats[1]?.stack ?? 0, 3: seats[2]?.stack ?? 0, 4: seats[3]?.stack ?? 0 },
    seats,
    board: [],
    events: [],
    street: "preflop",
    currentBet: POKER_BLINDS.big,
    minRaise: POKER_BLINDS.big,
    awards: null,
    deadline: null,
    userFoldStreet: null,
  };
  for (const [no, amount] of [
    [1, POKER_BLINDS.small],
    [2, POKER_BLINDS.big],
  ] as const) {
    hand.events.push({ kind: "blind", seatId: engineSeatIdOf(no), amount: putChips(handSeat(hand, no), amount) });
  }
  table.hand = hand;
  table.jobs = [{ kind: "play", seat: 3, move: { raise: 60 }, say: "加到 60。" }, ...table.jobs];
  hostSays(table, `新一手。盲注 ${POKER_BLINDS.small}/${POKER_BLINDS.big}，你在 4 号位。`, emit);
  settleTurn(table, emit);
};

const REFUSALS: Record<PokerAction["kind"], string> = {
  fold: "现在不能弃牌",
  check: "有人下注了，不能过牌，要跟注或弃牌",
  call: "没人下注，不能跟注，可以过牌",
  raise: "现在不能加注",
  all_in: "现在不能全下，已经表过态的人只能跟注或弃牌",
};

const describeUserAction = (action: PokerAction, toCall: number, opened: boolean): string => {
  if (action.kind === "fold") return "你弃牌。";
  if (action.kind === "check") return "你过牌。";
  if (action.kind === "call") return `你跟 ${toCall}。`;
  if (action.kind === "all_in") return "你全下。";
  return `你${opened ? "加到" : "下注"} ${action.amount}。`;
};

// 你出牌之后牌友怎么回：翻牌前 1 号跟、2 号大盲弃，你加注 3 号也弃；你弃牌 1、2 号跟着弃；
// 翻牌后你只要加了注 1 号就跟。
const responsesTo = (street: PokerStreet, folded: boolean, raised: boolean): Job[] => {
  if (street !== "preflop") return raised ? [{ kind: "play", seat: 1, move: "call", say: "……跟。" }] : [];
  if (folded) {
    return [
      { kind: "play", seat: 1, move: "fold", say: "不玩，弃了。" },
      { kind: "play", seat: 2, move: "fold", say: "不玩，弃了。" },
    ];
  }
  const calls: Job[] = [
    { kind: "play", seat: 1, move: "call", say: "跟。" },
    { kind: "play", seat: 2, move: "fold", say: "不玩，弃了。" },
  ];
  return raised ? [...calls, { kind: "play", seat: 3, move: "fold", say: "太凶了，我走。" }] : calls;
};

// 牌手的 seq 就是事件日志长度，和控制面一样：对不上说明你看的是旧桌面。
const liveHandOf = (table: MockPokerTable, handId: string, seq: number): MockHand => {
  const hand = table.hand;
  if (hand === null || hand.id !== handId) throw new PokerMockError(404, "没有这手牌");
  if (hand.street === "complete") throw new PokerMockError(409, "这手牌已经结束了");
  if (toActOf(table) !== USER_SEAT) throw new PokerMockError(409, "还没轮到你");
  if (seq !== hand.events.length) throw new PokerMockError(409, "牌桌已经变了，刷新再试");
  return hand;
};

export const pokerUserAct = (
  table: MockPokerTable,
  handId: string,
  request: { seq: number; action: PokerAction },
  emit: Emit,
): void => {
  const hand = liveHandOf(table, handId, request.seq);
  const legal = legalOf(table, hand);
  if (legal.kind !== "your_turn") throw new PokerMockError(409, "还没轮到你");
  const { action } = request;
  const option = legal.options.find((candidate) => candidate.kind === action.kind);
  if (option === undefined) throw new PokerMockError(400, REFUSALS[action.kind]);
  if (option.kind === "raise" && action.kind === "raise") {
    if (action.amount < option.min) throw new PokerMockError(400, `加注额不够，最少要加到 ${option.min}`);
    if (action.amount > option.max) throw new PokerMockError(400, `筹码不够，最多只能加到 ${option.max}`);
  }

  const street = legal.street;
  const betBefore = hand.currentBet;
  applyAction(hand, USER_SEAT, action);
  if (action.kind === "fold") hand.userFoldStreet = street;
  table.hint = null;
  hostSays(table, describeUserAction(action, legal.toCall, betBefore > 0), emit);
  const responses = responsesTo(street, action.kind === "fold", hand.currentBet > betBefore);
  table.jobs = [...responses, { kind: "close" }, ...table.jobs.filter((job) => job.kind === "review")];
  settleTurn(table, emit);
};

// 同一个决策点只出一条提示：已经问过就原样返回，不排第二条。
export const pokerAskHint = (table: MockPokerTable, handId: string, seq: number): void => {
  const hand = liveHandOf(table, handId, seq);
  if (table.hint?.seq === hand.events.length) return;
  table.hint = { seq, status: "waiting", messageId: null };
  table.jobs.unshift({ kind: "hint", seq });
  table.version += 1;
};

export const pokerSwapSeat = (table: MockPokerTable, seat: number, persona: PokerPersona): void => {
  if (seat !== 1 && seat !== 2 && seat !== 3) throw new PokerMockError(400, "只能换 1 到 3 号位的牌友");
  if (inHand(table)) throw new PokerMockError(409, "这手打完再换人");
  const target = table.seats.find((candidate) => candidate.seat === seat);
  if (target === undefined) throw new PokerMockError(404, "没有这个座位");
  if (target.persona === persona) return;
  if (table.seats.some((candidate) => candidate.persona === persona)) {
    throw new PokerMockError(409, "这位牌友已经在桌上了");
  }
  target.persona = persona;
  table.version += 1;
};

const reviewOf = (session: Session): PokerReview => {
  const picked = session.records
    .toSorted((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.number - b.number)
    .slice(0, 3)
    .toSorted((a, b) => a.number - b.number);
  return {
    sessionId: session.id,
    hands: picked.map((record) => ({
      number: record.number,
      title: `第 ${record.number} 手`,
      text:
        record.foldStreet === null
          ? `A♠ K♦ 一路打到河牌摊牌，净赢 ${Math.max(record.delta, 0)} 筹码。${record.opponent}亮的是 K♥ Q♣，踢脚比你小。`
          : `你在${STREET_NAME[record.foldStreet]}弃了牌，${record.delta < 0 ? `亏了 ${-record.delta} 筹码` : "没亏筹码"}。`,
    })),
  };
};

// 散场：这一场记进战绩，复盘是老白写的，排成一个任务，晚一拍才到。
export const pokerLeave = (table: MockPokerTable, emit: Emit): void => {
  if (inHand(table)) throw new PokerMockError(409, "这手打完才能散场");
  const session = table.session;
  if (session === null) throw new PokerMockError(409, "没有打着的一场");
  table.stats = {
    sessions: table.stats.sessions + 1,
    sessionsWon: table.stats.sessionsWon + (session.net > 0 ? 1 : 0),
    net: table.stats.net + session.net,
  };
  table.session = null;
  table.hint = null;
  table.reviewJob = { sessionId: session.id, status: "generating", review: reviewOf(session) };
  table.jobs.push({ kind: "review" });
  hostSays(table, "这场散了，复盘稍后给你。", emit);
  table.version += 1;
};

// 测试入口：把正在写的复盘弄失败，和控制面老白的 run 失败是同一个状态。
export const pokerFailReview = (table: MockPokerTable): void => {
  const job = table.reviewJob;
  if (job === null || job.status !== "generating") throw new PokerMockError(409, "没有正在写的复盘");
  table.jobs = table.jobs.filter((pending) => pending.kind !== "review");
  job.status = "failed";
  table.version += 1;
};

// 重试复盘只认最近一场：正在写的回现状，已写好的什么都不做，失败的重新排一条复盘任务。
export const pokerRetryReview = (table: MockPokerTable, sessionId: PokerSessionId, emit: Emit): void => {
  const job = table.reviewJob;
  if (job === null) {
    if (table.lastReview?.sessionId === sessionId) return;
    throw new PokerMockError(409, "只能重试最近一场的复盘");
  }
  if (job.sessionId !== sessionId) throw new PokerMockError(409, "只能重试最近一场的复盘");
  if (job.status === "generating") return;
  job.status = "generating";
  table.jobs.push({ kind: "review" });
  hostSays(table, "我再写一遍这场的复盘。", emit);
  table.version += 1;
};
