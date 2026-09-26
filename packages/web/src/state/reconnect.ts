const FIRST_MS = 1_000;
const MAX_MS = 30_000;

// 推送连着失败 failures 次之后等多久再连：1 秒起，每失败一次翻倍，封顶 30 秒。
export const reconnectDelay = (failures: number): number => Math.min(FIRST_MS * 2 ** failures, MAX_MS);
