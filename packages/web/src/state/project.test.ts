import { describe, expect, it } from "vitest";
import { goalProgressOf } from "./project.js";

describe("项目目标进度", () => {
  const goal = { target: 1000, unit: "星", dueAt: null, metric: null };
  // 上海周日 23:00 的样本，服务端那时算出本周 +37。
  const metric = { current: 412, weekDelta: 37, sampledAt: "2026-10-11T15:00:00.000Z" };

  it("同一周里照服务端给的本周变化", () => {
    expect(goalProgressOf(goal, metric, new Date("2026-10-11T15:59:00Z"))).toEqual({
      current: 412,
      target: 1000,
      unit: "星",
      weekDelta: 37,
    });
  });

  it("跨过上海周一 00:00 还没有新样本，本周变化是 0，当前值不变", () => {
    expect(goalProgressOf(goal, metric, new Date("2026-10-11T16:01:00Z"))).toEqual({
      current: 412,
      target: 1000,
      unit: "星",
      weekDelta: 0,
    });
  });

  it("没有样本当前值算 0，没有本周变化", () => {
    expect(goalProgressOf(goal, null, new Date("2026-10-11T16:01:00Z"))).toEqual({
      current: 0,
      target: 1000,
      unit: "星",
      weekDelta: null,
    });
  });
});
