import { describe, expect, it } from "vitest";
import { shortcutOf } from "./shortcuts.js";

const press = (key: string, code: string, extra: Partial<KeyboardEvent> = {}) => ({
  key,
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  keyCode: 0,
  defaultPrevented: false,
  ...extra,
});

describe("shortcutOf", () => {
  it("Mac 上认 ⌘K、⌘/，别的系统认 Ctrl+K、Ctrl+/", () => {
    expect(shortcutOf(press("k", "KeyK", { metaKey: true }), "mac")).toBe("switch");
    expect(shortcutOf(press("/", "Slash", { metaKey: true }), "mac")).toBe("shortcuts");
    expect(shortcutOf(press("k", "KeyK", { ctrlKey: true }), "other")).toBe("switch");
    expect(shortcutOf(press("/", "Slash", { ctrlKey: true }), "other")).toBe("shortcuts");
    expect(shortcutOf(press("k", "KeyK", { ctrlKey: true }), "mac"), "Mac 上的 Ctrl+K 是行内删到行尾").toBeNull();
    expect(shortcutOf(press("k", "KeyK", { metaKey: true }), "other")).toBeNull();
  });

  it("单键、组字中、多按了 Alt 都不算", () => {
    expect(shortcutOf(press("k", "KeyK"), "mac")).toBeNull();
    expect(shortcutOf(press("/", "Slash"), "mac")).toBeNull();
    expect(shortcutOf(press("k", "KeyK", { metaKey: true, isComposing: true }), "mac")).toBeNull();
    expect(shortcutOf(press("Process", "KeyK", { metaKey: true, keyCode: 229 }), "mac")).toBeNull();
    expect(shortcutOf(press("k", "KeyK", { metaKey: true, altKey: true }), "mac")).toBeNull();
    expect(
      shortcutOf(press("k", "KeyK", { metaKey: true, defaultPrevented: true }), "mac"),
      "别处已经收下的键",
    ).toBeNull();
  });

  it("认的是打出来的 k，非拉丁布局才退回物理键位", () => {
    expect(shortcutOf(press("t", "KeyK", { metaKey: true }), "mac"), "Dvorak 上 K 键位打的是 t").toBeNull();
    expect(shortcutOf(press("k", "KeyV", { metaKey: true }), "mac")).toBe("switch");
    expect(shortcutOf(press("л", "KeyK", { metaKey: true }), "mac"), "俄文布局").toBe("switch");
  });

  it("「/」也认打出来的字，⌘- 缩小页面、⌘. 不被当成 ⌘/", () => {
    expect(shortcutOf(press("-", "Slash", { metaKey: true }), "mac"), "德语布局").toBeNull();
    expect(shortcutOf(press(".", "Slash", { metaKey: true }), "mac"), "俄文布局打的是句点").toBeNull();
    expect(shortcutOf(press("Dead", "Slash", { metaKey: true }), "mac"), "打不出可见字时才认键位").toBe("shortcuts");
  });

  it("要按 Shift 才打得出「/」的布局照样认得 ⌘/", () => {
    expect(shortcutOf(press("/", "Digit7", { metaKey: true, shiftKey: true }), "mac")).toBe("shortcuts");
  });
});
