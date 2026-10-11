export const KEY_HAND_LIMIT = 3;

export interface HandDelta {
  readonly number: number;
  /** 用户这一手的筹码变化，赢为正输为负。 */
  readonly delta: number;
}

/**
 * 复盘要看的关键手：按用户筹码变化的绝对值从大到小挑最多 limit 手，变化一样大的先打的先入选，
 * 挑出来按手序排。有几手挑几手。
 */
export function pickKeyHands<T extends HandDelta>(hands: readonly T[], limit: number = KEY_HAND_LIMIT): T[] {
  return hands
    .toSorted((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.number - b.number)
    .slice(0, limit)
    .toSorted((a, b) => a.number - b.number);
}
