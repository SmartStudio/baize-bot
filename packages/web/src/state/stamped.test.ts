import { describe, expect, it } from "vitest";
import { createClock, writeTable } from "./stamped.js";

describe("号的边界", () => {
  it("号只增不减，每次取的号都比上一次大", () => {
    const next = createClock();
    const taken = [next(), next(), next()];
    expect(taken).toEqual([1, 2, 3]);
  });

  it("号和条目上记的号相同，说明是同一次写入，不能再盖一遍", () => {
    const next = createClock();
    const seq = next();
    const empty: Record<string, { id: string; text: string }> = {};
    const once = writeTable(empty, {}, seq, [{ id: "draft_1", text: "第一次" }]);
    const again = writeTable(once.rows, once.stamps, seq, [{ id: "draft_1", text: "同号的第二份" }]);
    expect(again.rows["draft_1"]?.text).toBe("第一次");
  });
});
