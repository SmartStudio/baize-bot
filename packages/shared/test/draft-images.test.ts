import { describe, expect, it } from "vitest";
import { draftImageRules, draftImagesRefusal } from "../src/index.js";

const MB = 1000 * 1000;
const png = (size = 100) => ({ mime: "image/png", size }) as const;
const gif = { mime: "image/gif", size: 100 } as const;

describe("草稿配图规则", () => {
  it("库里允许的四种（平台，连接方式）都有一格，没有的组合直接抛", () => {
    expect(draftImageRules("github", "api").maxImages).toBe(0);
    expect(draftImageRules("x", "api").maxImages).toBe(4);
    expect(draftImageRules("x", "computer").maxImages).toBe(4);
    expect(draftImageRules("xiaohongshu", "computer").maxImages).toBe(9);
    expect(() => draftImageRules("xiaohongshu", "api")).toThrow("xiaohongshu 没有 api 的配图规则");
  });

  it("接口授权的 X：4 张、正好 5 MB、单张 GIF 都收，多一张、多一个字节、GIF 混图都拒", () => {
    const rules = draftImageRules("x", "api");
    expect(draftImagesRefusal(rules, [png(), png(), png(), png(5 * MB)])).toBeNull();
    expect(draftImagesRefusal(rules, [gif])).toBeNull();
    expect(
      draftImagesRefusal(
        rules,
        Array.from({ length: 5 }, () => png()),
      ),
    ).toBe("一条最多带 4 张图");
    expect(draftImagesRefusal(rules, [png(), png(5 * MB + 1)])).toBe("第 2 张图超过 5 MB");
    expect(draftImagesRefusal(rules, [png(), gif])).toBe("GIF 只能单独发一张，不能和别的图放在一条里");
  });

  it("电脑上的 X 不卡单张大小和 GIF 混图，GitHub 接口号一张都不收", () => {
    expect(draftImagesRefusal(draftImageRules("x", "computer"), [png(20 * MB), gif])).toBeNull();
    expect(draftImagesRefusal(draftImageRules("github", "api"), [png()])).toBe("不能带图");
  });
});
