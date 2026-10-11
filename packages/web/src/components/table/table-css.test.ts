import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const here = import.meta.dirname;
const stylesDir = join(here, "../../styles");

const classesOf = (css: string): Set<string> =>
  new Set([...css.matchAll(/\.([a-z][a-z0-9-]*)/gi)].map((m) => m[1] ?? ""));

// 复用已有按钮类，只在 .action-row 下加尺寸，不是新定义
const REUSED = new Set(["ghost-button"]);

describe("牌桌样式不撞全局类名", () => {
  // 牌桌的 css 由组件自己 import，进的是全局样式表；撞了类名会改掉首页、项目页已有元素的尺寸
  it("felt.css 和 action-bar.css 里的类名，别处的样式表都没有", () => {
    const others = new Set<string>();
    for (const file of readdirSync(stylesDir).filter((name) => name.endsWith(".css"))) {
      for (const name of classesOf(readFileSync(join(stylesDir, file), "utf8"))) others.add(name);
    }
    const mine = [
      ...classesOf(readFileSync(join(here, "felt.css"), "utf8")),
      ...classesOf(readFileSync(join(here, "action-bar.css"), "utf8")),
    ];
    expect(mine.filter((name) => others.has(name) && !REUSED.has(name))).toEqual([]);
  });
});
