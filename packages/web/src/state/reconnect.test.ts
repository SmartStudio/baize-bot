import { describe, expect, it } from "vitest";
import { reconnectDelay } from "./reconnect.js";

describe("推送重连退避", () => {
  it("1 秒起，每连着失败一次翻倍，封顶 30 秒", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(reconnectDelay)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });
});
