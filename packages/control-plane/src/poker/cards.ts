export const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"] as const;
export type Rank = (typeof RANKS)[number];

export const SUITS = ["s", "h", "d", "c"] as const;
export type Suit = (typeof SUITS)[number];

/** 两个字符，点数在前花色在后，例如 "As"、"Td"。 */
export type Card = `${Rank}${Suit}`;

/** 2 到 14，A 是 14。 */
export function rankValue(card: Card): number {
  return RANKS.indexOf(card.charAt(0) as Rank) + 2;
}

export function suitOf(card: Card): Suit {
  return card.charAt(1) as Suit;
}

/** 返回 [0, 1) 的确定性伪随机数，同一个种子序列完全相同。 */
export type Rng = () => number;

export function seededRng(seed: string): Rng {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let state = h >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffledDeck(seed: string): Card[] {
  const deck: Card[] = SUITS.flatMap((suit) => RANKS.map((rank): Card => `${rank}${suit}`));
  const rng = seededRng(seed);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j] as Card, deck[i] as Card];
  }
  return deck;
}
