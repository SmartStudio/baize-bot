import { describe, expect, it } from "vitest";
import { untakenBotName } from "../src/naming.js";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("untakenBotName", () => {
  it("原名空着就用原名，撞了接序号", () => {
    expect(untakenBotName("小内", new Set(["小社"]))).toBe("小内");
    expect(untakenBotName("小内", new Set(["小内"]))).toBe("小内2");
    expect(untakenBotName("小内", new Set(["小内", "小内2", "小内3"]))).toBe("小内4");
  });

  it.each([
    ["18 个字加两位数字", "一二三四五六七八九十一二三四五六七八11"],
    ["二十个 1", "1".repeat(20)],
    ["19 个字加一位数字", `${"a".repeat(19)}1`],
    ["emoji 加数字，截尾巴要落在代理对中间", `${"😀".repeat(9)}11`],
    ["十个 emoji", "😀".repeat(10)],
  ])("%s：连挑 300 次，每次都是没用过的名字，不超 20 码元，不留半个代理对", (_, base) => {
    const taken = new Set<string>();
    for (let round = 0; round < 300; round += 1) {
      const name = untakenBotName(base, taken);
      expect(taken.has(name), `第 ${round + 1} 次挑到已被占的 ${name}`).toBe(false);
      expect(name.length, `${name} 超过 20 码元`).toBeLessThanOrEqual(20);
      expect(LONE_SURROGATE.test(name), `${name} 劈开了代理对`).toBe(false);
      taken.add(name);
    }
  });
});
