import { describe, expect, it } from "vitest";
import { LiveInput } from "@baize/shared";
import {
  createClickCounter,
  createMoveCoalescer,
  keyInput,
  pointerInput,
  primaryModifier,
  textInputs,
  wheelInput,
} from "./input.js";

// 画布在页面上摆在 (100, 50)，显示成 400x250。
const canvas = {
  getBoundingClientRect: () => ({ left: 100, top: 50, width: 400, height: 250 }),
} as unknown as HTMLCanvasElement;

const NO_KEYS = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

const mouse = (init: Partial<MouseEvent>) =>
  ({ clientX: 0, clientY: 0, button: 0, buttons: 0, detail: 0, ...NO_KEYS, ...init }) as unknown as MouseEvent;

const wheel = (init: Partial<WheelEvent>) =>
  ({ clientX: 300, clientY: 175, deltaX: 0, deltaY: 0, deltaMode: 0, ...NO_KEYS, ...init }) as unknown as WheelEvent;

const keyboard = (init: Partial<KeyboardEvent>) =>
  ({ key: "a", code: "KeyA", keyCode: 65, isComposing: false, ...NO_KEYS, ...init }) as unknown as KeyboardEvent;

describe("鼠标坐标按画布显示出来的框折成比例", () => {
  it("画布正中是 0.5、0.5，左上角是 0、0", () => {
    expect(pointerInput("down", mouse({ clientX: 300, clientY: 175 }), canvas, "remote", 1, "mac")).toEqual({
      kind: "mouse",
      phase: "down",
      x: 0.5,
      y: 0.5,
      button: "left",
      clicks: 1,
      modifiers: 0,
    });
    expect(pointerInput("move", mouse({ clientX: 100, clientY: 50 }), canvas, "remote", 0, "mac")).toMatchObject({
      x: 0,
      y: 0,
    });
  });

  it("拖出画布外的坐标夹在 0 到 1，协议收得下", () => {
    const input = pointerInput("move", mouse({ clientX: 900, clientY: -40, buttons: 1 }), canvas, "remote", 0, "mac");
    expect(input).toMatchObject({ x: 1, y: 0, button: "left", clicks: 0 });
    expect(LiveInput.safeParse(input).success).toBe(true);
  });

  it("move 按住的键从 buttons 位读，右键按下读 button", () => {
    expect(pointerInput("move", mouse({ buttons: 2 }), canvas, "local", 0, "mac")).toMatchObject({ button: "right" });
    expect(pointerInput("move", mouse({ buttons: 0 }), canvas, "local", 0, "mac")).toMatchObject({ button: "none" });
    expect(pointerInput("down", mouse({ button: 2 }), canvas, "local", 1, "mac")).toMatchObject({ button: "right" });
  });

  it("连点数夹在 1 到 3：pointer 事件的 detail 是 0 时也算一下", () => {
    expect(pointerInput("down", mouse({ detail: 0 }), canvas, "local", undefined, "mac").clicks).toBe(1);
    expect(pointerInput("up", mouse({}), canvas, "local", 7, "mac").clicks).toBe(3);
  });

  it("滚轮按行报的折成像素，过大的夹到协议上限", () => {
    expect(wheelInput(wheel({ deltaY: 3, deltaMode: 1 }), canvas, "remote", "mac")).toEqual({
      kind: "wheel",
      x: 0.5,
      y: 0.5,
      dx: 0,
      dy: 120,
      modifiers: 0,
    });
    expect(wheelInput(wheel({ deltaY: -20, deltaMode: 2 }), canvas, "remote", "mac")).toMatchObject({ dy: -5000 });
  });
});

describe("键盘", () => {
  it("输入法组字中回 null，留给 compositionend 整段发", () => {
    expect(keyInput("down", keyboard({ isComposing: true }), "remote", "mac")).toBeNull();
    expect(keyInput("down", keyboard({ key: "Process", keyCode: 229 }), "remote", "mac")).toBeNull();
  });

  it("远端是 Linux 时 Mac 上的 ⌘C 变成 Ctrl+C，本机 Mac 上还是 ⌘C", () => {
    const copy = keyboard({ key: "c", code: "KeyC", keyCode: 67, metaKey: true });
    expect(keyInput("down", copy, "remote", "mac")).toEqual({
      kind: "key",
      phase: "down",
      key: "c",
      code: "KeyC",
      keyCode: 67,
      text: null,
      modifiers: 2,
    });
    expect(keyInput("down", copy, "local", "mac")).toMatchObject({ modifiers: 4, text: null });
  });

  it("Windows 上的 Ctrl+C 到了本机 Mac 是 ⌘C，到了远程 Linux 还是 Ctrl+C", () => {
    const copy = keyboard({ key: "c", code: "KeyC", keyCode: 67, ctrlKey: true });
    expect(keyInput("down", copy, "local", "other")).toMatchObject({ modifiers: 4 });
    expect(keyInput("down", copy, "remote", "other")).toMatchObject({ modifiers: 2 });
  });

  it("主修饰键加 V 回 null：要贴的是用户这边的剪贴板，留给 paste 事件", () => {
    expect(keyInput("down", keyboard({ key: "v", code: "KeyV", metaKey: true }), "remote", "mac")).toBeNull();
    expect(keyInput("down", keyboard({ key: "v", code: "KeyV", ctrlKey: true }), "remote", "other")).toBeNull();
  });

  it("可打印的键带上屏的字，Shift 照传；回车上屏 \\r；功能键和抬起不带字", () => {
    expect(keyInput("down", keyboard({ key: "A", shiftKey: true }), "remote", "mac")).toMatchObject({
      text: "A",
      modifiers: 8,
    });
    expect(keyInput("down", keyboard({ key: "Enter", code: "Enter", keyCode: 13 }), "remote", "mac")).toMatchObject({
      text: "\r",
    });
    expect(
      keyInput("down", keyboard({ key: "Backspace", code: "Backspace", keyCode: 8 }), "remote", "mac"),
    ).toMatchObject({ text: null });
    expect(keyInput("up", keyboard({ key: "a" }), "remote", "mac")).toMatchObject({ phase: "up", text: null });
  });

  it("主修饰键映射：本机是 Meta，远程是 Ctrl", () => {
    expect(primaryModifier("local")).toBe(4);
    expect(primaryModifier("remote")).toBe(2);
  });
});

describe("整段上屏的字", () => {
  it("按协议上限 2000 切段，不切开代理对，空串不发", () => {
    const text = `${"字".repeat(1999)}😀尾`;
    const chunks = textInputs(text);
    expect(chunks.map((chunk) => (chunk.kind === "text" ? chunk.text : ""))).toEqual(["字".repeat(1999), "😀尾"]);
    for (const chunk of chunks) expect(LiveInput.safeParse(chunk).success).toBe(true);
    expect(textInputs("")).toEqual([]);
  });
});

describe("move 合并", () => {
  it("同一动画帧里的多条 move 只发最后一条", () => {
    const sent: LiveInput[] = [];
    const frames: (() => void)[] = [];
    const moves = createMoveCoalescer(
      (input) => sent.push(input),
      (run) => frames.push(run),
    );
    for (const x of [0.1, 0.2, 0.3])
      moves.move({ kind: "mouse", phase: "move", x, y: 0, button: "none", clicks: 0, modifiers: 0 });
    expect(frames).toHaveLength(1);
    frames[0]?.();
    expect(sent).toEqual([{ kind: "mouse", phase: "move", x: 0.3, y: 0, button: "none", clicks: 0, modifiers: 0 }]);
  });

  it("按下前 flush 把攒着的 move 先发，动画帧到了不再重发", () => {
    const sent: LiveInput[] = [];
    const frames: (() => void)[] = [];
    const moves = createMoveCoalescer(
      (input) => sent.push(input),
      (run) => frames.push(run),
    );
    moves.move({ kind: "mouse", phase: "move", x: 0.4, y: 0.4, button: "none", clicks: 0, modifiers: 0 });
    moves.flush();
    sent.push({ kind: "mouse", phase: "down", x: 0.4, y: 0.4, button: "left", clicks: 1, modifiers: 0 });
    frames[0]?.();
    expect(sent.map((input) => (input.kind === "mouse" ? input.phase : input.kind))).toEqual(["move", "down"]);
  });
});

describe("连点计数", () => {
  it("同一个键、够快够近算第二下第三下，第四下从头数；隔久了、挪远了都从 1 起", () => {
    let now = 0;
    const count = createClickCounter(() => now);
    const at = (x: number) => ({ button: 0, clientX: x, clientY: 0 });
    expect([
      count(at(0)),
      ((now += 100), count(at(1))),
      ((now += 100), count(at(2))),
      ((now += 100), count(at(2))),
    ]).toEqual([1, 2, 3, 1]);
    now += 1000;
    expect(count(at(2))).toBe(1);
    now += 100;
    expect(count(at(40))).toBe(1);
  });
});
