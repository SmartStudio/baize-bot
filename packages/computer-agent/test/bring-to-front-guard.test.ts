import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 只有人的动作能把一页摆到前台：屏在有人打开画面时才 bringToFront，别处调了就是 Bot 自己在抢用户的窗口。
const ROOTS = [
  fileURLToPath(new URL("../src/", import.meta.url)),
  fileURLToPath(new URL("../../bot-runner/src/", import.meta.url)),
];
const ALLOWED = new Set(["computer-agent/src/live-screen.ts"]);
const PACKAGES = fileURLToPath(new URL("../../", import.meta.url));

function sources(root: string): string[] {
  return readdirSync(root, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => join(root, file));
}

describe("bringToFront 守卫", () => {
  it("电脑代理和运行器的源码里，bringToFront 只出现在屏里", () => {
    const files = ROOTS.flatMap(sources);
    expect(files.length, "前提：扫到了源码").toBeGreaterThan(10);
    const offenders = files
      .filter((file) => readFileSync(file, "utf8").includes("bringToFront"))
      .map((file) => relative(PACKAGES, file))
      .filter((file) => !ALLOWED.has(file));
    expect(offenders, "Page.bringToFront 只许 live-screen.ts 调").toEqual([]);
    expect(
      files.some((file) => relative(PACKAGES, file) === "computer-agent/src/live-screen.ts"),
      "白名单里的文件还在",
    ).toBe(true);
  });
});
