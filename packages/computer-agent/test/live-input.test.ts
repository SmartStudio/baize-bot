import { describe, expect, it } from "vitest";
import { toCdpInput } from "../src/live-input.js";

const viewport = { width: 1000, height: 600 };

describe("画面接管的输入换算", () => {
  it("鼠标按下、拖动、松开：比例乘视口取整，buttons 按下时含这个键、松开时不含；按着键时 force 是 0.5，松开和空手移动不带", () => {
    expect(
      toCdpInput({ kind: "mouse", phase: "down", x: 0.5, y: 0.25, button: "left", clicks: 1, modifiers: 0 }, viewport),
    ).toEqual([
      {
        method: "Input.dispatchMouseEvent",
        params: {
          type: "mousePressed",
          x: 500,
          y: 150,
          button: "left",
          buttons: 1,
          clickCount: 1,
          modifiers: 0,
          force: 0.5,
        },
      },
    ]);
    expect(
      toCdpInput(
        { kind: "mouse", phase: "move", x: 0.3333, y: 0.5, button: "left", clicks: 0, modifiers: 8 },
        viewport,
      ),
    ).toEqual([
      {
        method: "Input.dispatchMouseEvent",
        params: {
          type: "mouseMoved",
          x: 333,
          y: 300,
          button: "left",
          buttons: 1,
          clickCount: 0,
          modifiers: 8,
          force: 0.5,
        },
      },
    ]);
    expect(
      toCdpInput({ kind: "mouse", phase: "up", x: 1, y: 1, button: "right", clicks: 1, modifiers: 0 }, viewport),
    ).toEqual([
      {
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseReleased", x: 1000, y: 600, button: "right", buttons: 0, clickCount: 1, modifiers: 0 },
      },
    ]);
    const idle = toCdpInput(
      { kind: "mouse", phase: "move", x: 0, y: 0, button: "none", clicks: 0, modifiers: 0 },
      viewport,
    )[0]?.params;
    expect(idle?.buttons, "没按键时 buttons 是 0").toBe(0);
    expect(idle, "空手移动没有压力").not.toHaveProperty("force");
  });

  it("滚轮变成 mouseWheel，带落点和 deltaX、deltaY", () => {
    expect(toCdpInput({ kind: "wheel", x: 0.1, y: 0.9, dx: -3, dy: 120, modifiers: 2 }, viewport)).toEqual([
      {
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseWheel", x: 100, y: 540, deltaX: -3, deltaY: 120, modifiers: 2 },
      },
    ]);
  });

  it("带字的按下发 keyDown 带 text 和 unmodifiedText；功能键发 rawKeyDown；松开发 keyUp 不带 text", () => {
    expect(
      toCdpInput(
        { kind: "key", phase: "down", key: "a", code: "KeyA", keyCode: 65, text: "a", modifiers: 0 },
        viewport,
      ),
    ).toEqual([
      {
        method: "Input.dispatchKeyEvent",
        params: {
          type: "keyDown",
          key: "a",
          code: "KeyA",
          windowsVirtualKeyCode: 65,
          nativeVirtualKeyCode: 65,
          modifiers: 0,
          text: "a",
          unmodifiedText: "a",
        },
      },
    ]);
    expect(
      toCdpInput(
        { kind: "key", phase: "down", key: "Enter", code: "Enter", keyCode: 13, text: null, modifiers: 0 },
        viewport,
      ),
    ).toEqual([
      {
        method: "Input.dispatchKeyEvent",
        params: {
          type: "rawKeyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          modifiers: 0,
        },
      },
    ]);
    expect(
      toCdpInput({ kind: "key", phase: "up", key: "a", code: "KeyA", keyCode: 65, text: "a", modifiers: 4 }, viewport),
    ).toEqual([
      {
        method: "Input.dispatchKeyEvent",
        params: {
          type: "keyUp",
          key: "a",
          code: "KeyA",
          windowsVirtualKeyCode: 65,
          nativeVirtualKeyCode: 65,
          modifiers: 4,
        },
      },
    ]);
  });

  it("整段文字变成 Input.insertText", () => {
    expect(toCdpInput({ kind: "text", text: "白泽" }, viewport)).toEqual([
      { method: "Input.insertText", params: { text: "白泽" } },
    ]);
  });
});
