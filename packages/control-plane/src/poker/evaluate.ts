import { rankValue, suitOf, type Card } from "./cards.js";

export const HAND_CATEGORIES = [
  "high_card",
  "pair",
  "two_pair",
  "three_of_a_kind",
  "straight",
  "flush",
  "full_house",
  "four_of_a_kind",
  "straight_flush",
] as const;
export type HandCategory = (typeof HAND_CATEGORIES)[number];

export interface HandValue {
  readonly category: HandCategory;
  /** 先比这一串再比下一串：牌型序号，然后按牌型的比较顺序排好的点数，踢脚在最后。 */
  readonly score: readonly number[];
  readonly cards: readonly Card[];
}

/** 底牌加公共牌里挑最好的五张，至少要凑够五张。 */
export function evaluate(hole: readonly Card[], board: readonly Card[]): HandValue {
  const cards = [...hole, ...board];
  if (cards.length < 5) throw new Error("凑不够五张牌，没法比牌");
  let best: HandValue | null = null;
  for (const five of combinations(cards, 5)) {
    const value = evaluateFive(five);
    if (best === null || compareHands(value, best) > 0) best = value;
  }
  return best as HandValue;
}

/** 正数表示 a 大，负数表示 b 大，0 是一样大。 */
export function compareHands(a: HandValue, b: HandValue): number {
  for (let i = 0; i < Math.max(a.score.length, b.score.length); i++) {
    const diff = (a.score[i] ?? 0) - (b.score[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function evaluateFive(cards: readonly Card[]): HandValue {
  const counts = new Map<number, number>();
  for (const card of cards) counts.set(rankValue(card), (counts.get(rankValue(card)) ?? 0) + 1);
  // 同点数多的在前，一样多的点数大的在前：葫芦先比三条再比对子，两对先比大对再比小对再比踢脚。
  const groups = [...counts.entries()].toSorted(([va, ca], [vb, cb]) => cb - ca || vb - va);
  const shape = groups.map(([, count]) => count).join("");
  const ordered = groups.map(([value]) => value);

  const flush = cards.every((card) => suitOf(card) === suitOf(cards[0] as Card));
  const straightHigh = straightHighOf(ordered);

  const category = categoryOf(shape, flush, straightHigh !== null);
  const tiebreak = straightHigh !== null ? [straightHigh] : ordered;
  return { category, score: [HAND_CATEGORIES.indexOf(category), ...tiebreak], cards };
}

function categoryOf(shape: string, flush: boolean, straight: boolean): HandCategory {
  if (straight && flush) return "straight_flush";
  if (shape === "41") return "four_of_a_kind";
  if (shape === "32") return "full_house";
  if (flush) return "flush";
  if (straight) return "straight";
  if (shape === "311") return "three_of_a_kind";
  if (shape === "221") return "two_pair";
  if (shape === "2111") return "pair";
  return "high_card";
}

/** 五个不同点数连成顺子时返回顶张；A 2 3 4 5 的顶张算 5。 */
function straightHighOf(distinctDesc: readonly number[]): number | null {
  if (distinctDesc.length !== 5) return null;
  const [high, , , , low] = distinctDesc as [number, number, number, number, number];
  if (high - low === 4) return high;
  if (high === 14 && distinctDesc[1] === 5 && low === 2) return 5;
  return null;
}

function* combinations<T>(items: readonly T[], size: number, start = 0, picked: T[] = []): Generator<T[]> {
  if (picked.length === size) {
    yield [...picked];
    return;
  }
  for (let i = start; i <= items.length - (size - picked.length); i++) {
    picked.push(items[i] as T);
    yield* combinations(items, size, i + 1, picked);
    picked.pop();
  }
}

const RANK_NAMES: Record<number, string> = { 10: "10", 11: "J", 12: "Q", 13: "K", 14: "A" };

export function rankName(value: number): string {
  return RANK_NAMES[value] ?? String(value);
}

/** 给模型和人看的一句牌力，例如「两对，K 和 7」。 */
export function describeHand(value: HandValue): string {
  const [, a = 0, b = 0] = value.score;
  switch (value.category) {
    case "straight_flush":
      return a === 14 ? "皇家同花顺" : `同花顺，${rankName(a)} 高`;
    case "four_of_a_kind":
      return `四条 ${rankName(a)}`;
    case "full_house":
      return `葫芦，${rankName(a)} 带 ${rankName(b)}`;
    case "flush":
      return `同花，${rankName(a)} 高`;
    case "straight":
      return `顺子，${rankName(a)} 高`;
    case "three_of_a_kind":
      return `三条 ${rankName(a)}`;
    case "two_pair":
      return `两对，${rankName(a)} 和 ${rankName(b)}`;
    case "pair":
      return `一对 ${rankName(a)}`;
    case "high_card":
      return `高牌 ${rankName(a)}`;
  }
}
