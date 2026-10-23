const FIRST_MS = 1_000;
const MAX_MS = 30_000;

// 推送连着失败 failures 次之后等多久再连：1 秒起，每失败一次翻倍，封顶 30 秒。
export const reconnectDelay = (failures: number): number => Math.min(FIRST_MS * 2 ** failures, MAX_MS);

// 断线后至少要等过第一次重连，还没连回来才值得提示。
export const PUSH_GRACE_MS = 2 * reconnectDelay(0);
