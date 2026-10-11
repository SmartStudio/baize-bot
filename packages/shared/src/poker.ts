import { z } from "zod";
import { BotHue, BotId, GroupId, MessageId, Timestamp } from "./domain.js";

// 牌局的对外形状。引擎（control-plane/src/poker）是一手牌的纯函数，这里是它的 zod 镜像加上
// 桌子、会话、复盘这些引擎之外的对象。镜像必须和引擎的 SeatView 一字不差：
// control-plane/src/poker/wire.ts 用类型相等断言钉着，任一边多一个字段编译就红。

export const PokerSessionId = z.string().min(1).brand<"PokerSessionId">();
export type PokerSessionId = z.infer<typeof PokerSessionId>;
export const PokerHandId = z.string().min(1).brand<"PokerHandId">();
export type PokerHandId = z.infer<typeof PokerHandId>;

/** 桌上的座位号。你固定坐 4 号位（D22），1 到 3 号是牌友。 */
export const PokerSeatNo = z.number().int().min(1).max(4);
export type PokerSeatNo = z.infer<typeof PokerSeatNo>;

export const POKER_RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"] as const;
export const POKER_SUITS = ["s", "h", "d", "c"] as const;
/** 两个字符，点数在前花色在后，例如 "As"、"Td"。和引擎 cards.ts 的 Card 同构。 */
export type PokerCard = `${(typeof POKER_RANKS)[number]}${(typeof POKER_SUITS)[number]}`;
const CARD_PATTERN = /^[2-9TJQKA][shdc]$/;
export const PokerCard = z.string().refine((card): card is PokerCard => CARD_PATTERN.test(card), "不是一张牌");

/** 引擎里的座位 id 是任意字符串，视图里照样带，桌子那一层才把它对回座位号。 */
export const PokerEngineSeatId = z.string();

export const PokerPosition = z.enum(["button", "small_blind", "big_blind", "under_the_gun", "middle", "cutoff"]);
export type PokerPosition = z.infer<typeof PokerPosition>;
export const PokerSeatStatus = z.enum(["active", "folded", "all_in"]);
export type PokerSeatStatus = z.infer<typeof PokerSeatStatus>;
export const PokerStreet = z.enum(["preflop", "flop", "turn", "river"]);
export type PokerStreet = z.infer<typeof PokerStreet>;

export const PokerBlinds = z.object({ small: z.number().int(), big: z.number().int() }).readonly();
export type PokerBlinds = z.infer<typeof PokerBlinds>;

/** raise 的 amount 是本街加到的总额，不是增量。 */
// 联合整体 .readonly()：Readonly 对联合是逐成员分配的，和引擎每个成员都带 readonly 的写法等价。
export const PokerAction = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("fold") }),
    z.object({ kind: z.literal("check") }),
    z.object({ kind: z.literal("call") }),
    z.object({ kind: z.literal("raise"), amount: z.number().int() }),
    z.object({ kind: z.literal("all_in") }),
  ])
  .readonly();
export type PokerAction = z.infer<typeof PokerAction>;

export const PokerAward = z
  .object({ seatId: PokerEngineSeatId, amount: z.number().int(), pot: z.number().int() })
  .readonly();
export type PokerAward = z.infer<typeof PokerAward>;

const HoleCards = z.tuple([PokerCard, PokerCard]).readonly();

/** 引擎的事件日志，只有公开的事：没有发牌，底牌只在摊牌时作为 showdown 出现。 */
export const PokerEvent = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("blind"), seatId: PokerEngineSeatId, amount: z.number().int() }),
    z.object({ kind: z.literal("action"), seatId: PokerEngineSeatId, action: PokerAction, put: z.number().int() }),
    z.object({
      kind: z.literal("street"),
      street: PokerStreet.exclude(["preflop"]),
      cards: z.array(PokerCard).readonly(),
    }),
    z.object({ kind: z.literal("showdown"), seatId: PokerEngineSeatId, hole: HoleCards }),
    z.object({ kind: z.literal("award"), seatId: PokerEngineSeatId, amount: z.number().int(), pot: z.number().int() }),
  ])
  .readonly();
export type PokerEvent = z.infer<typeof PokerEvent>;

export const PokerActionOption = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("fold") }),
    z.object({ kind: z.literal("check") }),
    z.object({ kind: z.literal("call"), amount: z.number().int() }),
    z.object({ kind: z.literal("raise"), min: z.number().int(), max: z.number().int() }),
    z.object({ kind: z.literal("all_in"), amount: z.number().int() }),
  ])
  .readonly();
export type PokerActionOption = z.infer<typeof PokerActionOption>;

// your_turn.options 在引擎里是可变数组，镜像照抄，不加 readonly。
export const PokerLegalActions = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("complete") }),
    z.object({ kind: z.literal("waiting"), toAct: PokerEngineSeatId }),
    z.object({
      kind: z.literal("your_turn"),
      street: PokerStreet,
      toCall: z.number().int(),
      options: z.array(PokerActionOption),
    }),
  ])
  .readonly();
export type PokerLegalActions = z.infer<typeof PokerLegalActions>;

export const PokerOtherSeatView = z
  .object({
    seatId: PokerEngineSeatId,
    position: PokerPosition,
    stack: z.number().int(),
    committed: z.number().int(),
    status: PokerSeatStatus,
    shown: HoleCards.nullable(),
  })
  .readonly();
export type PokerOtherSeatView = z.infer<typeof PokerOtherSeatView>;

/** 某个座位能看到的一手牌：公开信息加它自己的底牌。没有种子，没有别人的底牌。 */
export const PokerSeatView = z
  .object({
    seatId: PokerEngineSeatId,
    position: PokerPosition,
    hole: HoleCards,
    stack: z.number().int(),
    summary: z.string(),
    street: z.union([PokerStreet, z.literal("complete")]),
    board: z.array(PokerCard).readonly(),
    pot: z.number().int(),
    blinds: PokerBlinds,
    seats: z.array(PokerOtherSeatView).readonly(),
    legal: PokerLegalActions,
    awards: z.array(PokerAward).readonly().nullable(),
    events: z.array(PokerEvent).readonly(),
  })
  .readonly();
export type PokerSeatView = z.infer<typeof PokerSeatView>;

// 预置牌友五个加解说老白（D26），不开放自定义。长文案在运行器，这里只有牌桌上要画的那几样。
export const PokerPersona = z.enum(["leopard", "old_k", "jasmine", "dalu", "xiaoqi", "laobai"]);
export type PokerPersona = z.infer<typeof PokerPersona>;

export type PokerPersonaCard = {
  readonly name: string;
  readonly tags: readonly string[];
  readonly hue: BotHue;
  readonly line: string;
};

export const POKER_PERSONAS: Readonly<Record<PokerPersona, PokerPersonaCard>> = {
  leopard: { name: "阿豹", tags: ["牌友"], hue: "coral", line: "手里有牌就打，话不多，加注很干脆。" },
  old_k: { name: "老K", tags: ["牌友"], hue: "violet", line: "老江湖，爱算牌，说话慢条斯理，偶尔诈一手。" },
  jasmine: { name: "茉莉", tags: ["牌友"], hue: "pink", line: "打得稳，不跟没把握的牌，赢了会轻轻说一句。" },
  dalu: { name: "大刘", tags: ["牌友"], hue: "tangerine", line: "大嗓门，爱跟注，输了也乐呵。" },
  xiaoqi: { name: "小七", tags: ["牌友"], hue: "mint", line: "新手气盛，常常全下，运气时好时坏。" },
  laobai: { name: "老白", tags: ["解说"], hue: "sky", line: "不入座，报牌报底池，你问才答。" },
} as const;

/** 牌桌 prompt 里 Bot 扮演的角色：牌友出牌、老白解答、老白复盘。 */
export const PokerTableRole = z.enum(["player", "advisor", "reviewer"]);
export type PokerTableRole = z.infer<typeof PokerTableRole>;

export const PokerReviewHand = z.object({ number: z.number().int().positive(), title: z.string(), text: z.string() });
export type PokerReviewHand = z.infer<typeof PokerReviewHand>;
export const PokerReview = z.object({ sessionId: PokerSessionId, hands: z.array(PokerReviewHand) });
export type PokerReview = z.infer<typeof PokerReview>;

export const PokerTableStatus = z.enum(["idle", "in_hand"]);
export type PokerTableStatus = z.infer<typeof PokerTableStatus>;

export const PokerTableSeat = z.object({
  seat: PokerSeatNo,
  kind: z.enum(["user", "bot"]),
  botId: BotId.nullable(),
  name: z.string(),
  persona: PokerPersona.nullable(),
  hue: BotHue,
  stack: z.number().int(),
});
export type PokerTableSeat = z.infer<typeof PokerTableSeat>;

/** 原型「战绩」那三个数：打了几局、几局你赢、筹码净变化。 */
export const PokerStats = z.object({
  sessions: z.number().int().nonnegative(),
  sessionsWon: z.number().int().nonnegative(),
  net: z.number().int(),
});
export type PokerStats = z.infer<typeof PokerStats>;

/** 用户视角的整张桌。每次写事件 version 加一，客户端只认更大的版本。 */
export const PokerTableView = z.object({
  groupId: GroupId,
  status: PokerTableStatus,
  version: z.number().int().nonnegative(),
  seats: z.array(PokerTableSeat),
  host: z.object({ botId: BotId, name: z.string(), hue: BotHue }),
  session: z
    .object({ id: PokerSessionId, handCount: z.number().int().nonnegative(), net: z.number().int() })
    .nullable(),
  hand: z
    .object({
      id: PokerHandId,
      number: z.number().int().positive(),
      version: z.number().int().nonnegative(),
      toAct: PokerSeatNo.nullable(),
      deadline: Timestamp.nullable(),
      view: PokerSeatView,
    })
    .nullable(),
  hint: z
    .object({
      seq: z.number().int().nonnegative(),
      status: z.enum(["waiting", "done", "failed"]),
      messageId: MessageId.nullable(),
    })
    .nullable(),
  lastReview: PokerReview.nullable(),
  stats: PokerStats,
});
export type PokerTableView = z.infer<typeof PokerTableView>;

// 牌桌的 HTTP 契约。
export const CreatePokerTableRequest = z.object({ requestId: z.string().min(1).max(64) }).strict();
export type CreatePokerTableRequest = z.infer<typeof CreatePokerTableRequest>;
export const StartHandRequest = z.object({}).strict();
export type StartHandRequest = z.infer<typeof StartHandRequest>;
export const PokerActRequest = z.object({ seq: z.number().int().nonnegative(), action: PokerAction }).strict();
export type PokerActRequest = z.infer<typeof PokerActRequest>;
export const HintRequest = z.object({ seq: z.number().int().nonnegative() }).strict();
export type HintRequest = z.infer<typeof HintRequest>;
export const SwapSeatRequest = z.object({ persona: PokerPersona.exclude(["laobai"]) }).strict();
export type SwapSeatRequest = z.infer<typeof SwapSeatRequest>;
export const LeaveTableRequest = z.object({}).strict();
export type LeaveTableRequest = z.infer<typeof LeaveTableRequest>;
export const PokerTableResponse = z.object({ table: PokerTableView });
export type PokerTableResponse = z.infer<typeof PokerTableResponse>;

/** 牌桌 prompt：不带群历史，只带这一手这个座位看得到的东西。 */
export const TablePrompt = z
  .object({
    role: PokerTableRole,
    handId: PokerHandId,
    seq: z.number().int().nonnegative(),
    view: PokerSeatView.nullable(),
    publicLog: z.array(z.string()),
    question: z.string().nullable(),
    review: z
      .array(
        z
          .object({
            number: z.number().int().positive(),
            title: z.string(),
            view: PokerSeatView,
            userDelta: z.number().int(),
          })
          .strict(),
      )
      .nullable(),
  })
  .strict();
export type TablePrompt = z.infer<typeof TablePrompt>;
